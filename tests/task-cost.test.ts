import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousNodeEnv = process.env.NODE_ENV;
const previousDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-task-cost-"));
process.env.NODE_ENV = "production";
process.env.DATA_DIR = dataDir;

const { parseEstimatedCostCents } = await import("../src/lib/server/cost.ts");
const repository = await import("../src/lib/server/repository.ts");
const database = (await import("../src/lib/server/db.ts?task-cost")).db;

after(() => {
  database.close();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("parses non-negative USD estimates into safe integer cents", () => {
  assert.equal(parseEstimatedCostCents(undefined), 0);
  assert.equal(parseEstimatedCostCents(""), 0);
  assert.equal(parseEstimatedCostCents("12.345"), 1235);
  assert.equal(parseEstimatedCostCents("$12.34"), null);
  assert.equal(parseEstimatedCostCents(0), 0);
  assert.equal(parseEstimatedCostCents(-1), null);
  assert.equal(parseEstimatedCostCents("not-a-number"), null);
  assert.equal(parseEstimatedCostCents(null), null);
  assert.equal(parseEstimatedCostCents(Number.POSITIVE_INFINITY), null);
});

test("persists task cost estimates in cents and maps them back to USD", () => {
  const seededTask = repository.getTask("task-live-overview");
  assert.equal(seededTask?.estimatedCostUsd, 0);

  const task = repository.createTask({ projectId: "project-control-plane", title: "Task with a budget", estimatedCostCents: 1234 });
  assert.ok(task);
  assert.equal(task?.estimatedCostUsd, 12.34);
  assert.equal(database.prepare("SELECT estimated_cost_cents FROM tasks WHERE id = ?").get(task!.id)?.estimated_cost_cents, 1234);

  const updated = repository.updateTask(task!.id, { estimatedCostCents: 567 });
  assert.equal(updated?.estimatedCostUsd, 5.67);
  assert.equal(database.prepare("SELECT estimated_cost_cents FROM tasks WHERE id = ?").get(task!.id)?.estimated_cost_cents, 567);
  assert.equal(updated?.title, "Task with a budget");
});