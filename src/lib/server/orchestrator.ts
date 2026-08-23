import fs from "node:fs/promises";
import path from "node:path";
import { addActivity, addRunEvent, createRun, finishRunAndTask, getLatestFailedRun, getProject, getRun, getRunLeaseIntervalMs, getRunOwnerId, getTask, recoverExpiredRunClaims, renewRunLease, stopRunAndReleaseClaim, updateRun, updateRunStage, updateTask } from "./repository";
import { createPullRequest, publishComment, reconcileTaskStatus } from "./github";
import { runCline, stopClineRun } from "./cline";
import { formatIssueCheckpoint, IssueCheckpointPublisher } from "./issue-checkpoints";
import type { RunUsageSnapshot } from "./cost";
import { commitAndPush, detectChecks, expandHome, prepareWorkspace, runChecks, type WorkspaceHandle } from "./workspaces";
import { redactSecrets } from "./redaction";
import { assessProjectReadiness, liveReadinessFailure } from "./readiness";
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

const ISSUE_WORKSPACE_LABEL = "Isolated worktree (full path available in Run console)";
const HUMAN_CLINE_EVENT_TYPES = new Set<RunEventType>(["output_summary", "progress"]);

const stageMessages: Record<LiveRunStage, string> = {
  configuration: "Checking live-run prerequisites",
  workspace: "Preparing the isolated workspace",
  cline: "Working on the assigned task",
  validation: "Validating the repository changes",
  git_handoff: "Preparing the branch handoff",
  pull_request: "Opening the pull request",
  issue_update: "Publishing the review checkpoint",
};

function livePrerequisiteError() {
  if (!process.env.CLINE_API_KEY) return "Live mode is blocked: configure CLINE_API_KEY before starting an agent.";
  if (!process.env.GITHUB_TOKEN) return "Live mode is blocked: configure GITHUB_TOKEN before a branch or PR can be published.";
  return null;
}

function persistRunUsage(runId: string, usage: RunUsageSnapshot, ownerId?: string) {
  updateRun(runId, {
    providerId: usage.providerId,
    modelId: usage.modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    actualCostUsd: usage.actualCostUsd,
    costSource: usage.costSource,
  }, ownerId ? { ownerId } : undefined);
}

export type LiveRunStage = "configuration" | "workspace" | "cline" | "validation" | "git_handoff" | "pull_request" | "issue_update";

export const recoverStaleRuns = recoverExpiredRunClaims;

export interface LiveRunDependencies {
  runCline: typeof runCline;
  prepareWorkspace: typeof prepareWorkspace;
  detectChecks: typeof detectChecks;
  runChecks: typeof runChecks;
  commitAndPush: typeof commitAndPush;
  createPullRequest: typeof createPullRequest;
  reconcileTaskStatus: typeof reconcileTaskStatus;
  publishComment: typeof publishComment;
  assessReadiness?: typeof assessProjectReadiness;
}

const liveRunDependencies: LiveRunDependencies = {
  runCline,
  prepareWorkspace,
  detectChecks,
  runChecks,
  commitAndPush,
  createPullRequest,
  reconcileTaskStatus,
  publishComment,
  assessReadiness: assessProjectReadiness,
};

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message) || "Live agent failed unexpectedly.";
}

