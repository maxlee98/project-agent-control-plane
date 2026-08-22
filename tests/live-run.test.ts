import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClineCore } from "@cline/sdk";
import type { AgentRunInput } from "../src/lib/integrations.ts";
import type { Project, RunCheck, Task } from "../src/lib/domain.ts";
import type { ClineCallbacks, ClineRuntimeDependencies } from "../src/lib/server/cline.ts";
import type { LiveRunDependencies } from "../src/lib/server/orchestrator.ts";
import type { RunUsageSnapshot } from "../src/lib/server/cost.ts";
import type { WorkspaceHandle } from "../src/lib/server/workspaces.ts";

const secret = "github-test-secret-123";
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-live-run-"));
const previousEnvironment = new Map<string, string | undefined>([
  ["NODE_ENV", process.env.NODE_ENV],
  ["DATA_DIR", process.env.DATA_DIR],
  ["EXECUTION_MODE", process.env.EXECUTION_MODE],
  ["GITHUB_TOKEN", process.env.GITHUB_TOKEN],
  ["CLINE_API_KEY", process.env.CLINE_API_KEY],
  ["CLINE_PROVIDER_ID", process.env.CLINE_PROVIDER_ID],
  ["CLINE_MODEL_ID", process.env.CLINE_MODEL_ID],
  ["AGENT_MAX_RUN_MINUTES", process.env.AGENT_MAX_RUN_MINUTES],
  ["AGENT_INACTIVITY_MINUTES", process.env.AGENT_INACTIVITY_MINUTES],
]);

process.env.NODE_ENV = "production";
process.env.DATA_DIR = runtimeDir;
process.env.EXECUTION_MODE = "live";
process.env.GITHUB_TOKEN = secret;
process.env.CLINE_API_KEY = "cline-test-key";
process.env.CLINE_PROVIDER_ID = "openrouter";
process.env.CLINE_MODEL_ID = "test-model";
process.env.AGENT_MAX_RUN_MINUTES = "1";
process.env.AGENT_INACTIVITY_MINUTES = "1";

const repository = await import("../src/lib/server/repository.ts");
const database = (await import("../src/lib/server/db.ts")).db;
const { executeLiveRun } = await import("../src/lib/server/orchestrator.ts");
const { hasActiveClineSession, runCline } = await import("../src/lib/server/cline.ts");

