import fs from "node:fs/promises";
import path from "node:path";
import { addActivity, addRunEvent, createRun, getProject, getRun, getTask, updateRun, updateTask } from "./repository";
import { createPullRequest, publishComment } from "./github";
import { runCline, stopClineRun } from "./cline";
import { commitAndPush, detectChecks, expandHome, prepareWorkspace, runChecks, type WorkspaceHandle } from "./workspaces";
import type { AgentRun, Project, RunEventDraft, Task } from "../domain";
import { redactSecrets } from "./redaction";

declare global {
  // eslint-disable-next-line no-var
  var activeControlPlaneRuns: Map<string, NodeJS.Timeout[]> | undefined;
}

const activeRuns = globalThis.activeControlPlaneRuns ?? new Map<string, NodeJS.Timeout[]>();
if (process.env.NODE_ENV !== "production") globalThis.activeControlPlaneRuns = activeRuns;

const demoSteps = [
  { progress: 14, activity: "Reading WORKFLOW.md and issue context", type: "progress", message: "Loaded repository contract", detail: "The workflow prompt and recent human context are ready." },
  { progress: 31, activity: "Inspecting the repository structure", type: "workspace_ready", message: "Workspace prepared", detail: "The agent is working inside an isolated task worktree." },
  { progress: 53, activity: "Implementing the requested change", type: "progress", message: "Code changes in progress", detail: "The active branch is being updated by Cline." },
  { progress: 72, activity: "Running project validation", type: "validation_started", message: "Validation started", detail: "Configured tests, lint, and build checks are running." },
  { progress: 89, activity: "Preparing a reviewable handoff", type: "progress", message: "Review summary prepared", detail: "Changed files and validation results are being condensed." },
  { progress: 100, activity: "Pull request ready for review", type: "run_completed", message: "Run completed", detail: "The branch is ready for a human review checkpoint." },
] as const;

function livePrerequisiteError() {
  if (!process.env.CLINE_API_KEY) return "Live mode is blocked: configure CLINE_API_KEY before starting an agent.";
  if (!process.env.GITHUB_TOKEN) return "Live mode is blocked: configure GITHUB_TOKEN before a branch or PR can be published.";
  return null;
}

async function buildPrompt(projectPath: string, task: ReturnType<typeof getTask>) {
  if (!task) return "";
  const workflowPath = path.join(projectPath, "WORKFLOW.md");
  const defaultWorkflow = path.resolve(process.cwd(), "workflows/default/WORKFLOW.md");
  let workflow = "";
  try { workflow = await fs.readFile(workflowPath, "utf8"); } catch { workflow = await fs.readFile(defaultWorkflow, "utf8"); }
  return `${workflow}\n\n## Assigned task\nTitle: ${task.title}\n\nDescription:\n${task.description || "No description provided."}\n\nLatest context:\n${task.currentSummary}\n\nWork in the assigned isolated workspace. Make the change, validate it, and leave a concise handoff.`;
}

function queueGithubCheckpoint(project: Project, task: Task, event: RunEventDraft, run?: AgentRun | null) {
  // The final handoff is published by the richer PR comment below; keep the local event without
  // adding a duplicate generic completion comment.
  if (event.type === "handoff_complete") return;
  if (!event.checkpoint || !task.issueNumber || !run) return;
  const detail = event.detail ? `\n\n${event.detail}` : "";
  void publishComment(project.fullName, task.issueNumber, `Agent checkpoint · ${event.message}${detail}`)
      .catch((error) => addRunEvent(run.id, "checkpoint_publish_failed", "GitHub checkpoint could not be published", redactSecrets(error instanceof Error ? error.message : "GitHub checkpoint failed.")));
}

function persistRunEvent(runId: string, event: RunEventDraft, project: Project, task: Task, run?: AgentRun | null) {
  addRunEvent(runId, event.type, event.message, event.detail);
  queueGithubCheckpoint(project, task, event, run);
}