function boundedRedacted(value: string | null | undefined, limit: number) {
  const redacted = redactSecrets(value?.trim()) ?? "";
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

function stageFailureMessage(stage: LiveRunStage, error: unknown) {
  return `Live run failed during ${stage}: ${safeErrorMessage(error)}`;
}

function nextActionForStage(stage: LiveRunStage) {
  return {
    configuration: "Prepare or resume the isolated workspace.",
    workspace: "Implement the assigned task objective and then run validation.",
    cline: "Continue the current task objective, then produce a concise implementation summary.",
    validation: "Review the check results; fix failures or prepare the branch handoff.",
    git_handoff: "Open the pull request once the branch is pushed.",
    pull_request: "Publish the final review checkpoint for the human reviewer.",
    issue_update: "Review the pull request and confirm the implementation matches the task.",
  }[stage];
}

function safeChecks(checks: ReturnType<typeof runChecks> extends Promise<infer Result> ? Result : never) {
  return checks.map((check) => ({ ...check, output: check.output === undefined ? undefined : redactSecrets(check.output) ?? "" }));
}

function assertRunNotStopped(runId: string) {
  const run = getRun(runId);
  const status = run?.status;
  if (status === "stopped") throw new Error("Run stopped by operator.");
  if (status === "failed" || status === "completed") throw new Error("Run is no longer active.");
  if (run?.executionMode === "live" && !renewRunLease(runId, getRunOwnerId())) throw new Error("Live run lease is no longer owned by this worker.");
}

async function buildPrompt(projectPath: string, task: ReturnType<typeof getTask>, mode: AgentRun["mode"], sourceRun: AgentRun | null) {
  if (!task) return "";
  const workflowPath = path.join(projectPath, "WORKFLOW.md");
  const defaultWorkflow = path.resolve(process.cwd(), "workflows/default/WORKFLOW.md");
  let workflow = "";
  try { workflow = await fs.readFile(workflowPath, "utf8"); } catch { workflow = await fs.readFile(defaultWorkflow, "utf8"); }
  const recoveryContext = sourceRun?.status === "failed"
    ? `\n\n## Recovery context\nPrevious run: ${sourceRun.id}\nPrevious failure:\n${boundedRedacted(sourceRun.error ?? sourceRun.currentActivity, 2_000)}\n\nTreat the previous run failure as a blocker to diagnose. Inspect the ${mode === "continue" ? "preserved workspace and " : "current workspace and "}repository state, find a safe way to unblock the task, and do not blindly repeat the failed approach. If a human decision, credential, or external change is required, explain exactly what is needed in the handoff.`
    : "";
  return `${workflow}\n\n## Assigned task\nTitle: ${task.title}\n\nDescription:\n${task.description || "No description provided."}\n\nLatest context:\n${task.currentSummary}${recoveryContext}\n\nWork in the assigned isolated workspace. Make the change, validate it, and leave a concise handoff. When reporting progress or the handoff, name the current task or LLD objective, what is complete, and the next action when those facts are known.`;
}

function persistRunEvent(runId: string, event: RunEventDraft) {
  if (!HUMAN_CLINE_EVENT_TYPES.has(event.type)) return;
  addRunEvent(runId, event.type, event.message, event.detail);
}

export async function executeLiveRun(runId: string, taskId: string, sourceRunId?: string, dependencies: LiveRunDependencies = liveRunDependencies) {
  const task = getTask(taskId);
  const project = task ? getProject(task.projectId) : null;
  let stage: LiveRunStage = "configuration";
  const enterStage = (next: LiveRunStage, detail: string) => {
    stage = next;
    updateRunStage(runId, next, getRunOwnerId());
    addRunEvent(runId, "stage_started", stageMessages[next], `${detail} Next: ${nextActionForStage(next)}`);
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
  let latestAgentSummary: string | null = null;
  const ownerId = getRunOwnerId();
  const leaseTimer = setInterval(() => {
    if (!renewRunLease(runId, ownerId)) clearInterval(leaseTimer);
  }, getRunLeaseIntervalMs());
  const checkpoints = task.issueNumber ? new IssueCheckpointPublisher({
    fullName: project.fullName,
    issueNumber: task.issueNumber,
    runId,
    publishComment: dependencies.publishComment,
    intervalMs: Number(process.env.AGENT_CHECKPOINT_INTERVAL_MINUTES) > 0 ? Number(process.env.AGENT_CHECKPOINT_INTERVAL_MINUTES) * 60_000 : undefined,
    onFailure: (checkpoint, error) => {
      const message = safeErrorMessage(error);
      addRunEvent(runId, "issue_checkpoint_failed", `GitHub Issue checkpoint failed (${checkpoint.phase})`, message);
      addActivity({ projectId: project.id, taskId: task.id, runId, type: "issue_checkpoint_failed", title: "GitHub Issue checkpoint failed", detail: `The ${checkpoint.phase} update could not be published.`, tone: "amber" });
      if (checkpoint.phase === "handoff") {
        addRunEvent(runId, "stage_failed", "Live run stage failed: issue_update", message);
        addRunEvent(runId, "handoff_comment_failed", "Pull request ready; Issue update failed", message);
        addActivity({ projectId: project.id, taskId: task.id, runId, type: "handoff_warning", title: "Pull request ready; Issue update failed", detail: message, tone: "amber" });
      }
    },
  }) : null;
  try {
    if (!renewRunLease(runId, ownerId)) throw new Error("Live run lease is no longer owned by this worker.");
    await checkpoints?.checkpoint({
      phase: "started",
      workspace: "Preparing isolated worktree",
      now: `Starting task: ${boundedRedacted(task.title, 240)}`,
      next: "Prepare or resume the isolated workspace.",
    }, { force: true });
    checkpoints?.startHeartbeat();
    assertRunNotStopped(runId);
    enterStage("configuration", "Validating the task, project, and live-run prerequisites.");
    updateRun(runId, { status: "running", progress: 4, currentActivity: "Validating the local checkout" }, { ownerId });
    addRunEvent(runId, "dispatch", "Live run dispatched", "Preparing an isolated Git worktree and loading the task context.");
    const run = getRun(runId);
    const sourceRun = sourceRunId ? getRun(sourceRunId) : null;
    if (!run) throw new Error("Live run disappeared before workspace preparation.");
    if (dependencies.assessReadiness) {
      const readiness = await dependencies.assessReadiness(project);
      const readinessFailure = liveReadinessFailure(readiness);
      if (readinessFailure) throw new Error(readinessFailure);
      addRunEvent(runId, "progress", "Live readiness confirmed", "The repository passed the required preflight checks.");
    }
    enterStage("workspace", "Preparing an isolated Git worktree.");
    workspace = await dependencies.prepareWorkspace(project, task, { runId, mode: run.mode, continuationWorkspacePath: sourceRun?.workspacePath });
    assertRunNotStopped(runId);
    updateRun(runId, { progress: 12, branchName: workspace.branchName, workspacePath: workspace.workspacePath, currentActivity: workspace.reused ? "Existing worktree resumed" : "Fresh isolated worktree ready" }, { ownerId });
    updateTask(task.id, { branchName: workspace.branchName, summary: "Cline is working inside an isolated worktree." });
    addRunEvent(runId, workspace.reused ? "workspace_reused" : "workspace_created", workspace.reused ? "Existing isolated worktree resumed" : "Fresh isolated worktree created", `${workspace.branchName} · ${workspace.workspacePath}`);
    await checkpoints?.checkpoint({
      phase: "workspace",
      progress: 12,
      workspace: ISSUE_WORKSPACE_LABEL,
      branchName: workspace.branchName,
      now: task.description ? `Implementing: ${boundedRedacted(task.description, 1_000)}` : `Implementing: ${boundedRedacted(task.title, 240)}`,
      next: "Implement the assigned task objective and then run validation.",
    }, { force: true });
    const prompt = await buildPrompt(expandHome(project.localPath), task, run.mode, sourceRun);
    assertRunNotStopped(runId);
    enterStage("cline", "Starting the Cline session and executing the task turn.");
    const result = await dependencies.runCline({ runId, task, project, prompt, workspacePath: workspace.workspacePath, providerId: run.providerId, modelId: run.modelId, reasoningEffort: run.reasoningEffort }, {
      onActivity: (message, detail) => {
        const safeMessage = redactSecrets(message) ?? "Agent progress";
        const safeDetail = boundedRedacted(detail, 1_800);
        const isSummary = message === "Agent output summarized";
        if (isSummary && safeDetail) latestAgentSummary = safeDetail;
        const currentRun = getRun(runId);
        const progress = Math.min(68, Math.max(15, (currentRun?.progress ?? 15) + 4));
        const now = isSummary && safeDetail ? safeDetail : safeDetail ? `${safeMessage}: ${safeDetail}` : safeMessage;
        renewRunLease(runId, ownerId);
        updateRun(runId, { progress, currentActivity: isSummary && safeDetail ? `Agent summary: ${safeDetail}` : now }, { ownerId });
        void checkpoints?.checkpoint({
          phase: "progress",
          progress,
          workspace: ISSUE_WORKSPACE_LABEL,
          branchName: workspace?.branchName,
          now,
          next: nextActionForStage("cline"),
        });
      },
      onEvent: (event) => { renewRunLease(runId, ownerId); persistRunEvent(runId, event); },
      onHeartbeat: () => { renewRunLease(runId, ownerId); },
      onUsage: (usage) => persistRunUsage(runId, usage, ownerId),
    });
    assertRunNotStopped(runId);
    if (result.finishReason !== "completed") throw new Error(`Cline run did not complete successfully (finish reason: ${result.finishReason}).`);
    if (result.usage) persistRunUsage(runId, result.usage, ownerId);
    else updateRun(runId, { costSource: "unavailable" }, { ownerId });
    updateRun(runId, { sessionId: result.sessionId, progress: 72, currentActivity: "Running repository validation" }, { ownerId });
    enterStage("validation", "Detecting and running repository validation checks.");
    const checks = await dependencies.detectChecks(workspace.workspacePath);
    assertRunNotStopped(runId);
    addRunEvent(runId, "validation_started", "Validation started", `${checks.length} configured check${checks.length === 1 ? "" : "s"} detected.`);
    await checkpoints?.checkpoint({
      phase: "validation",
      progress: 72,
      workspace: ISSUE_WORKSPACE_LABEL,
      branchName: workspace.branchName,
      now: "Running the configured repository validation checks.",
      next: "Review the check results; fix failures or prepare the branch handoff.",
      validation: `${checks.length} configured check${checks.length === 1 ? "" : "s"} running.`,
    }, { force: true });
    const checked = await dependencies.runChecks(workspace.workspacePath, checks, (next) => updateRun(runId, { checks: safeChecks(next), currentActivity: next.find((check) => check.status === "running")?.command ?? "Running validation" }, { ownerId }));
    const safeChecked = safeChecks(checked);
    updateRun(runId, { checks: safeChecked }, { ownerId });
    assertRunNotStopped(runId);
    const failedChecks = safeChecked.filter((check) => check.status === "failed");
    if (failedChecks.length > 0) {
      addRunEvent(runId, "validation_failed", "Validation failed", `${failedChecks.length} of ${safeChecked.length} checks failed.`);
      await checkpoints?.checkpoint({
        phase: "validation",
        progress: 72,
        workspace: ISSUE_WORKSPACE_LABEL,
        branchName: workspace.branchName,
        now: "Validation found failures; the branch handoff is paused.",
        next: "Inspect the failed checks, fix the workspace, and continue or retry.",
        validation: `${safeChecked.filter((check) => check.status === "passed").length}/${safeChecked.length} passed; ${failedChecks.length}/${safeChecked.length} failed.`,
        detail: `Failed checks: ${failedChecks.map((check) => check.name).join(", ")}`,
      }, { force: true });
      throw new Error("A configured validation check failed. The worktree was preserved and no PR was created.");
    }
    const passedChecks = safeChecked.filter((check) => check.status === "passed").length;
    addRunEvent(runId, "validation_passed", "Validation passed", `${passedChecks}/${safeChecked.length} checks passed.`);
    await checkpoints?.checkpoint({
      phase: "validation",
      progress: 72,
      workspace: ISSUE_WORKSPACE_LABEL,
      branchName: workspace.branchName,
      now: "Validation passed; preparing the branch handoff.",
      next: "Commit and push the branch, then open the pull request.",
      validation: `${passedChecks}/${safeChecked.length} checks passed.`,
    }, { force: true });
    enterStage("git_handoff", "Committing and pushing the task branch.");
    updateRun(runId, { progress: 88, currentActivity: "Committing and pushing the task branch" }, { ownerId });
    const handoff = await dependencies.commitAndPush(workspace, task.title);
    assertRunNotStopped(runId);
    updateRun(runId, { commitSha: handoff.sha, changedFiles: handoff.changedFiles, progress: 94, currentActivity: "Creating the GitHub pull request" }, { ownerId });
    await checkpoints?.checkpoint({
      phase: "progress",
      progress: 94,
      workspace: ISSUE_WORKSPACE_LABEL,
      branchName: workspace.branchName,
      now: "Validation passed; the branch was committed and pushed.",
      next: "Open the pull request for human review.",
      validation: `${passedChecks}/${safeChecked.length} checks passed.`,
      changedFiles: handoff.changedFiles,
      commitSha: handoff.sha,
    }, { force: true });
    const handoffRun = getRun(runId);
    if (!handoffRun) throw new Error("Live run disappeared before GitHub handoff.");
    enterStage("pull_request", "Creating the GitHub pull request.");
    assertRunNotStopped(runId);
    const pr = await dependencies.createPullRequest(project.fullName, task, { ...handoffRun, commitSha: handoff.sha, branchName: workspace.branchName });
    assertRunNotStopped(runId);
    updateTask(task.id, { branchName: workspace.branchName, prUrl: pr.url, summary: `Live run completed. ${handoff.changedFiles.length} files changed; PR #${pr.number} is ready for human review.` });
    if (project.githubProjectId) await dependencies.reconcileTaskStatus(project, task, "human_review");
    assertRunNotStopped(runId);
    const completedRun = finishRunAndTask(runId, task.id, { status: "completed", progress: 100, currentActivity: "Pull request ready for review", finishedAt: new Date().toISOString() }, { status: "human_review", agentState: "succeeded", branchName: workspace.branchName, prUrl: pr.url, summary: `Live run completed. ${handoff.changedFiles.length} files changed; PR #${pr.number} is ready for human review.` }, ownerId);
    if (!completedRun) return;
    addRunEvent(runId, "handoff_complete", "Pull request created", pr.url);
    addActivity({ projectId: project.id, taskId: task.id, runId, type: "pull_request", title: "Live PR ready for review", detail: `${handoff.changedFiles.length} changed files · ${handoff.sha.slice(0, 8)}`, tone: "violet" });
    if (task.issueNumber) {
      enterStage("issue_update", "Publishing the Issue checkpoint for the review handoff.");
      await checkpoints?.checkpoint({
        phase: "handoff",
        progress: 100,
        workspace: ISSUE_WORKSPACE_LABEL,
        branchName: workspace.branchName,
        now: latestAgentSummary ?? "Implementation is complete and the pull request is ready for review.",
        next: "Review the pull request and confirm the implementation matches the task and LLD objective.",
        validation: `${passedChecks}/${safeChecked.length} checks passed.`,
        changedFiles: handoff.changedFiles,
        commitSha: handoff.sha,
        pullRequestUrl: pr.url,
      }, { force: true });
    }
  } catch (error) {
    if (["stopped", "failed", "completed"].includes(getRun(runId)?.status ?? "")) return;
    const message = stageFailureMessage(stage, error);
    const currentFailedRun = getRun(runId);
    if (currentFailedRun?.costSource === "pending") updateRun(runId, { costSource: "unavailable" }, { ownerId });
    const finalizedFailedRun = finishRunAndTask(runId, task.id, { status: "failed", currentActivity: "Live run failed", error: message, finishedAt: new Date().toISOString() }, { status: "blocked", agentState: "failed", summary: message }, ownerId);
    if (!finalizedFailedRun) return;
    addRunEvent(runId, "stage_failed", `Live run stage failed: ${stage}`, safeErrorMessage(error));
    addRunEvent(runId, "run_failed", "Live run failed", message);
    addActivity({ projectId: project.id, taskId: task.id, runId, type: "run_failed", title: "Live run failed", detail: message, tone: "red" });
    await checkpoints?.checkpoint({
      phase: "failed",
      workspace: workspace ? ISSUE_WORKSPACE_LABEL : "Workspace was not prepared",
      branchName: workspace?.branchName,
      now: `Run is blocked during ${stage}.`,
      next: "Inspect the preserved workspace, resolve the blocker, then continue or retry.",
      detail: `Stage: ${stage}\nReason: ${boundedRedacted(safeErrorMessage(error), 1_700)}`,
    }, { force: true });
  } finally {
    clearInterval(leaseTimer);
    checkpoints?.stop();
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
      const isComplete = step.progress === 100;
      const event: RunEventDraft = { type: step.type as RunEventType, message: step.message, detail: step.detail, checkpoint: false };
      if (isComplete) {
        const currentRun = finishRunAndTask(runId, taskId, { status: "completed", progress: step.progress, currentActivity: step.activity, finishedAt: new Date().toISOString() }, { status: "human_review", agentState: "succeeded", summary: step.detail, branchName, prUrl: `https://github.com/${currentTask.githubUrl?.split("github.com/")[1]?.split("/issues/")[0] ?? "owner/repository"}/pull/${currentTask.issueNumber ?? 1}` });
        if (!currentRun) return;
      } else {
        const currentRun = updateRun(runId, { status: "running", progress: step.progress, currentActivity: step.activity, finishedAt: null }, { onlyIfActive: true });
        if (!currentRun) return;
        updateTask(taskId, { status: "in_progress", agentState: "running", summary: step.detail, branchName, prUrl: currentTask.prUrl });
      }
      persistRunEvent(runId, event);
      if (index === 0 || step.progress === 72 || step.progress === 100) {
        addActivity({ projectId: currentTask.projectId, taskId, runId, type: step.progress === 100 ? "pull_request" : "checkpoint", title: step.message, detail: step.detail, tone: step.progress === 100 ? "violet" : "amber" });
      }
      if (step.progress === 100) activeRuns.delete(runId);
    }, index === 0 ? 900 : index * 2600);
    timers.push(timer);
  });
  activeRuns.set(runId, timers);
}

