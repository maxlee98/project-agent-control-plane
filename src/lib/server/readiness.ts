import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PRIORITY_LABELS, READINESS_CONTRACT_VERSION, TASK_PRIORITIES, type Project, type ProjectStatusConcept, type ReadinessCategory, type ReadinessCheck, type ReadinessReport } from "../domain";
import { inspectProjectCapabilities } from "./github";
import { redactSecrets } from "./redaction";

const execFile = promisify(execFileCallback);
const CATEGORY_NAMES: ReadinessCategory[] = ["checkout", "policy", "validation", "github", "runtime", "handoff"];
const STATUS_CONCEPTS: ProjectStatusConcept[] = ["ready", "in_progress", "review", "blocked", "done"];
type StatusFieldIssue = "missing_status_field" | "ambiguous_status_fields";

function expandHome(value: string) {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function configured(value: string | undefined) {
  return Boolean(value?.trim());
}

type GitResult = { stdout: string };

async function git(repositoryPath: string, args: string[]): Promise<GitResult> {
  return execFile("git", ["-C", repositoryPath, ...args], { timeout: 10_000, maxBuffer: 256 * 1024 });
}

function safeText(value: string, maxLength = 160) {
  return (redactSecrets(value.trim().replace(/[\u0000\r\n]+/g, " ")) ?? "").slice(0, maxLength);
}

function check(id: string, category: ReadinessCategory, status: ReadinessCheck["status"], summary: string, remediation: string, liveRequired: boolean): ReadinessCheck {
  return { id, category, status, summary, remediation, liveRequired };
}

function missingCheck(id: string, category: ReadinessCategory, summary: string, remediation: string, liveRequired = true) {
  return check(id, category, "blocker", summary, remediation, liveRequired);
}

function initialCategories() {
  return Object.fromEntries(CATEGORY_NAMES.map((category) => [category, { pass: 0, warning: 0, blocker: 0, unknown: 0 }])) as ReadinessReport["categories"];
}

function addCategoryCounts(checks: ReadinessCheck[]) {
  const categories = initialCategories();
  for (const item of checks) categories[item.category][item.status] += 1;
  return categories;
}

export async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryHasEntries(directoryPath: string) {
  try {
    return (await fs.readdir(directoryPath, { withFileTypes: true })).some((entry) => entry.isDirectory() || entry.isFile());
  } catch {
    return false;
  }
}

export function remoteRepository(value: string) {
  const cleaned = value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const match = cleaned.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/i);
  return match?.[1] ?? null;
}

export async function detectSupportedChecks(repositoryPath: string) {
  let count = 0;
  if (await pathExists(path.join(repositoryPath, "package.json"))) {
    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(repositoryPath, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
      if (packageJson.scripts?.typecheck) count += 1;
      if (packageJson.scripts?.test) count += 1;
      if (packageJson.scripts?.build) count += 1;
    } catch { /* Malformed metadata is reported as no supported command. */ }
  }
  if (await pathExists(path.join(repositoryPath, "pytest.ini")) || await pathExists(path.join(repositoryPath, "pyproject.toml"))) count += 1;
  return count;
}

