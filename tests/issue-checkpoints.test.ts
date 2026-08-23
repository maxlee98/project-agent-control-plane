import assert from "node:assert/strict";
import test from "node:test";
import { IssueCheckpointPublisher, formatIssueCheckpoint } from "../src/lib/server/issue-checkpoints.ts";

test("formats a concise checkpoint without forwarding raw agent output", () => {
  const body = formatIssueCheckpoint("run-123", { phase: "progress", progress: 108, detail: "Inspecting package scripts" });

  assert.equal(body, [
    "Agent checkpoint: progress",
    "",
    "Run: run-123",
    "Status: Agent is actively working in the isolated worktree.",
    "Progress: 100%",
    "Detail: Inspecting package scripts",
  ].join("\n"));
  assert.doesNotMatch(body, /tool|token|environment|prompt/i);
});

test("formats a bounded blocked reason with recovery guidance and redaction", () => {
  const body = formatIssueCheckpoint("run-blocked", {
    phase: "failed",
    detail: `Stage: cline\nReason: provider failed ${"x".repeat(3_000)} token=unsafe-value`,
  });

  assert.match(body, /Status: Agent run is blocked because it failed before handoff\./);
  assert.match(body, /Blocked reason: Stage: cline/);
  assert.match(body, /Next step: Inspect the preserved workspace/);
  assert.doesNotMatch(body, /token=unsafe-value/);
  assert.match(body, /…/);
  assert.ok(body.length < 2_500);
});

test("throttles ordinary progress and publishes the latest checkpoint", async () => {
  let now = 1_000;
  const bodies: string[] = [];
  const publisher = new IssueCheckpointPublisher({
    fullName: "owner/repository",
    issueNumber: 18,
    runId: "run-123",
    intervalMs: 100,
    now: () => now,
    publishComment: async (_fullName, _issueNumber, body) => { bodies.push(body); },
  });

  await publisher.checkpoint({ phase: "started" }, { force: true });
  publisher.checkpoint({ phase: "progress", progress: 20 });
  publisher.checkpoint({ phase: "progress", progress: 40 });
  now += 100;
  await publisher.flushPending();

  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /Progress: 40%/);
  publisher.stop();
});

test("does not publish duplicate checkpoint content", async () => {
  const bodies: string[] = [];
  const publisher = new IssueCheckpointPublisher({
    fullName: "owner/repository",
    issueNumber: 70,
    runId: "run-duplicate",
    publishComment: async (_fullName, _issueNumber, body) => { bodies.push(body); },
  });

  await publisher.checkpoint({ phase: "workspace", progress: 12 }, { force: true });
  await publisher.checkpoint({ phase: "workspace", progress: 12 }, { force: true });

  assert.equal(bodies.length, 1);
  publisher.stop();
});

test("serializes checkpoints and reports GitHub failures without rejecting the run", async () => {
  const order: string[] = [];
  const failures: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstComplete = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const publisher = new IssueCheckpointPublisher({
    fullName: "owner/repository",
    issueNumber: 18,
    runId: "run-123",
    publishComment: async (_fullName, _issueNumber, body) => {
      const phase = body.split("\n", 1)[0];
      order.push(phase);
      if (order.length === 1) await firstComplete;
      else throw new Error("GitHub unavailable");
    },
    onFailure: (checkpoint) => failures.push(checkpoint.phase),
  });

  const first = publisher.checkpoint({ phase: "workspace" }, { force: true });
  const second = publisher.checkpoint({ phase: "handoff" }, { force: true });
  await Promise.resolve();
  assert.deepEqual(order, ["Agent checkpoint: workspace"]);
  releaseFirst?.();
  await Promise.all([first, second]);

  assert.deepEqual(order, ["Agent checkpoint: workspace", "Agent checkpoint: handoff"]);
  assert.deepEqual(failures, ["handoff"]);
  publisher.stop();
});