after(() => {
  database.close();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const usage: RunUsageSnapshot = {
  providerId: "openrouter",
  modelId: "test-model",
  inputTokens: 120,
  outputTokens: 45,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  totalCost: 0.012345,
  actualCostUsd: 0.012345,
  costSource: "sdk",
};

function makeClineInput(runId: string, reasoningEffort?: "high"): AgentRunInput & { runId: string; providerId: string; modelId: string } {
  return {
    runId,
    task: {} as Task,
    project: {} as Project,
    prompt: "complete the assigned task",
    workspacePath: "/tmp/fake-live-workspace",
    providerId: "openrouter",
    modelId: "test-model",
    reasoningEffort,
  };
}

function fakeClineCore(finishReason: "completed" | "max_iterations" = "completed", emitForeignTerminalEvent = false) {
  let listener: ((event: { type: string; payload: unknown }) => void) | undefined;
  let startedInput: unknown;
  let activeDuringSend = false;
  let disposed = false;
  let stopped = false;
  const core = {
    subscribe(callback: (event: { type: string; payload: unknown }) => void) {
      listener = callback;
      return () => { listener = undefined; };
    },
    async start(input: unknown) {
      startedInput = input;
      return { sessionId: "session-fake", manifest: {}, manifestPath: "", messagesPath: "" };
    },
    async send(input: { sessionId: string; prompt: string }) {
      activeDuringSend = hasActiveClineSession("cline-unit");
      if (emitForeignTerminalEvent) {
        listener?.({
          type: "agent_event",
          payload: {
            sessionId: "session-other",
            event: { type: "done", reason: "max_iterations", text: "foreign result" },
          },
        });
      }
      listener?.({
        type: "agent_event",
        payload: {
          sessionId: input.sessionId,
          event: { type: "done", reason: finishReason, text: "event result", usage },
        },
      });
      return { text: "returned result", finishReason, usage };
    },
    async getAccumulatedUsage() {
      return { aggregateUsage: usage };
    },
    async stop() {
      stopped = true;
    },
    async dispose() {
      disposed = true;
    },
  };
  return {
    core: core as unknown as ClineCore,
    get startedInput() { return startedInput as { prompt?: string; config?: { reasoningEffort?: string } }; },
    get activeDuringSend() { return activeDuringSend; },
    get disposed() { return disposed; },
    get stopped() { return stopped; },
  };
}

test("starts a session before sending the task turn and uses the returned result", async () => {
  const fake = fakeClineCore();
  const events: string[] = [];
  const callbacks: ClineCallbacks = {
    onActivity: () => undefined,
    onEvent: (event) => events.push(event.type),
    onUsage: () => undefined,
  };
  const dependencies: ClineRuntimeDependencies = { createCore: async () => fake.core };

  const result = await runCline(makeClineInput("cline-unit"), callbacks, dependencies);

  assert.equal(fake.startedInput.prompt, undefined);
  assert.equal(fake.activeDuringSend, true);
  assert.equal(result.sessionId, "session-fake");
  assert.equal(result.text, "returned result");
  assert.equal(result.finishReason, "completed");
  assert.equal(result.usage?.actualCostUsd, usage.actualCostUsd);
  assert.equal(events.includes("session_started"), true);
  assert.equal(events.includes("run_completed"), true);
  assert.equal(events.includes("done"), false);
  assert.equal(hasActiveClineSession("cline-unit"), false);
  assert.equal(fake.disposed, true);
  assert.equal(fake.stopped, false);
});

test("passes an explicit reasoning effort to ClineCore and omits it for the default", async () => {
  const explicit = fakeClineCore();
  await runCline(makeClineInput("cline-explicit-effort", "high"), { onActivity: () => undefined, onEvent: () => undefined }, { createCore: async () => explicit.core });
  assert.equal(explicit.startedInput.config?.reasoningEffort, "high");

  const defaultRun = fakeClineCore();
  await runCline(makeClineInput("cline-default-effort"), { onActivity: () => undefined, onEvent: () => undefined }, { createCore: async () => defaultRun.core });
  assert.equal(Object.prototype.hasOwnProperty.call(defaultRun.startedInput.config ?? {}, "reasoningEffort"), false);
});

test("ignores terminal events from another Cline session", async () => {
  const fake = fakeClineCore("completed", true);

  const result = await runCline(
    makeClineInput("cline-session-filter"),
    { onActivity: () => undefined, onEvent: () => undefined },
    { createCore: async () => fake.core },
  );

  assert.equal(result.finishReason, "completed");
  assert.equal(hasActiveClineSession("cline-session-filter"), false);
});

test("fails closed for a non-completed Cline terminal result", async () => {
  const fake = fakeClineCore("max_iterations");

  await assert.rejects(
    () => runCline(makeClineInput("cline-max-iterations"), { onActivity: () => undefined, onEvent: () => undefined }, { createCore: async () => fake.core }),
    /finish reason: max_iterations/,
  );
  assert.equal(hasActiveClineSession("cline-max-iterations"), false);
  assert.equal(fake.disposed, true);
});

function createLiveFixture(label: string) {
  const project = repository.createProject({ fullName: `example/live-${label}`, localPath: path.join(runtimeDir, `checkout-${label}`) });
  const task = repository.createTask({ projectId: project.id, issueNumber: 36, title: `Live run ${label}`, description: "Exercise the complete live-run lifecycle.", status: "ready" });
  const run = task ? repository.createRun({ taskId: task.id, mode: "start" }) : null;
  assert.ok(task);
  assert.ok(run);
  return { project, task, run };
}

function createDependencies(label: string, options: { commentFailure?: boolean; clineFailure?: boolean; checkFailure?: boolean } = {}): LiveRunDependencies {
  const workspace: WorkspaceHandle = {
    repositoryPath: path.join(runtimeDir, `repository-${label}`),
    workspacePath: path.join(runtimeDir, `workspace-${label}`),
    branchName: `agent/live-${label}`,
    baseBranch: "main",
    reused: false,
  };
  return {
    prepareWorkspace: async () => workspace,
    runCline: async (_input, callbacks) => {
      if (options.clineFailure) throw new Error(`Provider failed with token=${secret}`);
      callbacks.onActivity("Cline completed");
      callbacks.onEvent({ type: "output_summary", message: "Agent output summarized", detail: "Completed safely", checkpoint: false });
      callbacks.onUsage?.(usage);
      return { sessionId: `session-${label}`, text: "Completed task", finishReason: "completed" as const, usage };
    },
    detectChecks: async () => [{ name: "Tests", command: "npm test", status: "pending" as const }],
    runChecks: async (_workspacePath, checks, onUpdate) => {
      onUpdate(checks.map((check) => ({ ...check, status: "running" as const })));
      return checks.map((check) => ({
        ...check,
        status: options.checkFailure ? "failed" as const : "passed" as const,
        output: options.checkFailure ? `failure token=${secret}` : "all checks passed",
        durationMs: 5,
      }));
    },
    commitAndPush: async () => ({ sha: `commit-${label}`, changedFiles: [`src/${label}.ts`] }),
    createPullRequest: async () => ({ number: 36, url: `https://github.com/example/live-${label}/pull/36` }),
    reconcileTaskStatus: async () => ({ projectChanged: false, issueChanged: false, issueNumber: 36, githubUrl: `https://github.com/example/live-${label}/issues/36`, issueCreated: false, issueCorrected: false, projectItemAdded: false }),
    publishComment: async () => {
      if (options.commentFailure) throw new Error(`GitHub API 422: token=${secret}`);
    },
  };
}

test("completes a mocked live run with persisted state, events, PR identity, and cost", async () => {
  const fixture = createLiveFixture("success");
  await executeLiveRun(fixture.run.id, fixture.task.id, undefined, createDependencies("success"));

  const completedRun = repository.getRun(fixture.run.id);
  const completedTask = repository.getTask(fixture.task.id);
  const events = repository.getRunEvents(fixture.run.id);
  const eventTypes = new Set(events.map((event) => event.type));

  assert.equal(completedRun?.status, "completed");
  assert.equal(completedRun?.progress, 100);
  assert.equal(completedRun?.commitSha, "commit-success");
  assert.deepEqual(completedRun?.changedFiles, ["src/success.ts"]);
  assert.equal(completedRun?.inputTokens, usage.inputTokens);
  assert.equal(completedRun?.actualCostUsd, usage.actualCostUsd);
  assert.equal(completedRun?.costSource, "sdk");
  assert.equal(completedTask?.status, "human_review");
  assert.equal(completedTask?.agentState, "succeeded");
  assert.equal(completedTask?.prUrl, "https://github.com/example/live-success/pull/36");
  for (const stage of ["configuration", "workspace", "cline", "validation", "git_handoff", "pull_request", "issue_update"]) {
    assert.equal(events.some((event) => event.type === "stage_started" && event.message.includes(stage)), true, `missing stage event: ${stage}`);
  }
  assert.equal(eventTypes.has("handoff_complete"), true);
  assert.equal(eventTypes.has("output_summary"), true);
  assert.equal(eventTypes.has("validation_started"), true);
  assert.equal(eventTypes.has("validation_passed"), true);
  assert.equal(eventTypes.has("content_end"), false);
  assert.equal(eventTypes.has("done"), false);
});

test("keeps a completed handoff when the optional Issue comment fails", async () => {
  const fixture = createLiveFixture("comment-warning");
  await executeLiveRun(fixture.run.id, fixture.task.id, undefined, createDependencies("comment-warning", { commentFailure: true }));

  const run = repository.getRun(fixture.run.id);
  const task = repository.getTask(fixture.task.id);
  const event = repository.getRunEvents(fixture.run.id).find((candidate) => candidate.type === "handoff_comment_failed");
  const activity = repository.getDashboard().activity.find((candidate) => candidate.runId === fixture.run.id && candidate.type === "handoff_warning");

  assert.equal(run?.status, "completed");
  assert.equal(task?.status, "human_review");
  assert.equal(task?.agentState, "succeeded");
  assert.equal(event?.detail?.includes(secret), false);
  assert.equal(event?.detail?.includes("[REDACTED_SECRET]"), true);
  assert.equal(activity?.detail?.includes(secret), false);
  assert.equal(repository.getRunEvents(fixture.run.id).some((candidate) => candidate.type === "stage_failed" && candidate.message.includes("issue_update")), true);
});

test("records a redacted stage failure and preserves the failed workspace", async () => {
  const fixture = createLiveFixture("cline-failure");
  await executeLiveRun(fixture.run.id, fixture.task.id, undefined, createDependencies("cline-failure", { clineFailure: true }));

  const run = repository.getRun(fixture.run.id);
  const task = repository.getTask(fixture.task.id);
  const failure = repository.getRunEvents(fixture.run.id).find((candidate) => candidate.type === "stage_failed");

  assert.equal(run?.status, "failed");
  assert.equal(run?.workspacePath, path.join(runtimeDir, "workspace-cline-failure"));
  assert.equal(run?.error?.includes(secret), false);
  assert.equal(run?.error?.includes("during cline"), true);
  assert.equal(failure?.message.includes("cline"), true);
  assert.equal(failure?.detail?.includes(secret), false);
  assert.equal(task?.status, "blocked");
  assert.equal(task?.agentState, "failed");
});

test("redacts validation output before persisting a validation-stage failure", async () => {
  const fixture = createLiveFixture("validation-failure");
  await executeLiveRun(fixture.run.id, fixture.task.id, undefined, createDependencies("validation-failure", { checkFailure: true }));

  const run = repository.getRun(fixture.run.id);
  const failure = repository.getRunEvents(fixture.run.id).find((candidate) => candidate.type === "stage_failed");
  const check = run?.checks[0] as RunCheck | undefined;

  assert.equal(run?.status, "failed");
  assert.equal(failure?.message.includes("validation"), true);
  assert.equal(check?.status, "failed");
  assert.equal(check?.output?.includes(secret), false);
  assert.equal(check?.output?.includes("[REDACTED_SECRET]"), true);
});

test("does not overwrite an operator stop while an async Cline stage unwinds", async () => {
  const fixture = createLiveFixture("operator-stop");
  const dependencies = createDependencies("operator-stop");
  dependencies.runCline = async () => {
    repository.updateRun(fixture.run.id, { status: "stopped", currentActivity: "Stopped by operator", finishedAt: new Date().toISOString() });
    repository.updateTask(fixture.task.id, { agentState: "waiting", summary: "Run stopped by you. Continue when you are ready." });
    throw new Error("Cline stop acknowledged");
  };

  await executeLiveRun(fixture.run.id, fixture.task.id, undefined, dependencies);

  const run = repository.getRun(fixture.run.id);
  const task = repository.getTask(fixture.task.id);
  const events = repository.getRunEvents(fixture.run.id);

  assert.equal(run?.status, "stopped");
  assert.equal(task?.agentState, "waiting");
  assert.equal(task?.status, "in_progress");
  assert.equal(events.some((event) => event.type === "run_failed"), false);
  assert.equal(events.some((event) => event.type === "stage_failed"), false);
});