import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousNodeEnv = process.env.NODE_ENV;
const previousDataDir = process.env.DATA_DIR;
const previousExecutionMode = process.env.EXECUTION_MODE;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-demo-run-"));
process.env.NODE_ENV = "production";
process.env.DATA_DIR = dataDir;
process.env.EXECUTION_MODE = "demo";

const repository = await import("../src/lib/server/repository.ts");
const database = (await import("../src/lib/server/db.ts?demo-run")).db;
const { startAgentRun } = await import("../src/lib/server/orchestrator.ts");

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

test("moves a successful Demo run from In Progress to Review", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const project = repository.createProject({ fullName: "example/demo-review", localPath: path.join(dataDir, "checkout") });
  const task = repository.createTask({ projectId: project.id, title: "Demo Review handoff", status: "ready" });
  const run = startAgentRun(task!.id);
  assert.equal(repository.getTask(task!.id)?.status, "in_progress");

  context.mock.timers.tick(13_000);

  assert.equal(repository.getRun(run!.id)?.status, "completed");
  assert.equal(repository.getTask(task!.id)?.status, "human_review");
  assert.equal(repository.getTask(task!.id)?.prUrl, "https://github.com/owner/repository/pull/1");
});