async function inspectCheckout(project: Project, checks: ReadinessCheck[]) {
  const configuredPath = path.resolve(expandHome(project.localPath));
  let repositoryPath = configuredPath;
  try {
    const stat = await fs.stat(configuredPath);
    if (!stat.isDirectory()) {
      checks.push(missingCheck("checkout.path", "checkout", "The configured checkout path is not a directory.", "Choose an existing local Git checkout before running Live.", true));
      return null;
    }
    repositoryPath = await fs.realpath(configuredPath);
    checks.push(check("checkout.path", "checkout", "pass", "The configured checkout is readable.", "No action needed.", false));
  } catch {
    checks.push(missingCheck("checkout.path", "checkout", "The configured checkout path is unavailable.", "Create or select a local checkout; readiness never creates it for you.", true));
    return null;
  }

  try {
    const root = path.resolve((await git(repositoryPath, ["rev-parse", "--show-toplevel"])).stdout.trim());
    if (root !== repositoryPath) {
      checks.push(missingCheck("checkout.git_root", "checkout", "The configured path is inside a Git repository, not its root.", "Configure the repository root so isolated worktrees use the intended checkout.", true));
      return null;
    }
    checks.push(check("checkout.git_root", "checkout", "pass", "The checkout is a valid Git repository root.", "No action needed.", true));
  } catch {
    checks.push(missingCheck("checkout.git_root", "checkout", "The configured path is not a usable Git repository.", "Initialize or select a valid Git checkout before running Live.", true));
    return null;
  }

  try {
    const remote = safeText((await git(repositoryPath, ["remote", "get-url", "origin"])).stdout, 300);
    const identity = remoteRepository(remote);
    if (!identity || identity.toLowerCase() !== project.fullName.toLowerCase()) {
      checks.push(missingCheck("checkout.remote", "checkout", "The origin remote does not match the configured GitHub repository.", "Set origin to the configured owner/repository; the remote URL is not returned in readiness results.", true));
    } else {
      checks.push(check("checkout.remote", "checkout", "pass", "The origin remote matches the configured repository.", "No action needed.", true));
    }
  } catch {
    checks.push(missingCheck("checkout.remote", "checkout", "The checkout has no readable origin remote.", "Add an origin remote for the configured GitHub repository before Live.", true));
  }

  try {
    const configuredBranch = project.defaultBranch.trim() || "main";
    await git(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${configuredBranch}`]);
    checks.push(check("checkout.default_branch", "checkout", "pass", `The configured default branch '${safeText(configuredBranch, 80)}' is available from origin.`, "No action needed.", true));
  } catch {
    checks.push(missingCheck("checkout.default_branch", "checkout", "The configured default branch is not available from origin.", "Fetch the default branch or correct the repository's default branch setting before Live.", true));
  }

  try {
    await git(repositoryPath, ["worktree", "list", "--porcelain"]);
    const workspaceRoot = path.resolve(expandHome(process.env.WORKSPACE_ROOT ?? path.join(os.homedir(), ".project-agent-control-plane", "workspaces")));
    const parent = await fs.stat(workspaceRoot).catch(() => fs.stat(path.dirname(workspaceRoot)));
    if (!parent.isDirectory()) throw new Error("workspace parent is unavailable");
    checks.push(check("checkout.worktrees", "checkout", "pass", "Git worktree support and the workspace location are available.", "No action needed.", true));
  } catch {
    checks.push(missingCheck("checkout.worktrees", "checkout", "Isolated Git worktree capability could not be verified.", "Ensure Git worktree support is available and the configured workspace location is accessible.", true));
  }
  return repositoryPath;
}

function statusCheckForMappings(mappings: ReadinessReport["projectStatus"]["mappings"], configured: boolean, reachable: boolean | null, checks: ReadinessCheck[]) {
  if (!configured) {
    checks.push(missingCheck("github.project", "github", "No GitHub Projects V2 ID is configured.", "Add the target Projects V2 node ID before Live synchronization.", true));
    return;
  }
  if (reachable !== true) {
    checks.push(check("github.project", "github", "unknown", "The GitHub Project could not be inspected without exposing provider details.", "Configure GitHub access and retry readiness.", true));
    return;
  }
  checks.push(check("github.project", "github", "pass", "The configured GitHub Project is reachable.", "No action needed.", true));
  if (mappings.length === 0) {
    checks.push(missingCheck("github.status_field", "github", "The GitHub Project Status field could not be mapped.", "Ensure the project exposes one single-select field named Status, then run readiness again.", true));
    return;
  }
  for (const mapping of mappings) {
    const label = mapping.concept === "in_progress" ? "In progress" : mapping.concept[0].toUpperCase() + mapping.concept.slice(1);
    checks.push(mapping.state === "mapped"
      ? check(`github.status.${mapping.concept}`, "github", "pass", `${label} has one canonical Project Status option.`, "No action needed.", true)
      : missingCheck(`github.status.${mapping.concept}`, "github", `${label} does not have one unambiguous canonical Project Status option.`, "Rename or add exactly one matching Status option, then run readiness again.", true));
  }
}

function statusFieldCheck(projectStatus: ReadinessReport["projectStatus"], checks: ReadinessCheck[]) {
  if (projectStatus.statusFieldIssue === "missing_status_field") {
    checks.push(missingCheck("github.status_field", "github", "The GitHub Project has no Status field.", "Add one single-select field named Status, then run readiness again.", true));
  } else if (projectStatus.statusFieldIssue === "ambiguous_status_fields") {
    checks.push(missingCheck("github.status_field", "github", "The GitHub Project has ambiguous Status fields.", "Keep exactly one single-select field named Status, then run readiness again.", true));
  }
}

function priorityCheckForMappings(projectPriority: ReadinessReport["projectPriority"], checks: ReadinessCheck[]) {
  if (!projectPriority.configured) {
    checks.push(missingCheck("github.priority_field", "github", "No GitHub Projects V2 Priority field can be inspected because no project is configured.", "Add the target Projects V2 node ID, then run readiness again.", true));
    return;
  }
  if (projectPriority.reachable !== true) {
    checks.push(check("github.priority_field", "github", "unknown", "The GitHub Projects V2 Priority field could not be inspected without exposing provider details.", "Configure GitHub access and retry readiness.", true));
    return;
  }
  if (projectPriority.priorityFieldIssue === "missing_priority_field") {
    checks.push(missingCheck("github.priority_field", "github", "The GitHub Project has no Priority field.", "Add one single-select field named Priority with exactly P0, P1, P2, and P3 options, then run readiness again.", true));
    return;
  }
  if (projectPriority.priorityFieldIssue === "ambiguous_priority_fields") {
    checks.push(missingCheck("github.priority_field", "github", "The GitHub Project has ambiguous Priority fields.", "Keep exactly one single-select field named Priority with exactly P0, P1, P2, and P3 options, then run readiness again.", true));
    return;
  }
  if (projectPriority.priorityFieldIssue === "invalid_priority_options") {
    checks.push(missingCheck("github.priority_field", "github", "The GitHub Project Priority field does not have the exact canonical P0–P3 options.", "Configure one single-select Priority field with exactly P0, P1, P2, and P3 options, then run readiness again.", true));
    return;
  }
  checks.push(check("github.priority_field", "github", "pass", "The GitHub Project has the canonical P0–P3 Priority field.", "No action needed.", true));
  for (const mapping of projectPriority.mappings) {
    checks.push(mapping.state === "mapped"
      ? check(`github.priority.${mapping.label}`, "github", "pass", `Priority ${mapping.label} has one canonical Project option.`, "No action needed.", true)
      : missingCheck(`github.priority.${mapping.label}`, "github", `Priority ${mapping.label} does not have one unambiguous canonical Project option.`, "Keep exactly one matching option for each of P0, P1, P2, and P3, then run readiness again.", true));
  }
}

function emptyPriorityMappings(state: "unavailable" | "missing" = "unavailable"): ReadinessReport["projectPriority"]["mappings"] {
  return TASK_PRIORITIES.map((priority) => ({ priority, label: PRIORITY_LABELS[priority - 1]!, optionId: null, optionName: null, state, candidates: [] }));
}

function priorityFieldIssue(error: unknown): ReadinessReport["projectPriority"]["priorityFieldIssue"] {
  const message = error instanceof Error ? error.message : "";
  if (message === "GitHub Project has no Priority field.") return "missing_priority_field";
  if (message === "GitHub Project has ambiguous Priority fields.") return "ambiguous_priority_fields";
  if (message === "GitHub Project Priority field has invalid options.") return "invalid_priority_options";
  return null;
}

function statusFieldIssue(error: unknown): StatusFieldIssue | null {
  const message = error instanceof Error ? error.message : "";
  if (message === "GitHub Project has no Status field.") return "missing_status_field";
  if (message === "GitHub Project has ambiguous Status fields.") return "ambiguous_status_fields";
  return null;
}

export async function assessProjectReadiness(project: Project): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const repositoryPath = await inspectCheckout(project, checks);
  const workflowPath = repositoryPath ? path.join(repositoryPath, "WORKFLOW.md") : "";
  const localWorkflow = Boolean(repositoryPath && await pathExists(workflowPath));
  const defaultWorkflow = path.resolve(process.cwd(), "workflows/default/WORKFLOW.md");
  const defaultWorkflowAvailable = await pathExists(defaultWorkflow);
  const workflow = localWorkflow ? "local" : defaultWorkflowAvailable ? "default" : "missing";
  checks.push(localWorkflow
    ? check("policy.workflow", "policy", "pass", "The repository has a local WORKFLOW.md; it is the effective policy.", "No action needed.", true)
    : defaultWorkflowAvailable
      ? check("policy.workflow", "policy", "warning", "No local WORKFLOW.md was found; the versioned control-plane default is effective.", "Approve the proposed baseline pull request if this repository should own a customized WORKFLOW.md.", false)
      : missingCheck("policy.workflow", "policy", "No effective WORKFLOW.md is available.", "Restore the control-plane default or create a repository WORKFLOW.md through the baseline pull-request action.", true));

  const agents = Boolean(repositoryPath && await pathExists(path.join(repositoryPath, "AGENTS.md")));
  const skills = Boolean(repositoryPath && await directoryHasEntries(path.join(repositoryPath, ".agents", "skills")));
  const pullRequestTemplate = Boolean(repositoryPath && (await pathExists(path.join(repositoryPath, ".github", "pull_request_template.md")) || await pathExists(path.join(repositoryPath, ".github", "PULL_REQUEST_TEMPLATE.md"))));
  checks.push(agents
    ? check("policy.agents", "policy", "pass", "Repository AGENTS.md is present.", "No action needed.", false)
    : check("policy.agents", "policy", "warning", "Repository AGENTS.md is not present; only the effective workflow policy will be used.", "Add repository-specific policy through a reviewed baseline or repository pull request if needed.", false));
  checks.push(skills
    ? check("policy.skills", "policy", "pass", "Repository-local agent skills are present.", "No action needed.", false)
    : check("policy.skills", "policy", "warning", "No repository-local agent skills were detected.", "Add only reviewed, repository-specific skills; control-plane safety rules remain non-overridable.", false));
  checks.push(pullRequestTemplate
    ? check("handoff.pr_template", "handoff", "pass", "A pull-request template is available for human handoff.", "No action needed.", true)
    : missingCheck("handoff.pr_template", "handoff", "No pull-request template was found.", "Approve the proposed baseline pull request to add the repository template before Live handoff.", true));

  let validationCommands = 0;
  if (repositoryPath) {
    try {
      validationCommands = await detectSupportedChecks(repositoryPath);
    } catch {
      validationCommands = 0;
    }
  }
  checks.push(validationCommands > 0
    ? check("validation.commands", "validation", "pass", `${validationCommands} supported validation command${validationCommands === 1 ? "" : "s"} detected without executing it.`, "No action needed.", true)
    : missingCheck("validation.commands", "validation", "No supported validation commands were detected.", "Add an explicit supported test, typecheck, build, or pytest command; readiness does not execute repository scripts.", true));

  const hasClineKey = configured(process.env.CLINE_API_KEY);
  const hasGithubToken = configured(process.env.GITHUB_TOKEN);
  checks.push(hasClineKey
    ? check("runtime.cline", "runtime", "pass", "Cline runtime credentials are configured (value withheld).", "No action needed.", true)
    : missingCheck("runtime.cline", "runtime", "Cline runtime credentials are not configured.", "Configure CLINE_API_KEY in the host environment; readiness never returns its value.", true));
  checks.push(hasGithubToken
    ? check("runtime.github", "runtime", "pass", "GitHub host credentials are configured (value withheld).", "No action needed.", true)
    : missingCheck("runtime.github", "runtime", "GitHub host credentials are not configured.", "Configure GITHUB_TOKEN in the host environment; readiness never returns its value.", true));
  checks.push(check("runtime.model", "runtime", "pass", `Cline provider/model configuration is ${process.env.CLINE_PROVIDER_ID && process.env.CLINE_MODEL_ID ? "explicit" : "using safe defaults"}.`, "No action needed unless a repository requires a specific provider/model.", true));

  let projectStatus: ReadinessReport["projectStatus"] = { configured: Boolean(project.githubProjectId), reachable: null, fieldName: null, statusFieldIssue: null, options: [], mappings: STATUS_CONCEPTS.map((concept) => ({ concept, optionId: null, optionName: null, state: "unavailable", candidates: [] })) };
  let projectPriority: ReadinessReport["projectPriority"] = { configured: Boolean(project.githubProjectId), reachable: null, fieldName: null, priorityFieldIssue: null, options: [], mappings: emptyPriorityMappings() };
  if (project.githubProjectId && hasGithubToken) {
    try {
      const capability = await inspectProjectCapabilities(project);
      projectStatus = { configured: true, reachable: true, fieldName: capability.statusFieldName, statusFieldIssue: capability.statusFieldIssue, options: capability.statusOptions, mappings: capability.statusMappings };
      projectPriority = { configured: true, reachable: true, fieldName: capability.priorityFieldName, priorityFieldIssue: capability.priorityFieldIssue, options: capability.priorityOptions, mappings: capability.priorityMappings };
    } catch (error) {
      const statusIssue = statusFieldIssue(error);
      const priorityIssue = priorityFieldIssue(error);
      projectStatus = {
        ...projectStatus,
        reachable: statusIssue ? true : false,
        statusFieldIssue: statusIssue,
        mappings: statusIssue
          ? STATUS_CONCEPTS.map((concept) => ({ concept, optionId: null, optionName: null, state: statusIssue === "ambiguous_status_fields" ? "ambiguous" : "missing", candidates: [] }))
          : projectStatus.mappings,
      };
      projectPriority = {
        ...projectPriority,
        reachable: priorityIssue ? true : false,
        priorityFieldIssue: priorityIssue,
        mappings: priorityIssue ? emptyPriorityMappings(priorityIssue === "ambiguous_priority_fields" ? "unavailable" : "missing") : projectPriority.mappings,
      };
    }
  }
  statusCheckForMappings(projectStatus.mappings, projectStatus.configured, projectStatus.reachable, checks);
  statusFieldCheck(projectStatus, checks);
  priorityCheckForMappings(projectPriority, checks);

  const categories = addCategoryCounts(checks);
  const checkoutRootReady = Boolean(repositoryPath && checks.some((item) => item.id === "checkout.git_root" && item.status === "pass"));
  const liveReady = checkoutRootReady && checks.every((item) => !item.liveRequired || item.status === "pass");
  const overallLevel = liveReady ? "live_ready" : checkoutRootReady ? "demo_ready" : repositoryPath ? "inspectable" : "registered";
  return {
    contractVersion: READINESS_CONTRACT_VERSION,
    checkedAt: new Date().toISOString(),
    overallLevel,
    checks,
    categories,
    baseline: {
      workflow,
      workflowPath: workflow === "local" ? "WORKFLOW.md" : workflow === "default" ? "workflows/default/WORKFLOW.md" : null,
      agents,
      skills,
      pullRequestTemplate,
      proposal: !localWorkflow || !pullRequestTemplate ? "create_baseline_via_pr" : "none",
    },
    projectStatus,
    projectPriority,
  };
}

export function liveReadinessFailure(report: ReadinessReport) {
  if (report.overallLevel === "live_ready") return null;
  const reasons = report.checks
    .filter((item) => item.liveRequired && item.status !== "pass")
    .slice(0, 5)
    .map((item) => `${item.summary} ${item.remediation}`)
    .join(" ");
  return `Live mode is blocked by repository readiness. ${reasons || "Run readiness again and resolve the reported checks."}`;
}

export async function checkLiveReadiness(project: Project) {
  const report = await assessProjectReadiness(project);
  return { report, failure: liveReadinessFailure(report) };
}