export function startAgentRun(taskId: string, mode: AgentRun["mode"] = "start", sourceRunId?: string, reasoningEffort?: AgentRun["reasoningEffort"], dependencies: LiveRunDependencies = liveRunDependencies) {
  const task = getTask(taskId);
  if (!task) return null;
  if (process.env.EXECUTION_MODE === "live") {
    const prerequisiteError = livePrerequisiteError();
    if (prerequisiteError) return { error: prerequisiteError } as const;
  }
  const sourceRun = sourceRunId
    ? getRun(sourceRunId)
    : mode === "start" && task.status === "blocked"
      ? getLatestFailedRun(task.id)
      : null;
  const run = createRun({ taskId, mode, reasoningEffort: reasoningEffort === undefined ? sourceRun?.reasoningEffort ?? null : reasoningEffort });
  if (!run) return null;
  if (run.executionMode === "live") void executeLiveRun(run.id, taskId, sourceRun?.id, dependencies);
  else schedule(run.id, taskId, mode);
  return run;
}

export function stopAgentRun(runId: string) {
  const existingRun = getRun(runId);
  if (!existingRun) return null;
  if (existingRun.status !== "queued" && existingRun.status !== "running") return existingRun;
  const timers = activeRuns.get(runId);
  timers?.forEach(clearTimeout);
  activeRuns.delete(runId);
  void stopClineRun(runId).catch(() => undefined);
  const run = stopRunAndReleaseClaim(runId);
  if (run) {
    addRunEvent(runId, "run_stopped", "Run stopped by operator", "The worktree was preserved for inspection or continuation.");
    addActivity({ projectId: run.projectId, taskId: run.taskId, runId, type: "run_stopped", title: "Agent stopped", detail: "Workspace preserved for continuation.", tone: "rose" });
    const task = getTask(run.taskId);
    const project = task ? getProject(task.projectId) : null;
    if (run.executionMode === "live" && task?.issueNumber && project) {
      const body = formatIssueCheckpoint(run.id, {
        phase: "stopped",
        workspace: ISSUE_WORKSPACE_LABEL,
        branchName: run.branchName ?? task.branchName ?? undefined,
        now: "Run stopped by the operator; the workspace is preserved.",
        next: "Inspect the preserved workspace, then continue or retry when ready.",
      });
      void publishComment(project.fullName, task.issueNumber, body).catch((error) => {
        const message = safeErrorMessage(error);
        addRunEvent(runId, "issue_checkpoint_failed", "GitHub Issue checkpoint failed (stopped)", message);
        addActivity({ projectId: project.id, taskId: task.id, runId, type: "issue_checkpoint_failed", title: "GitHub Issue checkpoint failed", detail: "The stopped update could not be published.", tone: "amber" });
      });
    }
  }
  return run;
}