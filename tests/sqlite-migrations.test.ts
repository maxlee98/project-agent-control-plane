import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const previousDataDir = process.env.DATA_DIR;
const previousNodeEnv = process.env.NODE_ENV;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-sqlite-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "production";

const {
  createDatabaseBackup,
  getAppliedMigrations,
  getAppliedSchemaVersion,
  LATEST_SCHEMA_VERSION,
  runMigrations,
  runRetentionCleanup,
  SCHEMA_MIGRATIONS,
} = await import("../src/lib/server/db.ts?sqlite-migrations");

after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("applies ordered migrations once and creates retention indexes", () => {
  const database = new Database(":memory:");
  assert.equal(runMigrations(database), LATEST_SCHEMA_VERSION);
  assert.deepEqual(getAppliedMigrations(database).map((migration) => migration.version), [1, 2, 3]);
  assert.equal(runMigrations(database), LATEST_SCHEMA_VERSION);
  assert.deepEqual(getAppliedMigrations(database).map((migration) => migration.version), [1, 2, 3]);

  const indexes = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_run_events_run_created"));
  assert.ok(indexes.includes("idx_activity_task_created"));
  assert.ok(indexes.includes("idx_runs_retention"));
  assert.ok(indexes.includes("idx_remote_deliveries_retention"));
  database.close();
});

