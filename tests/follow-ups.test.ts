import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-follow-ups-"));
const previous = new Map<string, string | undefined>([["NODE_ENV", process.env.NODE_ENV], ["DATA_DIR", process.env.DATA_DIR], ["EXECUTION_MODE", process.env.EXECUTION_MODE]]);
process.env.NODE_ENV = "production";
process.env.DATA_DIR = dataDir;
process.env.EXECUTION_MODE = "demo";

const repository = await import("../src/lib/server/repository.ts");
const followUps = await import("../src/lib/server/follow-ups.ts");
const database = (await import("../src/lib/server/db.ts?follow-ups")).db;

after(() => {
  database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function fixture(label: string) {
  const project = repository.createProject({ fullName: `follow-ups/${label}`, localPath: path.join(dataDir, label) });
  const task = repository.createTask({ projectId: project.id, title: `Resolved ${label}`, description: "The resolved task context.", status: "human_review", priority: 2 });
  return { project, task: task! };
}

test("normalizes bounded proposals and rejects unsafe or oversized fields", () => {
  const proposal = followUps.normalizeFollowUpProposal({ title: "Coverage", rationale: "Protect behavior", priority: 2, description: "Add tests", acceptanceCriteria: ["The test passes"] });
  assert.equal(proposal.origin, "generated");
  assert.match(proposal.id, /^proposal-/);
  assert.throws(() => followUps.normalizeFollowUpProposal({ title: "x", rationale: "x", priority: 9, description: "x", acceptanceCriteria: ["x"] }), /priority/);
  assert.throws(() => followUps.normalizeFollowUpProposals([]), /proposals must contain/);
});

test("replays a follow-up creation request only for the same fingerprint", () => {
  const first = repository.claimIdempotencyKey("follow-up-retry", "task.follow-ups.create", "same-request");
  assert.deepEqual(first, { kind: "new" });
  repository.completeIdempotencyKey("follow-up-retry", "task.follow-ups.create", "same-request", { outcomes: [] }, 201);
  assert.deepEqual(repository.claimIdempotencyKey("follow-up-retry", "task.follow-ups.create", "same-request"), { kind: "replay", response: { outcomes: [] }, status: 201 });
  assert.deepEqual(repository.claimIdempotencyKey("follow-up-retry", "task.follow-ups.create", "different-request"), { kind: "conflict" });
});

test("uses a deterministic Demo recommendation fallback and records no provider output", async () => {
  const { project, task } = fixture("demo");
  let networkCalls = 0;
  const proposals = await followUps.recommendFollowUps(task, project, 2, { recommend: async () => { networkCalls += 1; return "unsafe"; } });
  assert.equal(networkCalls, 0);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0]?.origin, "generated");
  assert.doesNotMatch(JSON.stringify(proposals), /token=|api.?key/i);
});

test("creates only selected Demo proposals as local Inbox tasks", async () => {
  const { project, task } = fixture("create");
  const proposal = followUps.normalizeFollowUpProposal({ id: "selected", origin: "manual", title: "Manual next step", rationale: "Close the gap", priority: 3, description: "Implement the next step.", acceptanceCriteria: ["The next step is covered."] });
  const outcomes = await followUps.createSelectedFollowUps(task, project, [proposal]);
  assert.deepEqual(outcomes[0]?.result, "created");
  const created = repository.getTask(outcomes[0]!.taskId!);
  assert.equal(created?.status, "inbox");
  assert.equal(created?.issueNumber, null);
  assert.equal(created?.priority, 3);
});

test("returns per-proposal failure without claiming creation", async () => {
  process.env.EXECUTION_MODE = "live";
  const { project, task } = fixture("failure");
  const proposal = followUps.normalizeFollowUpProposal({ id: "failed", origin: "manual", title: "Remote next step", rationale: "Need it", priority: 1, description: "Remote work.", acceptanceCriteria: ["It is created."] });
  const outcomes = await followUps.createSelectedFollowUps(task, project, [proposal], { createIssue: async () => { throw new Error("remote token=secret failed"); } });
  assert.equal(outcomes[0]?.result, "failed");
  assert.equal(outcomes[0]?.taskId, undefined);
  assert.doesNotMatch(outcomes[0]?.message ?? "", /secret|token=/i);
  process.env.EXECUTION_MODE = "demo";
});

test("creates Live proposals through Issue and Projects boundaries before linking locally", async () => {
  process.env.EXECUTION_MODE = "live";
  const { task } = fixture("live");
  const liveProject = repository.createProject({ fullName: "follow-ups/live-board", localPath: path.join(dataDir, "live-board"), githubProjectId: "PVT_followups" });
  const liveTask = repository.createTask({ projectId: liveProject.id, title: "Resolved live", status: "done" });
  const proposal = followUps.normalizeFollowUpProposal({ id: "live-proposal", origin: "manual", title: "Live next step", rationale: "Ship the adjacent improvement", priority: 1, description: "Create the remote task.", acceptanceCriteria: ["The remote Issue is linked."] });
  const calls: string[] = [];
  const outcomes = await followUps.createSelectedFollowUps(liveTask!, liveProject, [proposal], {
    createIssue: async (_fullName, title, body, priority) => { calls.push(`${title}:${priority}:${body.includes("## Acceptance criteria")}`); return { number: 42, url: "https://github.com/follow-ups/live-board/issues/42", nodeId: "I_live_42" }; },
    reconcileTaskStatus: async () => { calls.push("project-sync"); return { projectChanged: true, issueChanged: false, issueNumber: 42, githubUrl: "https://github.com/follow-ups/live-board/issues/42", issueCreated: true, issueCorrected: false, projectItemAdded: true }; },
  });
  assert.deepEqual(calls, ["Live next step:1:true", "project-sync"]);
  assert.equal(outcomes[0]?.result, "created");
  assert.equal(outcomes[0]?.issueNumber, 42);
  assert.equal(repository.getTask(outcomes[0]!.taskId!)?.githubUrl, "https://github.com/follow-ups/live-board/issues/42");
  assert.equal(repository.getTask(outcomes[0]!.taskId!)?.description.includes("## Summary"), true);
  assert.equal(repository.getTask(task.id)?.issueNumber, null);
  process.env.EXECUTION_MODE = "demo";
});