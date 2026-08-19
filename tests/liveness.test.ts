import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLocalPath } from "../src/lib/server/paths.ts";

const previousNodeEnv = process.env.NODE_ENV;
const previousDataDir = process.env.DATA_DIR;
const previousExecutionMode = process.env.EXECUTION_MODE;
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-runtime-"));
const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-migration-"));

process.env.NODE_ENV = "production";
process.env.DATA_DIR = runtimeDir;
process.env.EXECUTION_MODE = "demo";

const repository = await import("../src/lib/server/repository.ts");
const runtimeDatabase = (await import("../src/lib/server/db.ts")).db;

process.env.DATA_DIR = migrationDir;
const migrationDatabase = (await import("../src/lib/server/db.ts?migration-initial")).db;
const checkoutPath = path.join(os.homedir(), "Documents/Repos/project-agent-control-plane");

migrationDatabase.prepare(`
  INSERT INTO projects (id, name, full_name, description, initials, accent, local_path, default_branch, github_project_id, github_project_url, is_demo, status, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run("project-duplicate", "Project Agent Control Plane", "maxlee98/project-agent-control-plane", "User project", "PA", "#ff9d66", checkoutPath, "main", null, null, 0, "connected", new Date().toISOString());
migrationDatabase.prepare(`
  INSERT INTO tasks (id, project_id, issue_number, title, description, status, priority, labels_json, assignee, agent_state, current_summary, branch_name, pr_url, github_url, updated_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run("task-duplicate", "project-duplicate", 99, "Preserve this task", "Task history must survive reconciliation.", "ready", 2, "[]", "You", "idle", "Keep this record.", null, null, null, new Date().toISOString(), new Date().toISOString());
migrationDatabase.prepare(`
  INSERT INTO runs (id, task_id, project_id, mode, status, session_id, branch_name, workspace_path, progress, current_activity, started_at, finished_at, error, execution_mode, commit_sha, changed_files_json, checks_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run("run-duplicate", "task-duplicate", "project-duplicate", "start", "completed", null, null, null, 100, "Completed", new Date().toISOString(), new Date().toISOString(), null, "demo", null, "[]", "[]");
migrationDatabase.prepare(`
  INSERT INTO activity (id, project_id, task_id, run_id, type, title, detail, tone, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run("activity-duplicate", "project-duplicate", "task-duplicate", "run-duplicate", "checkpoint", "Preserve activity", "Activity history must survive reconciliation.", "cyan", new Date().toISOString());
migrationDatabase.prepare(`
  INSERT INTO run_events (id, run_id, type, message, detail, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`).run("event-duplicate", "run-duplicate", "checkpoint", "Preserve event", "Run events remain linked to the run.", new Date().toISOString());
migrationDatabase.close();
const reconciledDatabase = (await import("../src/lib/server/db.ts?migration-rerun")).db;

after(() => {
  runtimeDatabase.close();
  reconciledDatabase.close();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousExecutionMode === undefined) delete process.env.EXECUTION_MODE;
  else process.env.EXECUTION_MODE = previousExecutionMode;
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.rmSync(migrationDir, { recursive: true, force: true });
});

test("normalizes home-relative and absolute checkout paths", () => {
  assert.equal(normalizeLocalPath("~/Documents/Repos/project-agent-control-plane"), checkoutPath);
  assert.equal(normalizeLocalPath(checkoutPath), checkoutPath);
});

test("migrates the seeded sample to Demo and reconciles duplicate child history", () => {
  const projects = reconciledDatabase.prepare("SELECT id, is_demo FROM projects WHERE local_path = ? OR local_path = ?").all("~/Documents/Repos/project-agent-control-plane", checkoutPath) as Array<{ id: string; is_demo: number }>;
  assert.deepEqual(projects, [{ id: "project-duplicate", is_demo: 0 }]);
  assert.equal(reconciledDatabase.prepare("SELECT project_id FROM tasks WHERE id = ?").get("task-duplicate")?.project_id, "project-duplicate");
  assert.equal(reconciledDatabase.prepare("SELECT project_id FROM runs WHERE id = ?").get("run-duplicate")?.project_id, "project-duplicate");
  assert.equal(reconciledDatabase.prepare("SELECT project_id FROM activity WHERE id = ?").get("activity-duplicate")?.project_id, "project-duplicate");
  assert.equal(reconciledDatabase.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?").get("run-duplicate")?.count, 1);
  assert.equal(reconciledDatabase.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get("project-control-plane")?.count, 0);
});

test("keeps Demo fixtures truthful and does not count a persisted Live row", () => {
  const seedProject = repository.getProject("project-control-plane");
  const seedTask = repository.getTask("task-live-overview");
  const seedRun = repository.getRun("run-seed-live-overview");
  assert.equal(seedProject?.isDemo, true);
  assert.equal(seedTask?.agentState, "idle");
  assert.equal(seedRun?.executionMode, "demo");
  assert.equal(seedRun?.status, "completed");
  assert.equal(seedRun?.sessionId, null);
  assert.equal(repository.getDashboard().projects.find((project) => project.id === seedProject?.id)?.activeAgents, 0);

  const promoted = repository.createProject({
    fullName: "maxlee98/project-agent-control-plane",
    localPath: checkoutPath,
    description: "Promoted user checkout",
  });
  assert.equal(promoted?.id, "project-control-plane");
  assert.equal(promoted?.isDemo, false);
  assert.equal(promoted?.fullName, "maxlee98/project-agent-control-plane");
  assert.equal(promoted?.name, "project agent control plane");
  const configured = repository.createProject({ fullName: "maxlee98/project-agent-control-plane", localPath: checkoutPath, githubProjectId: "PVT_live-project" });
  assert.equal(configured?.githubProjectId, "PVT_live-project");
  assert.equal(repository.createProject({ fullName: "maxlee98/another-name", localPath: "~/Documents/Repos/project-agent-control-plane" })?.id, promoted?.id);

  process.env.EXECUTION_MODE = "live";
  const liveProject = repository.createProject({ fullName: "maxlee98/liveness-fixture", localPath: path.join(runtimeDir, "liveness-fixture") });
  assert.ok(liveProject);
  const liveTask = repository.createTask({ projectId: liveProject!.id, title: "Persisted live row" });
  assert.ok(liveTask);
  const liveRun = repository.createRun({ taskId: liveTask!.id, mode: "start" });
  assert.equal(liveRun?.executionMode, "live");
  assert.equal(liveRun?.isActive, false);
  const liveDashboard = repository.getDashboard();
  assert.equal(liveDashboard.projects.some((project) => project.isDemo), false);
  assert.equal(liveDashboard.projects.find((project) => project.id === liveProject!.id)?.activeAgents, 0);
  assert.equal(liveDashboard.runs.find((run) => run.id === liveRun!.id)?.isActive, false);
});