import fs from "node:fs/promises";
import path from "node:path";
import { addActivity, addRunEvent, createRun, getProject, getRun, getTask, updateRun, updateTask } from "./repository";
import { createPullRequest, publishComment } from "./github";
import { runCline, stopClineRun } from "./cline";
import type { RunUsageSnapshot } from "./cost";
import { commitAndPush, detectChecks, expandHome, prepareWorkspace, runChecks, type WorkspaceHandle } from "./workspaces";
import { redactSecrets } from "./redaction";
import type { AgentRun, RunEventDraft, RunEventType } from "../domain";

declare global {
  // eslint-disable-next-line no-var
  var activeControlPlaneRuns: Map<string, NodeJS.Timeout[]> | undefined;
}

const activeRuns = globalThis.activeControlPlaneRuns ?? new Map<string, NodeJS.Timeout[]>();
if (process.env.NODE_ENV !== "production") globalThis.activeControlPlaneRuns = activeRuns;

const demoSteps = [
  { progress: 14, activity: "Reading WORKFLOW.md and issue context", type: "progress", message: "Loaded repository contract", detail: "The workflow prompt and recent human context are ready." },
  { progress: 31, activity: "Inspecting the repository structure", type: "workspace_ready", message: "Workspace prepared", detail: "The agent is working inside an isolated task worktree." },
  { progress: 53, activity: "Implementing the requested change", type: "progress", message: "Code changes in progress", detail: "The active branch is being updated by the agent." },
  { progress: 72, activity: "Running project validation", type: "validation_started", message: "Validation started", detail: "Configured tests, lint, and build checks are running." },
  { progress: 89, activity: "Preparing a reviewable handoff", type: "progress", message: "Review summary prepared", detail: "Changed files and validation results are being condensed." },
  { progress: 100, activity: "Pull request ready for review", type: "run_completed", message: "Run completed", detail: "The branch is ready for a human review checkpoint." },
] as const;

function livePrerequisiteError() {
  if (!process.env.CLINE_API_KEY) return "Live mode is blocked: configure CLINE_API_KEY before starting an agent.";
  if (!process.env.GITHUB_TOKEN) return "Live mode is blocked: configure GITHUB_TOKEN before a branch or PR can be published.";
  return null;
}

function persistRunUsage(runId: string, usage: RunUsageSnapshot) {
  updateRun(runId, {
    providerId: usage.providerId,
    modelId: usage.modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    actualCostUsd: usage.actualCostUsd,
    costSource: usage.costSource,
  });
}

export type LiveRunStage = "configuration" | "workspace" | "cline" | "validation" | "git_handoff" | "pull_request" | "issue_update";

export interface LiveRunDependencies {
  runCline: typeof runCline;
  prepareWorkspace: typeof prepareWorkspace;
  detectChecks: typeof detectChecks;
  runChecks: typeof runChecks;
  commitAndPush: typeof commitAndPush;
  createPullRequest: typeof createPullRequest;
  publishComment: typeof publishComment;
}

const liveRunDependencies: LiveRunDependencies = {
  runCline,
  prepareWorkspace,
  detectChecks,
  runChecks,
  commitAndPush,
  createPullRequest,
  publishComment,
};

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message) || "Live agent failed unexpectedly.";
}

function stageFailureMessage(stage: LiveRunStage, error: unknown) {
  return `Live run failed during ${stage}: ${safeErrorMessage(error)}`;
}

function safeChecks(checks: ReturnType<typeof runChecks> extends Promise<infer Result> ? Result : never) {
  return checks.map((check) => ({ ...check, output: check.output === undefined ? undefined : redactSecrets(check.output) ?? "" }));
}

function assertRunNotStopped(runId: string) {
  if (getRun(runId)?.status === "stopped") throw new Error("Run stopped by operator.");
}

async function buildPrompt(projectPath: string, task: ReturnType<typeof getTask>) {
  if (!task) return "";
  const workflowPath = path.join(projectPath, "WORKFLOW.md");
  const defaultWorkflow = path.resolve(process.cwd(), "workflows/default/WORKFLOW.md");
  let workflow = "";
  try { workflow = await fs.readFile(workflowPath, "utf8"); } catch { workflow = await fs.readFile(defaultWorkflow, "utf8"); }
  return `${workflow}\n\n## Assigned task\nTitle: ${task.title}\n\nDescription:\n${task.description || "No description provided."}\n\nLatest context:\n${task.currentSummary}\n\nWork in the assigned isolated workspace. Make the change, validate it, and leave a concise handoff.`;
}

