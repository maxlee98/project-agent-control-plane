import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-idempotency-"));
const previousNodeEnv = process.env.NODE_ENV;
const previousDataDir = process.env.DATA_DIR;
process.env.NODE_ENV = "production";
process.env.DATA_DIR = dataDir;

const repository = await import("../src/lib/server/repository.ts");
const database = (await import("../src/lib/server/db.ts?idempotency")).db;

after(() => {
  database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});

test("claims an idempotency key once and replays the stored response", () => {
  const first = repository.claimIdempotencyKey("task-create-1", "task.create", "fingerprint-a");
  assert.deepEqual(first, { kind: "new" });

  const conflict = repository.claimIdempotencyKey("task-create-1", "task.create", "fingerprint-b");
  assert.deepEqual(conflict, { kind: "conflict" });

  repository.completeIdempotencyKey("task-create-1", "task.create", "fingerprint-a", { id: "task-1" }, 201);
  const replay = repository.claimIdempotencyKey("task-create-1", "task.create", "fingerprint-a");
  assert.deepEqual(replay, { kind: "replay", response: { id: "task-1" }, status: 201 });
});

test("does not claim a key for a different operation", () => {
  repository.claimIdempotencyKey("run-1", "run.start", "fingerprint");
  assert.deepEqual(repository.claimIdempotencyKey("run-1", "run.retry", "fingerprint"), { kind: "conflict" });
});