import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { normalizeLocalPath } from "./paths";

declare global {
  // eslint-disable-next-line no-var
  var controlPlaneDb: Database.Database | undefined;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? ".data");
const databasePath = path.join(dataDir, "control-plane.db");

function createDatabase() {
  fs.mkdirSync(dataDir, { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  // Next may evaluate route modules in parallel during build/startup. Give another
  // initializer time to finish the schema/seed transaction instead of failing with SQLITE_BUSY.
  database.pragma("busy_timeout = 10000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      initials TEXT NOT NULL,
      accent TEXT NOT NULL,
      local_path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      github_project_id TEXT,
      github_project_url TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'connected',
      last_synced_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      issue_number INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'inbox',
      priority INTEGER NOT NULL DEFAULT 3,
      labels_json TEXT NOT NULL DEFAULT '[]',
      assignee TEXT,
      agent_state TEXT NOT NULL DEFAULT 'idle',
      current_summary TEXT NOT NULL DEFAULT '',
      branch_name TEXT,
      pr_url TEXT,
      github_url TEXT,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT,
      branch_name TEXT,
      workspace_path TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      current_activity TEXT NOT NULL DEFAULT 'Queued for dispatch',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'demo',
      commit_sha TEXT,
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      checks_json TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      reasoning_effort TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      actual_cost_micros INTEGER,
      cost_source TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      tone TEXT NOT NULL DEFAULT 'slate',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_deduplication (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      response_json TEXT,
      response_status INTEGER,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_deduplication_operation ON request_deduplication(operation);
  `);

  // Keep local development databases forward-compatible when the app is upgraded.
  const columns = database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  const existingColumns = new Set(columns.map((column) => column.name));
  if (!existingColumns.has("execution_mode")) database.exec("ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'demo'");
  if (!existingColumns.has("commit_sha")) database.exec("ALTER TABLE runs ADD COLUMN commit_sha TEXT");
  if (!existingColumns.has("changed_files_json")) database.exec("ALTER TABLE runs ADD COLUMN changed_files_json TEXT NOT NULL DEFAULT '[]'");
  if (!existingColumns.has("checks_json")) database.exec("ALTER TABLE runs ADD COLUMN checks_json TEXT NOT NULL DEFAULT '[]'");
  if (!existingColumns.has("provider_id")) database.exec("ALTER TABLE runs ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''");
  if (!existingColumns.has("model_id")) database.exec("ALTER TABLE runs ADD COLUMN model_id TEXT NOT NULL DEFAULT ''");
  if (!existingColumns.has("reasoning_effort")) database.exec("ALTER TABLE runs ADD COLUMN reasoning_effort TEXT");
  if (!existingColumns.has("input_tokens")) database.exec("ALTER TABLE runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0");
  if (!existingColumns.has("output_tokens")) database.exec("ALTER TABLE runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0");
  if (!existingColumns.has("cache_read_tokens")) database.exec("ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0");
  if (!existingColumns.has("cache_write_tokens")) database.exec("ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0");
  if (!existingColumns.has("actual_cost_micros")) database.exec("ALTER TABLE runs ADD COLUMN actual_cost_micros INTEGER");
  if (!existingColumns.has("cost_source")) database.exec("ALTER TABLE runs ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'pending'");
  database.prepare("UPDATE runs SET cost_source = 'unavailable' WHERE cost_source = 'pending' AND status IN ('completed', 'failed', 'stopped')").run();

  const taskColumns = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!new Set(taskColumns.map((column) => column.name)).has("estimated_cost_cents")) database.exec("ALTER TABLE tasks ADD COLUMN estimated_cost_cents INTEGER NOT NULL DEFAULT 0");
  database.prepare("UPDATE tasks SET status = 'human_review' WHERE lower(replace(replace(status, ' ', '_'), '-', '_')) IN ('agent_review', 'in_review', 'human_review', 'review')").run();

  const projectColumns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!new Set(projectColumns.map((column) => column.name)).has("is_demo")) database.exec("ALTER TABLE projects ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0");

  seedDatabase(database);
  reconcileProjects(database);
  return database;
}

function seedDatabase(database: Database.Database) {
  const projectCount = database.prepare("SELECT COUNT(*) as count FROM projects").get() as { count: number };
  if (projectCount.count > 0) return;

  const now = new Date();
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60000).toISOString();
  const projectInsert = database.prepare(`
    INSERT OR IGNORE INTO projects (id, name, full_name, description, initials, accent, local_path, default_branch, github_project_id, github_project_url, is_demo, status, last_synced_at)
    VALUES (@id, @name, @fullName, @description, @initials, @accent, @localPath, @defaultBranch, @githubProjectId, @githubProjectUrl, @isDemo, @status, @lastSyncedAt)
  `);
  const taskInsert = database.prepare(`
    INSERT OR IGNORE INTO tasks (id, project_id, issue_number, title, description, status, priority, labels_json, assignee, agent_state, current_summary, branch_name, pr_url, github_url, updated_at, created_at)
    VALUES (@id, @projectId, @issueNumber, @title, @description, @status, @priority, @labelsJson, @assignee, @agentState, @currentSummary, @branchName, @prUrl, @githubUrl, @updatedAt, @createdAt)
  `);

  projectInsert.run({
    id: "project-control-plane",
    name: "Control Plane",
    fullName: "maxlee/project-agent-control-plane",
    description: "The local command center for every repository and agent run.",
    initials: "CP",
    accent: "#c9ff6b",
    localPath: "~/Documents/Repos/project-agent-control-plane",
    defaultBranch: "main",
    githubProjectId: "PVT_kwDOB-demo",
    githubProjectUrl: "https://github.com/users/maxlee/projects/1",
    isDemo: 1,
    status: "connected",
    lastSyncedAt: minutesAgo(2),
  });
  projectInsert.run({
    id: "project-job-hopper",
    name: "Job Hopper",
    fullName: "maxlee/job-hopper",
    description: "Job analysis, skill extraction, and personalised learning plans.",
    initials: "JH",
    accent: "#73d7ff",
    localPath: "~/Documents/Repos/job-hopper",
    defaultBranch: "main",
    githubProjectId: "PVT_kwDOB-demo-2",
    githubProjectUrl: "https://github.com/users/maxlee/projects/2",
    isDemo: 1,
    status: "connected",
    lastSyncedAt: minutesAgo(11),
  });

  const tasks = [
    {
      id: "task-live-overview",
      projectId: "project-control-plane",
      issueNumber: null,
      title: "Make the overview surface recent agent activity",
      description: "Aggregate the last meaningful checkpoint from every repository into one glanceable feed.",
      status: "ready",
      priority: 1,
      labels: ["product", "observability"],
      assignee: "Agent",
      agentState: "idle",
      currentSummary: "Demo sample only. Start a task to create a real agent run.",
      branchName: "agent/12-live-overview",
      prUrl: null,
      githubUrl: null,
      updatedAt: minutesAgo(3),
      createdAt: minutesAgo(94),
    },
    {
      id: "task-github-projects",
      projectId: "project-control-plane",
      issueNumber: null,
      title: "Connect a repository to GitHub Projects V2",
      description: "Persist project and field IDs so status sync remains stable when display names change.",
      status: "ready",
      priority: 2,
      labels: ["integration", "github"],
      assignee: "You",
      agentState: "idle",
      currentSummary: "Ready to start. The board contract and field mapping need an implementation pass.",
      branchName: null,
      prUrl: null,
      githubUrl: null,
      updatedAt: minutesAgo(19),
      createdAt: minutesAgo(160),
    },
    {
      id: "task-worktree-safety",
      projectId: "project-control-plane",
      issueNumber: null,
      title: "Add isolated worktree lifecycle",
      description: "Create a deterministic worktree for every task and preserve it after a failed run.",
      status: "human_review",
      priority: 1,
      labels: ["runtime", "safety"],
      assignee: "You",
      agentState: "succeeded",
      currentSummary: "The lifecycle contract is ready for a human review before wiring real Git commands.",
      branchName: "agent/7-worktree-safety",
      prUrl: "https://github.com/maxlee/project-agent-control-plane/pull/4",
      githubUrl: null,
      updatedAt: minutesAgo(48),
      createdAt: minutesAgo(360),
    },
    {
      id: "task-cline-adapter",
      projectId: "project-control-plane",
      issueNumber: null,
      title: "Translate ClineCore events into run events",
      description: "Keep the dashboard independent from Cline's event vocabulary and preserve redacted summaries.",
      status: "inbox",
      priority: 3,
      labels: ["cline", "architecture"],
      assignee: null,
      agentState: "idle",
      currentSummary: "New input. Add a workflow contract and decide which events deserve a GitHub checkpoint.",
      branchName: null,
      prUrl: null,
      githubUrl: null,
      updatedAt: minutesAgo(6),
      createdAt: minutesAgo(6),
    },
    {
      id: "task-learning-plan",
      projectId: "project-job-hopper",
      issueNumber: 21,
      title: "Add exportable progress snapshots",
      description: "Save a useful summary of an analysis run so it can be picked up later.",
      status: "human_review",
      priority: 2,
      labels: ["feature", "markdown"],
      assignee: "Agent",
      agentState: "succeeded",
      currentSummary: "Implemented and waiting for a quick review of the generated markdown format.",
      branchName: "agent/21-progress-snapshots",
      prUrl: "https://github.com/maxlee/job-hopper/pull/8",
      githubUrl: "https://github.com/maxlee/job-hopper/issues/21",
      updatedAt: minutesAgo(76),
      createdAt: minutesAgo(460),
    },
    {
      id: "task-scraper-timeout",
      projectId: "project-job-hopper",
      issueNumber: 18,
      title: "Handle slow job pages without hanging the worker",
      description: "Add an explicit timeout and a visible recovery path for pages that never finish loading.",
      status: "blocked",
      priority: 1,
      labels: ["bug", "reliability"],
      assignee: "You",
      agentState: "failed",
      currentSummary: "Blocked on choosing a safe timeout for JS-heavy job boards.",
      branchName: null,
      prUrl: null,
      githubUrl: "https://github.com/maxlee/job-hopper/issues/18",
      updatedAt: minutesAgo(132),
      createdAt: minutesAgo(590),
    },
  ];

  const transaction = database.transaction(() => {
    for (const task of tasks) {
      taskInsert.run({ ...task, labelsJson: JSON.stringify(task.labels) });
    }
  });
  transaction();

  database.prepare(`
    INSERT OR IGNORE INTO runs (id, task_id, project_id, mode, status, session_id, branch_name, workspace_path, progress, current_activity, started_at)
    VALUES ('run-seed-live-overview', 'task-live-overview', 'project-control-plane', 'start', 'completed', NULL, 'agent/12-live-overview', 'project-control-plane/worktrees/task-live-overview', 100, 'Demo sample completed — no agent session was started.', ?)
  `).run(minutesAgo(3));
  database.prepare(`
    INSERT OR IGNORE INTO run_events (id, run_id, type, message, detail, created_at)
    VALUES ('event-seed-live-overview', 'run-seed-live-overview', 'checkpoint', 'Checkpoint saved', 'The activity feed projection is being shaped from meaningful agent updates.', ?)
  `).run(minutesAgo(3));

  const activityInsert = database.prepare(`
    INSERT OR IGNORE INTO activity (id, project_id, task_id, run_id, type, title, detail, tone, created_at)
    VALUES (@id, @projectId, @taskId, @runId, @type, @title, @detail, @tone, @createdAt)
  `);
  activityInsert.run({
    id: "activity-seed-1",
    projectId: "project-control-plane",
    taskId: "task-live-overview",
    runId: null,
    type: "checkpoint",
    title: "Agent checkpoint · Live overview",
    detail: "Mapped the cross-project activity feed and identified the first summary boundary.",
    tone: "amber",
    createdAt: minutesAgo(3),
  });
  activityInsert.run({
    id: "activity-seed-2",
    projectId: "project-control-plane",
    taskId: "task-worktree-safety",
    runId: null,
    type: "pull_request",
    title: "PR ready for human review",
    detail: "agent/7-worktree-safety · 4 changed files · 12 checks passed",
    tone: "violet",
    createdAt: minutesAgo(48),
  });
  activityInsert.run({
    id: "activity-seed-3",
    projectId: "project-job-hopper",
    taskId: "task-learning-plan",
    runId: null,
    type: "completed",
    title: "Learning plan export completed",
    detail: "Markdown snapshot is attached to PR #8.",
    tone: "green",
    createdAt: minutesAgo(76),
  });
}

function reconcileProjects(database: Database.Database) {
  const reconcile = database.transaction(() => {
    database.prepare("UPDATE projects SET is_demo = 1 WHERE id IN ('project-control-plane', 'project-job-hopper')").run();
    database.prepare("UPDATE tasks SET status = 'ready', agent_state = 'idle', current_summary = 'Demo sample only. Start a task to create a real agent run.' WHERE id = 'task-live-overview'").run();
    database.prepare("UPDATE runs SET status = 'completed', session_id = NULL, progress = 100, current_activity = 'Demo sample completed — no agent session was started.', cost_source = 'unavailable', finished_at = COALESCE(finished_at, ?) WHERE id = 'run-seed-live-overview'").run(new Date().toISOString());
    const rows = database.prepare("SELECT id, local_path, is_demo FROM projects ORDER BY id").all() as Array<{ id: string; local_path: string; is_demo: number }>;
    const groups = new Map<string, Array<{ id: string; is_demo: number }>>();
    for (const row of rows) {
      const key = normalizeLocalPath(row.local_path);
      const group = groups.get(key) ?? [];
      group.push({ id: row.id, is_demo: Number(row.is_demo) });
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const canonical = group.find((row) => row.is_demo === 0) ?? group[0];
      for (const duplicate of group) {
        if (duplicate.id === canonical.id) continue;
        database.prepare("UPDATE tasks SET project_id = ? WHERE project_id = ?").run(canonical.id, duplicate.id);
        database.prepare("UPDATE runs SET project_id = ? WHERE project_id = ?").run(canonical.id, duplicate.id);
        database.prepare("UPDATE activity SET project_id = ? WHERE project_id = ?").run(canonical.id, duplicate.id);
        database.prepare("DELETE FROM projects WHERE id = ?").run(duplicate.id);
      }
    }
  });
  reconcile();
}

export const db = globalThis.controlPlaneDb ?? createDatabase();
if (process.env.NODE_ENV !== "production") globalThis.controlPlaneDb = db;