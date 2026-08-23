import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-run-claims-"));
const previousEnvironment = new Map<string, string | undefined>([
  ["NODE_ENV", process.env.NODE_ENV],
  ["DATA_DIR", process.env.DATA_DIR],
  ["EXECUTION_MODE", process.env.EXECUTION_MODE],
  ["AGENT_MAX_CONCURRENT_RUNS", process.env.AGENT_MAX_CONCURRENT_RUNS],
  ["AGENT_MAX_CONCURRENT_RUNS_PER_PROJECT", process.env.AGENT_MAX_CONCURRENT_RUNS_PER_PROJECT],
  ["AGENT_CLAIM_LEASE_MINUTES", process.env.AGENT_CLAIM_LEASE_MINUTES],
  ["AGENT_RUN_LEASE_MINUTES", process.env.AGENT_RUN_LEASE_MINUTES],
]);

process.env.NODE_ENV = "production";
process.env.DATA_DIR = runtimeDir;
process.env.EXECUTION_MODE = "live";
process.env.AGENT_MAX_CONCURRENT_RUNS = "4";
process.env.AGENT_MAX_CONCURRENT_RUNS_PER_PROJECT = "2";
process.env.AGENT_CLAIM_LEASE_MINUTES = "46";
process.env.AGENT_RUN_LEASE_MINUTES = "46";

const repository = await import("../src/lib/server/repository.ts");
const database = (await import("../src/lib/server/db.ts")).db;

