import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousNodeEnv = process.env.NODE_ENV;
const previousDataDir = process.env.DATA_DIR;
const previousExecutionMode = process.env.EXECUTION_MODE;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-done-transition-"));
process.env.NODE_ENV = "production";
process.env.DATA_DIR = dataDir;
process.env.EXECUTION_MODE = "demo";

const repository = await import("../src/lib/server/repository.ts");
const database = (await import("../src/lib/server/db.ts?done-transition")).db;

after(() => {
  database.close();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousExecutionMode === undefined) delete process.env.EXECUTION_MODE;
  else process.env.EXECUTION_MODE = previousExecutionMode;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("human Done clears stale agent state and preserves failed run history", () => {
  const task = repository.createTask({ projectId: "project-control-plane", title: "Failed task to complete manually", priority: 1, status: "blocked" });
  assert.ok(task);
  const run = repository.createRun({ taskId: task!.id, mode: "start" });
  assert.ok(run);
  repository.updateTask(task!.id, { status: "blocked", agentState: "failed", summary: "Validation failed before human completion." });
  repository.updateRun(run!.id, { status: "failed", error: "Validation failed", finishedAt: new Date().toISOString() });
  repository.addRunEvent(run!.id, "run_failed", "Run failed", "Validation failed");

  const completed = repository.completeTaskByHuman(task!.id);
  assert.equal(completed?.status, "done");
  assert.equal(completed?.agentState, "idle");
  assert.equal(completed?.currentSummary, "Marked done by a human after independent verification.");
  assert.equal(repository.getRun(run!.id)?.status, "failed");
  assert.equal(repository.getRun(run!.id)?.error, "Validation failed");
  assert.equal(repository.getRunEvents(run!.id).some((event) => event.type === "run_failed"), true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity WHERE task_id = ? AND type = 'human_completion'").get(task!.id)?.count, 1);

  repository.completeTaskByHuman(task!.id);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity WHERE task_id = ? AND type = 'human_completion'").get(task!.id)?.count, 1);
});

test("ordinary non-Done status updates preserve the existing agent state", () => {
  const task = repository.createTask({ projectId: "project-control-plane", title: "Blocked task remains failed", status: "blocked" });
  assert.ok(task);
  repository.updateTask(task!.id, { status: "blocked", agentState: "failed" });
  const updated = repository.updateTask(task!.id, { status: "ready" });
  assert.equal(updated?.status, "ready");
  assert.equal(updated?.agentState, "failed");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity WHERE task_id = ? AND type = 'human_completion'").get(task!.id)?.count, 0);
});