async function executeLiveRun(runId: string, taskId: string, sourceRunId?: string) {
  const task = getTask(taskId);
  const project = task ? getProject(task.projectId) : null;
  if (!task || !project) throw new Error("Project or task disappeared before live dispatch.");
  let workspace: WorkspaceHandle | undefined;
  try {
    updateRun(runId, { status: "running", progress: 4, currentActivity: "Validating the local checkout" });
    addRunEvent(runId, "dispatch", "Live run dispatched", "Preparing an isolated Git worktree.");
    const run = getRun(runId);
    const sourceRun = sourceRunId ? getRun(sourceRunId) : null;
    if (!run) throw new Error("Live run disappeared before workspace preparation.");
    workspace = await prepareWorkspace(project, task, { runId, mode: run.mode, continuationWorkspacePath: sourceRun?.workspacePath });
    updateRun(runId, { progress: 12, branchName: workspace.branchName, workspacePath: workspace.workspacePath, currentActivity: workspace.reused ? "Existing worktree resumed" : "Fresh isolated worktree ready" });
    updateTask(task.id, { branchName: workspace.branchName, summary: "Cline is working inside an isolated worktree." });
    addRunEvent(runId, workspace.reused ? "workspace_reused" : "workspace_created", workspace.reused ? "Existing isolated worktree resumed" : "Fresh isolated worktree created", workspace.workspacePath);
    const prompt = await buildPrompt(expandHome(project.localPath), task);
    const result = await runCline({ runId, task, project, prompt, workspacePath: workspace.workspacePath }, {
      onActivity: (message, detail) => { updateRun(runId, { progress: Math.min(68, 15 + Math.floor(Math.random() * 30)), currentActivity: message }); },
      onEvent: (event) => persistRunEvent(runId, event, project, task, getRun(runId)),
    });
    updateRun(runId, { sessionId: result.sessionId, progress: 72, currentActivity: "Running repository validation" });
    const checks = await detectChecks(workspace.workspacePath);
    persistRunEvent(runId, { type: "validation_started", message: "Validation started", detail: `${checks.length} configured check${checks.length === 1 ? "" : "s"} detected.`, checkpoint: false }, project, task, getRun(runId));
    const checked = await runChecks(workspace.workspacePath, checks, (next) => updateRun(runId, { checks: next, currentActivity: next.find((check) => check.status === "running")?.command ?? "Running validation" }));
    updateRun(runId, { checks: checked });
    const failedChecks = checked.filter((check) => check.status === "failed");
    const validationEvent: RunEventDraft = failedChecks.length > 0
      ? { type: "validation_failed", message: "Validation failed", detail: `${failedChecks.length} of ${checked.length} checks failed.`, checkpoint: true }
      : { type: "validation_passed", message: "Validation passed", detail: `${checked.filter((check) => check.status === "passed").length}/${checked.length} checks passed.`, checkpoint: true };
    persistRunEvent(runId, validationEvent, project, task, getRun(runId));
    if (failedChecks.length > 0) throw new Error("A configured validation check failed. The worktree was preserved and no PR was created.");
    updateRun(runId, { progress: 88, currentActivity: "Committing and pushing the task branch" });
    const handoff = await commitAndPush(workspace, task.title);
    updateRun(runId, { commitSha: handoff.sha, changedFiles: handoff.changedFiles, progress: 94, currentActivity: "Creating the GitHub pull request" });
    const handoffRun = getRun(runId);
    if (!handoffRun) throw new Error("Live run disappeared before GitHub handoff.");
    const pr = await createPullRequest(project.fullName, task, { ...handoffRun, commitSha: handoff.sha, branchName: workspace.branchName });
    updateTask(task.id, { status: "agent_review", agentState: "succeeded", branchName: workspace.branchName, prUrl: pr.url, summary: `Live run completed. ${handoff.changedFiles.length} files changed; PR #${pr.number} is ready for review.` });
    updateRun(runId, { status: "completed", progress: 100, currentActivity: "Pull request ready for review", finishedAt: new Date().toISOString() });
    persistRunEvent(runId, { type: "handoff_complete", message: "Pull request created", detail: pr.url, checkpoint: true }, project, task, getRun(runId));
    addActivity({ projectId: project.id, taskId: task.id, runId, type: "pull_request", title: "Live PR ready for review", detail: `${handoff.changedFiles.length} changed files · ${handoff.sha.slice(0, 8)}`, tone: "violet" });
    if (task.issueNumber) await publishComment(project.fullName, task.issueNumber, `Agent handoff is ready.\n\nPR: ${pr.url}\nCommit: ${handoff.sha}\nChanged files: ${handoff.changedFiles.length}\nChecks: ${checked.filter((check) => check.status === "passed").length}/${checked.length} passed.`);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "Live agent failed unexpectedly.") ?? "Live agent failed unexpectedly.";
    updateRun(runId, { status: "failed", currentActivity: "Live run failed", error: message, finishedAt: new Date().toISOString() });
    updateTask(task.id, { status: "blocked", agentState: "failed", summary: message });
    persistRunEvent(runId, { type: "run_failed", message: "Live run failed", detail: message, checkpoint: true }, project, task, getRun(runId));
    addActivity({ projectId: project.id, taskId: task.id, runId, type: "run_failed", title: "Live run failed", detail: message, tone: "red" });
  }
}