after(() => {
  database.close();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture(label: string, projectId?: string) {
  const project = projectId
    ? repository.getProject(projectId)!
    : repository.createProject({ fullName: `claims/${label}`, localPath: path.join(runtimeDir, label) });
  const task = repository.createTask({ projectId: project.id, title: `Claim ${label}`, status: "ready" });
  return { project, task };
}

test("atomically allows one owner when duplicate requests race", async () => {
  const { task } = fixture("duplicate");
  const results = await Promise.allSettled([
    Promise.resolve().then(() => repository.createRun({ taskId: task.id, mode: "start" })),
    Promise.resolve().then(() => repository.createRun({ taskId: task.id, mode: "start" })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof repository.RunClaimError && result.reason.code === "RUN_ALREADY_ACTIVE").length, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE task_id = ?").get(task.id).count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM active_run_claims WHERE task_id = ?").get(task.id).count, 1);
  const owner = repository.getRun(database.prepare("SELECT run_id FROM active_run_claims WHERE task_id = ?").get(task.id).run_id);
  if (owner) repository.updateRun(owner.id, { status: "completed", finishedAt: new Date().toISOString() });
});

test("enforces project and global limits and reports configured capacity", () => {
  const first = fixture("boundary-a");
  const projectSibling = fixture("boundary-a-sibling", first.project.id);
  const firstRun = repository.createRun({ taskId: first.task.id, mode: "start" });
  const siblingRun = repository.createRun({ taskId: projectSibling.task.id, mode: "start" });
  assert.ok(firstRun);
  assert.ok(siblingRun);
  assert.throws(() => repository.createRun({ taskId: fixture("boundary-a-third", first.project.id).task.id, mode: "start" }), (error: unknown) => error instanceof repository.RunClaimError && error.code === "PROJECT_CAPACITY_REACHED");
  const thirdProjectRun = repository.createRun({ taskId: fixture("boundary-c").task.id, mode: "start" });
  const fourthProjectRun = repository.createRun({ taskId: fixture("boundary-d").task.id, mode: "start" });
  assert.ok(thirdProjectRun);
  assert.ok(fourthProjectRun);
  const globalLimitTask = fixture("boundary-e").task;
  assert.throws(() => repository.createRun({ taskId: globalLimitTask.id, mode: "start" }), (error: unknown) => error instanceof repository.RunClaimError && error.code === "GLOBAL_CAPACITY_REACHED");
  const dashboard = repository.getDashboard();
  assert.deepEqual(dashboard.runtime.capacity, { active: 4, globalLimit: 4, perProjectLimit: 2 });
  for (const run of [firstRun, siblingRun, thirdProjectRun, fourthProjectRun]) {
    if (run) repository.updateRun(run.id, { status: "completed", finishedAt: new Date().toISOString() });
  }
});

test("releases terminal claims and recovers expired claims without deleting history", () => {
  const terminal = fixture("release");
  const terminalRun = repository.createRun({ taskId: terminal.task.id, mode: "start" });
  assert.ok(terminalRun);
  repository.updateRun(terminalRun.id, { status: "completed", finishedAt: new Date().toISOString() });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM active_run_claims WHERE run_id = ?").get(terminalRun.id).count, 0);

  for (const status of ["failed", "stopped"] as const) {
    const next = fixture(`release-${status}`);
    const nextRun = repository.createRun({ taskId: next.task.id, mode: "retry" });
    assert.ok(nextRun);
    repository.updateRun(nextRun.id, { status, finishedAt: new Date().toISOString() });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM active_run_claims WHERE run_id = ?").get(nextRun.id).count, 0);
  }

  const expired = fixture("expired");
  const expiredRun = repository.createRun({ taskId: expired.task.id, mode: "start" });
  assert.ok(expiredRun);
  database.prepare("UPDATE active_run_claims SET lease_expires_at = ? WHERE run_id = ?").run("1970-01-01T00:00:00.000Z", expiredRun.id);
  assert.equal(repository.recoverExpiredRunClaims(), 1);
  assert.equal(repository.getRun(expiredRun.id)?.status, "failed");
  assert.equal(repository.getTask(expired.task.id)?.agentState, "failed");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").get(expiredRun.id).count, 1);
});

test("persists fenced lease metadata, renews healthy ownership, and supports restart recovery", () => {
  const runFixture = fixture("lease-lifecycle");
  const run = repository.createRun({ taskId: runFixture.task.id, mode: "start" });
  assert.ok(run);
  assert.equal(run.ownerId, repository.getRunOwnerId());
  assert.ok(run.leaseHeartbeatAt);
  assert.ok(run.leaseExpiresAt);
  assert.equal(run.currentStage, "configuration");
  assert.equal(run.recoveryStatus, "none");

  const staged = repository.updateRun(run.id, { currentStage: "cline", workspacePath: "/tmp/preserved-lease-worktree" }, { ownerId: repository.getRunOwnerId() });
  assert.equal(staged?.currentStage, "cline");
  assert.equal(staged?.workspacePath, "/tmp/preserved-lease-worktree");
  assert.equal(repository.updateRun(run.id, { currentStage: "validation" }, { ownerId: "owner-from-another-process" }), null);
  assert.equal(repository.getRun(run.id)?.currentStage, "cline");
  assert.equal(repository.renewRunLease(run.id, "owner-from-another-process"), null);
  assert.equal(repository.recoverExpiredRunClaims(), 0);
  const renewed = repository.renewRunLease(run.id);
  assert.ok(renewed);
  assert.equal(renewed?.ownerId, repository.getRunOwnerId());
  assert.ok(Date.parse(renewed?.leaseHeartbeatAt ?? "") >= Date.parse(run.leaseHeartbeatAt ?? ""));

  database.prepare("UPDATE active_run_claims SET lease_expires_at = ? WHERE run_id = ?").run("1970-01-01T00:00:00.000Z", run.id);
  database.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run("1970-01-01T00:00:00.000Z", run.id);
  assert.equal(repository.recoverExpiredRunClaims(), 1);
  const recovered = repository.getRun(run.id);
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.recoveryStatus, "interrupted");
  assert.equal(recovered?.ownerId, null);
  assert.equal(recovered?.workspacePath, "/tmp/preserved-lease-worktree");
  assert.ok(recovered?.finishedAt);
  assert.match(recovered?.recoveryReason ?? "", /interrupted after its lease expired/);
  assert.equal(repository.getTask(runFixture.task.id)?.agentState, "failed");
  assert.equal(repository.getRunEvents(run.id).filter((event) => event.type === "run_recovered").length, 1);
  assert.equal(repository.recoverExpiredRunClaims(), 0);

  const retry = repository.createRun({ taskId: runFixture.task.id, mode: "retry" });
  assert.ok(retry);
  assert.equal(retry?.mode, "retry");
  if (retry) repository.updateRun(retry.id, { status: "completed", finishedAt: new Date().toISOString() });
});