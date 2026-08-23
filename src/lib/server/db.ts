import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeLocalPath } from "./paths";

declare global {
  // eslint-disable-next-line no-var
  var controlPlaneDb: Database.Database | undefined;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? ".data");
const databasePath = path.join(dataDir, "control-plane.db");

export const LATEST_SCHEMA_VERSION = 4;

export const DEFAULT_RETENTION_DAYS = {
  runEvents: 90,
  activity: 180,
  completedRuns: 365,
  remoteDeliveries: 180,
} as const;

const MAX_MIGRATION_BACKUPS = 8;
const MIGRATION_LOCK_RETRIES = 20;

export type RetentionPolicy = {
  runEvents: number;
  activity: number;
  completedRuns: number;
  remoteDeliveries: number;
};

export type SchemaMigration = {
  version: number;
  name: string;
  up: (database: Database.Database) => void;
};

function positiveIntegerFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function waitForDatabaseLock() {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, 50);
}

function setJournalMode(database: Database.Database) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MIGRATION_LOCK_RETRIES; attempt += 1) {
    try {
      database.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/database is locked|database table is locked/i.test(error.message)) throw error;
      waitForDatabaseLock();
    }
  }
  throw lastError;
}

export function getRetentionPolicy(): RetentionPolicy {
  return {
    runEvents: positiveIntegerFromEnv("RUN_EVENT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS.runEvents),
    activity: positiveIntegerFromEnv("ACTIVITY_RETENTION_DAYS", DEFAULT_RETENTION_DAYS.activity),
    completedRuns: positiveIntegerFromEnv("COMPLETED_RUN_RETENTION_DAYS", DEFAULT_RETENTION_DAYS.completedRuns),
    remoteDeliveries: positiveIntegerFromEnv("REMOTE_DELIVERY_RETENTION_DAYS", DEFAULT_RETENTION_DAYS.remoteDeliveries),
  };
}

function hasTable(database: Database.Database, tableName: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function ensureColumn(database: Database.Database, tableName: string, columnName: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!new Set(columns.map((column) => column.name)).has(columnName)) database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

function createBaseSchema(database: Database.Database) {
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
      status TEXT NOT NULL DEFAULT 'connected',
      readiness_json TEXT,
      last_synced_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      issue_number INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
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
      error TEXT
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
    CREATE TABLE IF NOT EXISTS active_run_claims (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      execution_mode TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
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
}

function applyCurrentColumns(database: Database.Database) {
  ensureColumn(database, "runs", "execution_mode", "execution_mode TEXT NOT NULL DEFAULT 'demo'");
  ensureColumn(database, "runs", "commit_sha", "commit_sha TEXT");
  ensureColumn(database, "runs", "changed_files_json", "changed_files_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "runs", "checks_json", "checks_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "runs", "provider_id", "provider_id TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "runs", "model_id", "model_id TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "runs", "reasoning_effort", "reasoning_effort TEXT");
  ensureColumn(database, "runs", "input_tokens", "input_tokens INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "runs", "output_tokens", "output_tokens INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "runs", "cache_read_tokens", "cache_read_tokens INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "runs", "cache_write_tokens", "cache_write_tokens INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "runs", "actual_cost_micros", "actual_cost_micros INTEGER");
  ensureColumn(database, "runs", "cost_source", "cost_source TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(database, "runs", "owner_id", "owner_id TEXT");
  ensureColumn(database, "runs", "lease_heartbeat_at", "lease_heartbeat_at TEXT");
  ensureColumn(database, "runs", "lease_expires_at", "lease_expires_at TEXT");
  ensureColumn(database, "runs", "current_stage", "current_stage TEXT NOT NULL DEFAULT 'configuration'");
  ensureColumn(database, "runs", "recovery_status", "recovery_status TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(database, "runs", "recovery_reason", "recovery_reason TEXT");
  ensureColumn(database, "tasks", "estimated_cost_cents", "estimated_cost_cents INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "projects", "is_demo", "is_demo INTEGER NOT NULL DEFAULT 0");
  database.prepare("UPDATE runs SET cost_source = 'unavailable' WHERE cost_source = 'pending' AND status IN ('completed', 'failed', 'stopped')").run();
  database.prepare("UPDATE tasks SET status = 'human_review' WHERE lower(replace(replace(status, ' ', '_'), '-', '_')) IN ('agent_review', 'in_review', 'human_review', 'review')").run();

  // These indexes reference columns that are absent from pre-lease databases.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_active_run_claims_project ON active_run_claims(project_id, execution_mode);
    CREATE INDEX IF NOT EXISTS idx_active_run_claims_lease ON active_run_claims(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_runs_lease ON runs(status, lease_expires_at);
  `);
}

function applyRetentionSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS remote_deliveries (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_task_created ON activity(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_run_created ON activity(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_retention ON runs(status, finished_at);
    CREATE INDEX IF NOT EXISTS idx_remote_deliveries_retention ON remote_deliveries(status, created_at);
  `);
}

function applyReadinessSchema(database: Database.Database) {
  ensureColumn(database, "projects", "readiness_json", "readiness_json TEXT");
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  { version: 1, name: "base-schema", up: createBaseSchema },
  { version: 2, name: "current-columns-and-leases", up: applyCurrentColumns },
  { version: 3, name: "retention-metadata-and-history-indexes", up: applyRetentionSchema },
  { version: 4, name: "repository-readiness", up: applyReadinessSchema },
];

export function getAppliedSchemaVersion(database: Database.Database) {
  if (!hasTable(database, "schema_migrations")) return 0;
  const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
  return Number(row.version);
}

export function getAppliedMigrations(database: Database.Database) {
  if (!hasTable(database, "schema_migrations")) return [] as Array<{ version: number; name: string; appliedAt: string }>;
  return (database.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string; applied_at: string }>)
    .map((row) => ({ version: Number(row.version), name: row.name, appliedAt: row.applied_at }));
}

function validateMigrations(migrations: readonly SchemaMigration[]) {
  const versions = migrations.map((migration) => migration.version);
  if (versions.some((version) => !Number.isInteger(version) || version < 1) || new Set(versions).size !== versions.length) {
    throw new Error("SQLite migration registry contains invalid or duplicate versions.");
  }
  for (let index = 1; index < versions.length; index += 1) {
    if (versions[index] !== versions[index - 1] + 1) throw new Error("SQLite migrations must be declared as a contiguous ascending sequence.");
  }
}

export class DatabaseMigrationError extends Error {
  readonly version: number;
  readonly backupPath: string | null;

  constructor(version: number, name: string, cause: unknown, backupPath: string | null) {
    super(`SQLite migration ${version} (${name}) failed${backupPath ? `; restore ${backupPath} before retrying` : "."}`, { cause });
    this.name = "DatabaseMigrationError";
    this.version = version;
    this.backupPath = backupPath;
  }
}

export function runMigrations(database: Database.Database, migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS, backupPath: string | null = null) {
  validateMigrations(migrations);
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = getAppliedMigrations(database);
  if (applied.length > migrations.length || applied.some((record, index) => record.version !== migrations[index]?.version || record.name !== migrations[index]?.name)) {
    throw new Error("SQLite migration history is incompatible with the migration registry; restore the last verified backup.");
  }
  for (const migration of migrations) {
    const appliedMigration = database.prepare("SELECT version, name FROM schema_migrations WHERE version = ?").get(migration.version) as { version: number; name: string } | undefined;
    if (appliedMigration) {
      if (appliedMigration.name !== migration.name) throw new Error(`SQLite migration ${migration.version} has a different recorded name.`);
      continue;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < MIGRATION_LOCK_RETRIES; attempt += 1) {
      try {
        database.transaction(() => {
          const concurrentMigration = database.prepare("SELECT name FROM schema_migrations WHERE version = ?").get(migration.version) as { name: string } | undefined;
          if (concurrentMigration) {
            if (concurrentMigration.name !== migration.name) throw new Error(`SQLite migration ${migration.version} has a different recorded name.`);
            return;
          }
          migration.up(database);
          database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
            .run(migration.version, migration.name, new Date().toISOString());
        })();
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error) || !/database is locked|database table is locked/i.test(error.message)) break;
        waitForDatabaseLock();
      }
    }
    if (lastError) {
      throw new DatabaseMigrationError(migration.version, migration.name, lastError, backupPath);
    }
  }
  return getAppliedSchemaVersion(database);
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createDatabaseBackup(database: Database.Database, backupDirectory = path.join(dataDir, "backups")) {
  fs.mkdirSync(backupDirectory, { recursive: true });
  let lastError: unknown;
  for (let attempt = 0; attempt < MIGRATION_LOCK_RETRIES; attempt += 1) {
    const filename = `control-plane.db.before-migration-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}-${randomUUID()}.sqlite`;
    const backupPath = path.join(backupDirectory, filename);
    try {
      database.pragma("wal_checkpoint(TRUNCATE)");
      database.exec(`VACUUM INTO ${sqlString(backupPath)}`);
      return backupPath;
    } catch (error) {
      lastError = error;
      fs.rmSync(backupPath, { force: true });
      if (!(error instanceof Error) || !/database is locked|database table is locked/i.test(error.message)) throw error;
      waitForDatabaseLock();
    }
  }
  throw lastError;
}

export function pruneDatabaseBackups(backupDirectory = path.join(dataDir, "backups")) {
  if (!fs.existsSync(backupDirectory)) return;
  const backups = fs.readdirSync(backupDirectory)
    .filter((filename) => filename.startsWith("control-plane.db.before-migration-") && filename.endsWith(".sqlite"))
    .map((filename) => ({ filename, mtime: fs.statSync(path.join(backupDirectory, filename)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  for (const backup of backups.slice(MAX_MIGRATION_BACKUPS)) fs.rmSync(path.join(backupDirectory, backup.filename), { force: true });
}

export type RetentionCleanupResult = {
  runEvents: number;
  activity: number;
  completedRuns: number;
  remoteDeliveries: number;
};

function retentionCutoff(days: number, now: Date) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function runRetentionCleanup(database: Database.Database, policy = getRetentionPolicy(), now = new Date()): RetentionCleanupResult {
  const cleanup = database.transaction(() => {
    const eventCutoff = retentionCutoff(policy.runEvents, now);
    const activityCutoff = retentionCutoff(policy.activity, now);
    const runCutoff = retentionCutoff(policy.completedRuns, now);
    const deliveryCutoff = retentionCutoff(policy.remoteDeliveries, now);
    const runEvents = database.prepare(`
      DELETE FROM run_events
      WHERE created_at < ?
        AND EXISTS (
          SELECT 1 FROM runs r JOIN tasks t ON t.id = r.task_id
          WHERE r.id = run_events.run_id
            AND r.status = 'completed'
            AND r.workspace_path IS NULL
            AND t.status NOT IN ('in_progress', 'human_review')
            AND t.agent_state NOT IN ('running', 'failed')
            AND NOT EXISTS (SELECT 1 FROM active_run_claims c WHERE c.run_id = r.id)
        )
    `).run(eventCutoff).changes;
    const activity = database.prepare(`
      DELETE FROM activity
      WHERE created_at < ?
        AND (run_id IS NULL OR NOT EXISTS (SELECT 1 FROM active_run_claims c WHERE c.run_id = activity.run_id))
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = activity.task_id AND (t.status IN ('in_progress', 'human_review') OR t.agent_state IN ('running', 'failed')))
        AND NOT EXISTS (
          SELECT 1 FROM runs r JOIN tasks t ON t.id = r.task_id
          WHERE r.id = activity.run_id
            AND (r.status IN ('queued', 'running', 'failed', 'stopped') OR r.workspace_path IS NOT NULL OR t.status IN ('in_progress', 'human_review') OR t.agent_state IN ('running', 'failed'))
        )
    `).run(activityCutoff).changes;
    const completedRuns = database.prepare(`
      DELETE FROM runs
      WHERE status = 'completed' AND finished_at IS NOT NULL AND finished_at < ?
        AND workspace_path IS NULL
        AND NOT EXISTS (SELECT 1 FROM active_run_claims c WHERE c.run_id = runs.id)
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = runs.task_id AND (t.status IN ('in_progress', 'human_review') OR t.agent_state IN ('running', 'failed')))
        AND NOT EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = runs.id)
        AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.run_id = runs.id)
    `).run(runCutoff).changes;
    const remoteDeliveries = database.prepare(`
      DELETE FROM remote_deliveries
      WHERE created_at < ?
        AND status IN ('delivered', 'succeeded', 'sent', 'failed', 'cancelled')
        AND (run_id IS NULL OR NOT EXISTS (SELECT 1 FROM active_run_claims c WHERE c.run_id = remote_deliveries.run_id))
        AND NOT EXISTS (
          SELECT 1 FROM runs r JOIN tasks t ON t.id = r.task_id
          WHERE r.id = remote_deliveries.run_id
            AND (r.status IN ('queued', 'running', 'failed', 'stopped') OR r.workspace_path IS NOT NULL OR t.status IN ('in_progress', 'human_review') OR t.agent_state IN ('running', 'failed'))
        )
    `).run(deliveryCutoff).changes;
    return { runEvents, activity, completedRuns, remoteDeliveries };
  });
  return cleanup();
}

function createDatabase() {
  fs.mkdirSync(dataDir, { recursive: true });
  const hadDatabase = fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;
  const database = new Database(databasePath);
  // Next may evaluate route modules in parallel during build/startup. Give another
  // initializer time to finish the schema/seed transaction instead of failing with SQLITE_BUSY.
  database.pragma("busy_timeout = 10000");
  try {
    setJournalMode(database);
    const pendingMigrations = getAppliedSchemaVersion(database) < LATEST_SCHEMA_VERSION;
    let backupPath: string | null = null;
    if (hadDatabase && pendingMigrations) {
      try {
        backupPath = createDatabaseBackup(database);
      } catch (error) {
        throw new Error("SQLite migration backup failed; no schema changes were applied. Check the local data directory and retry.", { cause: error });
      }
    }
    runMigrations(database, SCHEMA_MIGRATIONS, backupPath);

  seedDatabase(database);
  reconcileProjects(database);
  database.prepare(`
    INSERT OR IGNORE INTO active_run_claims (task_id, run_id, project_id, execution_mode, claimed_at, lease_expires_at)
    SELECT r.task_id, r.id, r.project_id, r.execution_mode, r.started_at, '1970-01-01T00:00:00.000Z'
    FROM runs r
    WHERE r.status IN ('queued', 'running')
      AND NOT EXISTS (SELECT 1 FROM active_run_claims c WHERE c.task_id = r.task_id)
      AND r.id = (SELECT newest.id FROM runs newest WHERE newest.task_id = r.task_id AND newest.status IN ('queued', 'running') ORDER BY newest.started_at DESC, newest.id DESC LIMIT 1)
  `).run();
    try {
      runRetentionCleanup(database);
    } catch {
      // Retention is maintenance, not a boot prerequisite. A later startup can retry it.
    }
    pruneDatabaseBackups();
  return database;
  } catch (error) {
    database.close();
    throw error;
  }
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
        database.prepare("UPDATE active_run_claims SET project_id = ? WHERE project_id = ?").run(canonical.id, duplicate.id);
        database.prepare("DELETE FROM projects WHERE id = ?").run(duplicate.id);
      }
    }
  });
  reconcile();
}

export const db = globalThis.controlPlaneDb ?? createDatabase();
if (process.env.NODE_ENV !== "production") globalThis.controlPlaneDb = db;