function persistRunEvent(runId: string, event: RunEventDraft) {
  addRunEvent(runId, event.type, event.message, event.detail);
}

export async function executeLiveRun(runId: string, taskId: string, sourceRunId?: string, dependencies: LiveRunDependencies = liveRunDependencies) {
  const task = getTask(taskId);
  const project = task ? getProject(task.projectId) : null;
  let stage: LiveRunStage = "configuration";
  const enterStage = (next: LiveRunStage, detail: string) => {
    stage = next;
    addRunEvent(runId, "stage_started", `Live run stage started: ${next}`, detail);
  };
  if (!task || !project) {
    const message = stageFailureMessage(stage, "Project or task disappeared before live dispatch.");
    if (getRun(runId)) {
      updateRun(runId, { status: "failed", currentActivity: "Live run failed", error: message, finishedAt: new Date().toISOString() });
      addRunEvent(runId, "stage_failed", `Live run stage failed: ${stage}`, message);
      addRunEvent(runId, "run_failed", "Live run failed", message);
    }
    return;
  }
  let workspace: WorkspaceHandle | undefined;
  try {
    assertRunNotStopped(runId);
    enterStage("configuration", "Validating the task, project, and live-run prerequisites.");
    updateRun(runId, { status: "running", progress: 4, currentActivity: "Validating the local checkout" });
    addRunEvent(runId, "dispatch", "Live run dispatched", "Preparing an isolated Git worktree.");
    const run = getRun(runId);
    const sourceRun = sourceRunId ? getRun(sourceRunId) : null;
    if (!run) throw new Error("Live run disappeared before workspace preparation.");
    enterStage("workspace", "Preparing an isolated Git worktree.");
    workspace = await dependencies.prepareWorkspace(project, task, { runId, mode: run.mode, continuationWorkspacePath: sourceRun?.workspacePath });
    assertRunNotStopped(runId);
    updateRun(runId, { progress: 12, branchName: workspace.branchName, workspacePath: workspace.workspacePath, currentActivity: workspace.reused ? "Existing worktree resumed" : "Fresh isolated worktree ready" });
    updateTask(task.id, { branchName: workspace.branchName, summary: "Cline is working inside an isolated worktree." });
    addRunEvent(runId, workspace.reused ? "workspace_reused" : "workspace_created", workspace.reused ? "Existing isolated worktree resumed" : "Fresh isolated worktree created", workspace.workspacePath);
    const prompt = await buildPrompt(expandHome(project.localPath), task);
    assertRunNotStopped(runId);
    enterStage("cline", "Starting the Cline session and executing the task turn.");
    const result = await dependencies.runCline({ runId, task, project, prompt, workspacePath: workspace.workspacePath, providerId: run.providerId, modelId: run.modelId }, {
      onActivity: (message) => { const safeMessage = redactSecrets(message) ?? "Agent activity"; updateRun(runId, { progress: Math.min(68, 15 + Math.floor(Math.random() * 30)), currentActivity: safeMessage }); },
      onEvent: (event) => persistRunEvent(runId, event),
      onUsage: (usage) => persistRunUsage(runId, usage),
    });
    assertRunNotStopped(runId);
    if (result.finishReason !== "completed") throw new Error(`Cline run did not complete successfully (finish reason: ${result.finishReason}).`);
    if (result.usage) persistRunUsage(runId, result.usage);
    else updateRun(runId, { costSource: "unavailable" });
    updateRun(runId, { sessionId: result.sessionId, progress: 72, currentActivity: "Running repository validation" });
    enterStage("validation", "Detecting and running repository validation checks.");
    const checks = await dependencies.detectChecks(workspace.workspacePath);
    assertRunNotStopped(runId);
    addRunEvent(runId, "validation_started", "Validation started", `${checks.length} configured check${checks.length === 1 ? "" : "s"} detected.`);
    const checked = await dependencies.runChecks(workspace.workspacePath, checks, (next) => updateRun(runId, { checks: safeChecks(next), currentActivity: next.find((check) => check.status === "running")?.command ?? "Running validation" }));
    const safeChecked = safeChecks(checked);
    updateRun(runId, { checks: safeChecked });
    assertRunNotStopped(runId);
    const failedChecks = safeChecked.filter((check) => check.status === "failed");
    if (failedChecks.length > 0) {
      addRunEvent(runId, "validation_failed", "Validation failed", `${failedChecks.length} of ${safeChecked.length} checks failed.`);
      throw new Error("A configured validation check failed. The worktree was preserved and no PR was created.");
    }
    addRunEvent(runId, "validation_passed", "Validation passed", `${safeChecked.filter((check) => check.status === "passed").length}/${safeChecked.length} checks passed.`);
    enterStage("git_handoff", "Committing and pushing the task branch.");
    updateRun(runId, { progress: 88, currentActivity: "Committing and pushing the task branch" });
    const handoff = await dependencies.commitAndPush(workspace, task.title);
    assertRunNotStopped(runId);
    updateRun(runId, { commitSha: handoff.sha, changedFiles: handoff.changedFiles, progress: 94, currentActivity: "Creating the GitHub pull request" });
    const handoffRun = getRun(runId);
    if (!handoffRun) throw new Error("Live run disappeared before GitHub handoff.");
    enterStage("pull_request", "Creating the GitHub pull request.");
    assertRunNotStopped(runId);
    const pr = await dependencies.createPullRequest(project.fullName, task, { ...handoffRun, commitSha: handoff.sha, branchName: workspace.branchName });
    assertRunNotStopped(runId);
    updateTask(task.id, { status: "agent_review", agentState: "succeeded", branchName: workspace.branchName, prUrl: pr.url, summary: `Live run completed. ${handoff.changedFiles.length} files changed; PR #${pr.number} is ready for review.` });
    updateRun(runId, { status: "completed", progress: 100, currentActivity: "Pull request ready for review", finishedAt: new Date().toISOString() });
    addRunEvent(runId, "handoff_complete", "Pull request created", pr.url);
    addActivity({ projectId: project.id, taskId: task.id, runId, type: "pull_request", title: "Live PR ready for review", detail: `${handoff.changedFiles.length} changed files · ${handoff.sha.slice(0, 8)}`, tone: "violet" });
    if (task.issueNumber) {
      enterStage("issue_update", "Publishing the optional Issue handoff comment.");
      try {
        await dependencies.publishComment(project.fullName, task.issueNumber, `Agent handoff is ready.\n\nPR: ${pr.url}\nCommit: ${handoff.sha}\nChanged files: ${handoff.changedFiles.length}\nChecks: ${safeChecked.filter((check) => check.status === "passed").length}/${safeChecked.length} passed.`);
      } catch (error) {
        const message = safeErrorMessage(error);
        addRunEvent(runId, "stage_failed", "Live run stage failed: issue_update", message);
        addRunEvent(runId, "handoff_comment_failed", "Pull request ready; Issue update failed", message);
        addActivity({ projectId: project.id, taskId: task.id, runId, type: "handoff_warning", title: "Pull request ready; Issue update failed", detail: message, tone: "amber" });
      }
    }
  } catch (error) {
    if (getRun(runId)?.status === "stopped") return;
    const message = stageFailureMessage(stage, error);
    const failedRun = getRun(runId);
    if (failedRun?.costSource === "pending") updateRun(runId, { costSource: "unavailable" });
    updateRun(runId, { status: "failed", currentActivity: "Live run failed", error: message, finishedAt: new Date().toISOString() });
    updateTask(task.id, { status: "blocked", agentState: "failed", summary: message });
    addRunEvent(runId, "stage_failed", `Live run stage failed: ${stage}`, safeErrorMessage(error));
    addRunEvent(runId, "run_failed", "Live run failed", message);
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
      const event: RunEventDraft = { type: step.type as RunEventType, message: step.message, detail: step.detail, checkpoint: false };
      persistRunEvent(runId, event);
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
    addRunEvent(runId, "run_stopped", "Run stopped by operator", "The worktree was preserved for inspection or continuation.");
    addActivity({ projectId: run.projectId, taskId: run.taskId, runId, type: "run_stopped", title: "Agent stopped", detail: "Workspace preserved for continuation.", tone: "rose" });
  }
  return run;
}