test("does not record a failed migration and retries from the last completed version", () => {
  const database = new Database(":memory:");
  let shouldFail = true;
  const order: number[] = [];
  const migrations = [
    { version: 1, name: "one", up: (current: Database.Database) => { order.push(1); current.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY)"); } },
    { version: 2, name: "two", up: (current: Database.Database) => { order.push(2); current.exec("ALTER TABLE fixture ADD COLUMN value TEXT"); if (shouldFail) throw new Error("fixture failure"); } },
    { version: 3, name: "three", up: (current: Database.Database) => { order.push(3); current.exec("CREATE INDEX fixture_value ON fixture(value)"); } },
  ] as const;

  assert.throws(() => runMigrations(database, migrations, "/tmp/control-plane-before-migration.sqlite"), (error: unknown) => {
    assert.equal((error as Error).name, "DatabaseMigrationError");
    assert.equal((error as { version: number }).version, 2);
    assert.match((error as Error).message, /restore \/tmp\/control-plane-before-migration\.sqlite/);
    return true;
  });
  assert.equal(getAppliedSchemaVersion(database), 1);
  assert.deepEqual(order, [1, 2]);

  shouldFail = false;
  assert.equal(runMigrations(database, migrations), 3);
  assert.deepEqual(order, [1, 2, 2, 3]);
  assert.deepEqual(getAppliedMigrations(database).map((migration) => migration.name), ["one", "two", "three"]);
  database.close();
});

test("creates a restorable checkpoint without exposing database contents", () => {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE checkpoint_fixture (value TEXT NOT NULL)");
  database.prepare("INSERT INTO checkpoint_fixture (value) VALUES (?)").run("private fixture value");
  const backupDirectory = fs.mkdtempSync(path.join(dataDir, "backup-"));
  const backupPath = createDatabaseBackup(database, backupDirectory);

  assert.equal(fs.existsSync(backupPath), true);
  const backup = new Database(backupPath, { readonly: true });
  assert.equal(backup.prepare("SELECT value FROM checkpoint_fixture").get()?.value, "private fixture value");
  backup.close();
  database.close();
});

test("retains active, failed, and review evidence while removing old low-risk history", () => {
  const database = new Database(":memory:");
  runMigrations(database, SCHEMA_MIGRATIONS);
  const now = new Date("2026-08-24T00:00:00.000Z");
  const old = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

  database.prepare(`
    INSERT INTO projects (id, name, full_name, initials, accent, local_path, last_synced_at)
    VALUES ('retention-project', 'Retention', 'example/retention', 'RT', '#fff', '/tmp/retention', ?)
  `).run(now.toISOString());
  const tasks = [
    ["task-done", "done"],
    ["task-review", "human_review"],
    ["task-active", "in_progress"],
    ["task-failed", "blocked"],
    ["task-worktree", "done"],
  ];
  for (const [id, status] of tasks) {
    database.prepare(`
      INSERT INTO tasks (id, project_id, title, status, updated_at, created_at)
      VALUES (?, 'retention-project', ?, ?, ?, ?)
    `).run(id, id, status, old, old);
  }
  const runs = [
    ["run-done", "task-done", "completed", old, old],
    ["run-review", "task-review", "completed", old, old],
    ["run-active", "task-active", "running", recent, null],
    ["run-failed", "task-failed", "failed", old, old],
    ["run-worktree", "task-worktree", "completed", old, old],
  ] as const;
  for (const [id, taskId, status, startedAt, finishedAt] of runs) {
    database.prepare(`
      INSERT INTO runs (id, task_id, project_id, mode, status, started_at, finished_at)
      VALUES (?, ?, 'retention-project', 'start', ?, ?, ?)
    `).run(id, taskId, status, startedAt, finishedAt);
  }
  database.prepare("UPDATE runs SET workspace_path = 'retention-project/worktrees/task-worktree' WHERE id = 'run-worktree'").run();
  database.prepare("UPDATE tasks SET agent_state = 'failed' WHERE id = 'task-failed'").run();
  database.prepare("INSERT INTO active_run_claims (task_id, run_id, project_id, execution_mode, claimed_at, lease_expires_at) VALUES (?, ?, 'retention-project', 'live', ?, ?)")
    .run("task-active", "run-active", recent, new Date(now.getTime() + 60 * 60 * 1000).toISOString());
  const eventInsert = database.prepare("INSERT INTO run_events (id, run_id, type, message, created_at) VALUES (?, ?, 'progress', ?, ?)");
  eventInsert.run("event-done", "run-done", "old completed evidence", old);
  eventInsert.run("event-review", "run-review", "review evidence", old);
  eventInsert.run("event-active", "run-active", "active evidence", recent);
  eventInsert.run("event-failed", "run-failed", "failure evidence", old);
  eventInsert.run("event-worktree", "run-worktree", "worktree evidence", old);
  const activityInsert = database.prepare("INSERT INTO activity (id, project_id, task_id, run_id, type, title, created_at) VALUES (?, 'retention-project', ?, ?, 'checkpoint', ?, ?)");
  activityInsert.run("activity-done", "task-done", "run-done", "old completed activity", old);
  activityInsert.run("activity-review", "task-review", "run-review", "review activity", old);
  activityInsert.run("activity-active", "task-active", "run-active", "active activity", old);
  activityInsert.run("activity-failed", "task-failed", "run-failed", "failure activity", old);
  activityInsert.run("activity-review-no-run", "task-review", null, "review task activity", old);
  activityInsert.run("activity-worktree", "task-worktree", "run-worktree", "worktree activity", old);
  database.prepare("INSERT INTO remote_deliveries (id, operation, status, created_at) VALUES (?, 'checkpoint', ?, ?)").run("delivery-old", "delivered", old);
  database.prepare("INSERT INTO remote_deliveries (id, operation, status, created_at) VALUES (?, 'checkpoint', ?, ?)").run("delivery-pending", "pending", old);
  database.prepare("INSERT INTO remote_deliveries (id, run_id, operation, status, created_at) VALUES (?, ?, 'checkpoint', ?, ?)").run("delivery-active", "run-active", "delivered", old);

  const result = runRetentionCleanup(database, { runEvents: 90, activity: 180, completedRuns: 365, remoteDeliveries: 180 }, now);
  assert.deepEqual(result, { runEvents: 1, activity: 1, completedRuns: 1, remoteDeliveries: 1 });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM run_events WHERE id = 'event-done'").get()?.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM run_events WHERE id IN ('event-review', 'event-active', 'event-failed', 'event-worktree')").get()?.count, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity WHERE id = 'activity-done'").get()?.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity WHERE id IN ('activity-review', 'activity-active', 'activity-failed', 'activity-review-no-run', 'activity-worktree')").get()?.count, 5);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = 'run-done'").get()?.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE id IN ('run-review', 'run-active', 'run-failed', 'run-worktree')").get()?.count, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM remote_deliveries WHERE id = 'delivery-old'").get()?.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM remote_deliveries WHERE id IN ('delivery-pending', 'delivery-active')").get()?.count, 2);
  database.close();
});