function schedule(runId: string, taskId: string, mode: AgentRun["mode"]) {
  const timers: NodeJS.Timeout[] = [];
  const task = getTask(taskId);
  if (!task) return;
  const branchName = task.branchName ?? `agent/${task.issueNumber ?? "task"}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 38)}`;
  updateRun(runId, { status: "running", sessionId: `cline-demo-${runId.slice(-8)}`, branchName, workspacePath: `${task.projectId}/worktrees/${task.id}`, currentActivity: demoSteps[0].activity });
  addRunEvent(runId, "workspace_ready", "Isolated workspace ready", `${branchName} · ${mode} mode`);

  demoSteps.forEach((step, index) => {
    const timer = setTimeout(() => {
      const currentTask = getTask(taskId);
      if (!currentTask) return;
      const currentRun = updateRun(runId, { status: step.progress === 100 ? "completed" : "running", progress: step.progress, currentActivity: step.activity, finishedAt: step.progress === 100 ? new Date().toISOString() : null });
      if (!currentRun) return;
      addRunEvent(runId, step.type, step.message, step.detail);
      updateTask(taskId, {
        status: step.progress === 100 ? "agent_review" : "in_progress",
        agentState: step.progress === 100 ? "succeeded" : "running",
        summary: step.detail,
        branchName,
        prUrl: step.progress === 100 ? `https://github.com/${currentTask.githubUrl?.split("github.com/")[1]?.split("/issues/")[0] ?? "owner/repository"}/pull/${currentTask.issueNumber ?? 1}` : currentTask.prUrl,
      });
      if (index === 0 || step.progress === 72 || step.progress === 100) {
        addActivity({ projectId: currentTask.projectId, taskId, runId, type: step.progress === 100 ? "pull_request" : "checkpoint", title: step.message, detail: step.detail, tone: step.progress === 100 ? "violet" : "amber" });
      }
      if (step.progress === 100) activeRuns.delete(runId);
    }, index === 0 ? 900 : index * 2600);
    timers.push(timer);
  });
  activeRuns.set(runId, timers);
}

export function startAgentRun(taskId: string, mode: AgentRun["mode"] = "start", sourceRunId?: string) {
  const task = getTask(taskId);
  if (!task) return null;
  if (task.agentState === "running") return { error: "This task already has an active run." } as const;
  if (process.env.EXECUTION_MODE === "live") {
    const prerequisiteError = livePrerequisiteError();
    if (prerequisiteError) return { error: prerequisiteError } as const;
  }
  const run = createRun({ taskId, mode });
  if (!run) return null;
  if (run.executionMode === "live") void executeLiveRun(run.id, taskId, sourceRunId);
  else schedule(run.id, taskId, mode);
  return run;
}

export function stopAgentRun(runId: string) {
  const timers = activeRuns.get(runId);
  timers?.forEach(clearTimeout);
  activeRuns.delete(runId);
  void stopClineRun(runId).catch(() => undefined);
  const run = updateRun(runId, { status: "stopped", currentActivity: "Stopped by operator", finishedAt: new Date().toISOString() });
  if (run) {
    updateTask(run.taskId, { agentState: "waiting", summary: "Run stopped by you. Continue when you are ready." });
    const task = getTask(run.taskId);
    const project = getProject(run.projectId);
    if (task && project) persistRunEvent(runId, { type: "run_stopped", message: "Run stopped by operator", detail: "The worktree was preserved for inspection or continuation.", checkpoint: true }, project, task, run);
    else addRunEvent(runId, "run_stopped", "Run stopped by operator", "The worktree was preserved for inspection or continuation.");
    addActivity({ projectId: run.projectId, taskId: run.taskId, runId, type: "run_stopped", title: "Agent stopped", detail: "Workspace preserved for continuation.", tone: "rose" });
  }
  return run;
}