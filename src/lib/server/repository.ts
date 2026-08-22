import { randomUUID } from "node:crypto";
import { db } from "./db";
import { redactSecrets } from "./redaction";
import { normalizeLocalPath } from "./paths";
import { hasActiveClineSession } from "./cline";
import { normalizeRunEventType } from "../domain";
import type { ActivityItem, AgentRun, DashboardData, Project, ReasoningEffort, RunCheck, RunCostSource, RunEvent, RunEventType, Task, TaskCostStatus, TaskStatus } from "../domain";
import { getReasoningCapabilitySync, validateReasoningEffortSync } from "./reasoning";
import { isReasoningEffort } from "../domain";

type ProjectRow = Record<string, unknown>;
type TaskRow = Record<string, unknown>;
type RunRow = Record<string, unknown>;
type ActivityRow = Record<string, unknown>;

const isoNow = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? []);
const fromJson = (value: unknown): string[] => {
  try {
    return JSON.parse(String(value ?? "[]")) as string[];
  } catch {
    return [];
  }
};

export type DeduplicationClaim =
  | { kind: "new" }
  | { kind: "replay"; response: unknown; status: number }
  | { kind: "conflict" }
  | { kind: "in_progress" };

export function claimIdempotencyKey(key: string, operation: string, fingerprint: string): DeduplicationClaim {
  const now = isoNow();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO request_deduplication (idempotency_key, operation, fingerprint, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(key, operation, fingerprint, now);
  const row = db.prepare("SELECT operation, fingerprint, status, response_json, response_status FROM request_deduplication WHERE idempotency_key = ?").get(key) as Record<string, unknown>;
  if (row.operation !== operation || row.fingerprint !== fingerprint) return { kind: "conflict" };
  if (insert.changes === 1) return { kind: "new" };
  if (row.status === "completed" && typeof row.response_json === "string" && Number.isInteger(Number(row.response_status))) {
    return { kind: "replay", response: JSON.parse(row.response_json), status: Number(row.response_status) };
  }
  return { kind: "in_progress" };
}

export function completeIdempotencyKey(key: string, operation: string, fingerprint: string, response: unknown, status: number) {
  db.prepare(`
    UPDATE request_deduplication
    SET status = 'completed', response_json = ?, response_status = ?, completed_at = ?
    WHERE idempotency_key = ? AND operation = ? AND fingerprint = ?
  `).run(JSON.stringify(response), status, isoNow(), key, operation, fingerprint);
}

export function mapProject(row: ProjectRow): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    fullName: String(row.full_name),
    description: String(row.description ?? ""),
    initials: String(row.initials),
    accent: String(row.accent),
    localPath: String(row.local_path),
    defaultBranch: String(row.default_branch),
    githubProjectId: row.github_project_id ? String(row.github_project_id) : null,
    githubProjectUrl: row.github_project_url ? String(row.github_project_url) : null,
    isDemo: Number(row.is_demo) === 1,
    status: row.status as Project["status"],
    lastSyncedAt: String(row.last_synced_at),
    activeAgents: Number(row.active_agents ?? 0),
    openTasks: Number(row.open_tasks ?? 0),
    openPrs: Number(row.open_prs ?? 0),
  };
}

export function mapTask(row: TaskRow): Task {
  const runCount = Number(row.run_count ?? 0);
  const pricedRunCount = Number(row.priced_run_count ?? 0);
  const pendingRunCount = Number(row.pending_run_count ?? 0);
  const actualCostMicros = row.actual_cost_micros === null || row.actual_cost_micros === undefined ? null : Number(row.actual_cost_micros);
  const actualCostStatus: TaskCostStatus = runCount === 0
    ? "not_started"
    : pendingRunCount > 0
      ? "pending"
      : pricedRunCount === runCount
        ? "available"
        : pricedRunCount > 0
          ? "partial"
          : "unavailable";
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    issueNumber: row.issue_number === null ? null : Number(row.issue_number),
    title: String(row.title),
    description: String(row.description ?? ""),
    estimatedCostUsd: Number(row.estimated_cost_cents ?? 0) / 100,
    actualCostUsd: actualCostMicros === null ? null : actualCostMicros / 1_000_000,
    actualCostStatus,
    status: row.status as TaskStatus,
    priority: Number(row.priority) as Task["priority"],
    labels: fromJson(row.labels_json),
    assignee: row.assignee === null ? null : (String(row.assignee) as Task["assignee"]),
    agentState: row.agent_state as Task["agentState"],
    currentSummary: String(row.current_summary ?? ""),
    branchName: row.branch_name ? String(row.branch_name) : null,
    prUrl: row.pr_url ? String(row.pr_url) : null,
    githubUrl: row.github_url ? String(row.github_url) : null,
    updatedAt: String(row.updated_at),
    createdAt: String(row.created_at),
  };
}

export function mapRun(row: RunRow): AgentRun {
  const status = row.status as AgentRun["status"];
  const executionMode = row.execution_mode === "live" ? "live" : "demo";
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    projectId: String(row.project_id),
    mode: row.mode as AgentRun["mode"],
    status,
    sessionId: row.session_id ? String(row.session_id) : null,
    branchName: row.branch_name ? String(row.branch_name) : null,
    workspacePath: row.workspace_path ? String(row.workspace_path) : null,
    progress: Number(row.progress),
    currentActivity: String(row.current_activity),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    error: row.error ? String(row.error) : null,
    executionMode,
    providerId: String(row.provider_id ?? ""),
    modelId: String(row.model_id ?? ""),
    reasoningEffort: isReasoningEffort(row.reasoning_effort) ? row.reasoning_effort : null,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    actualCostUsd: row.actual_cost_micros === null || row.actual_cost_micros === undefined ? null : Number(row.actual_cost_micros) / 1_000_000,
    costSource: row.cost_source as RunCostSource,
    isActive: executionMode === "live" && (status === "queued" || status === "running") && hasActiveClineSession(String(row.id)),
    commitSha: row.commit_sha ? String(row.commit_sha) : null,
    changedFiles: fromJson(row.changed_files_json),
    checks: fromJson(row.checks_json) as unknown as RunCheck[],
  };
}

export function mapActivity(row: ActivityRow): ActivityItem {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id ? String(row.task_id) : null,
    runId: row.run_id ? String(row.run_id) : null,
    type: String(row.type),
    title: String(row.title),
    detail: row.detail ? String(row.detail) : null,
    tone: row.tone as ActivityItem["tone"],
    createdAt: String(row.created_at),
  };
}

export function getDashboard(): DashboardData {
  const executionMode = process.env.EXECUTION_MODE === "live" ? "live" : "demo";
  const projectRows = db.prepare(`
    SELECT p.*, COUNT(DISTINCT CASE WHEN t.status NOT IN ('done') THEN t.id END) AS open_tasks,
      COUNT(DISTINCT CASE WHEN t.pr_url IS NOT NULL AND t.status != 'done' THEN t.id END) AS open_prs
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    WHERE (? = 'demo' OR p.is_demo = 0)
    GROUP BY p.id ORDER BY p.name
  `).all(executionMode);
  const tasks = db.prepare("SELECT t.*, SUM(r.actual_cost_micros) AS actual_cost_micros, COUNT(r.id) AS run_count, COUNT(r.actual_cost_micros) AS priced_run_count, SUM(CASE WHEN r.cost_source = 'pending' THEN 1 ELSE 0 END) AS pending_run_count FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN runs r ON r.task_id = t.id WHERE (? = 'demo' OR p.is_demo = 0) GROUP BY t.id ORDER BY t.updated_at DESC").all(executionMode).map((row) => mapTask(row as TaskRow));
  const runs = db.prepare("SELECT r.* FROM runs r JOIN projects p ON p.id = r.project_id WHERE (? = 'demo' OR p.is_demo = 0) ORDER BY r.started_at DESC LIMIT 40").all(executionMode).map((row) => mapRun(row as RunRow));
  const activeLiveRuns = runs.filter((run) => run.isActive);
  const activeCounts = new Map<string, number>();
  for (const run of activeLiveRuns) activeCounts.set(run.projectId, (activeCounts.get(run.projectId) ?? 0) + 1);
  const projects = projectRows.map((row) => {
    const project = mapProject(row as ProjectRow);
    project.activeAgents = activeCounts.get(project.id) ?? 0;
    return project;
  });
  const activity = db.prepare("SELECT a.* FROM activity a JOIN projects p ON p.id = a.project_id WHERE (? = 'demo' OR p.is_demo = 0) ORDER BY a.created_at DESC LIMIT 40").all(executionMode).map((row) => mapActivity(row as ActivityRow));
  const visibleRunIds = new Set(runs.map((run) => run.id));
  const runEvents = getRunEvents().filter((event) => visibleRunIds.has(event.runId));
  const liveReady = Boolean(process.env.CLINE_API_KEY && process.env.GITHUB_TOKEN);
  return {
    projects,
    tasks,
    runs,
    activity,
    runEvents,
    runtime: {
      executionMode,
      liveReady,
      reason: executionMode === "demo"
        ? "Demo mode is enabled. Runs are simulated and never touch a repository."
        : liveReady
          ? null
          : "Live mode needs CLINE_API_KEY and GITHUB_TOKEN before it can modify repositories.",
      reasoning: getReasoningCapabilitySync(process.env.CLINE_PROVIDER_ID ?? "anthropic", process.env.CLINE_MODEL_ID ?? "claude-sonnet-4-5"),
    },
  };
}

export function getTask(taskId: string) {
  const row = db.prepare("SELECT t.*, SUM(r.actual_cost_micros) AS actual_cost_micros, COUNT(r.id) AS run_count, COUNT(r.actual_cost_micros) AS priced_run_count, SUM(CASE WHEN r.cost_source = 'pending' THEN 1 ELSE 0 END) AS pending_run_count FROM tasks t LEFT JOIN runs r ON r.task_id = t.id WHERE t.id = ? GROUP BY t.id").get(taskId);
  return row ? mapTask(row as TaskRow) : null;
}

export function getTaskByIssue(projectId: string, issueNumber: number) {
  const row = db.prepare("SELECT t.*, SUM(r.actual_cost_micros) AS actual_cost_micros, COUNT(r.id) AS run_count, COUNT(r.actual_cost_micros) AS priced_run_count, SUM(CASE WHEN r.cost_source = 'pending' THEN 1 ELSE 0 END) AS pending_run_count FROM tasks t LEFT JOIN runs r ON r.task_id = t.id WHERE t.project_id = ? AND t.issue_number = ? GROUP BY t.id").get(projectId, issueNumber);
  return row ? mapTask(row as TaskRow) : null;
}

export function getTasksByProject(projectId: string) {
  return db.prepare("SELECT t.*, SUM(r.actual_cost_micros) AS actual_cost_micros, COUNT(r.id) AS run_count, COUNT(r.actual_cost_micros) AS priced_run_count, SUM(CASE WHEN r.cost_source = 'pending' THEN 1 ELSE 0 END) AS pending_run_count FROM tasks t LEFT JOIN runs r ON r.task_id = t.id WHERE t.project_id = ? GROUP BY t.id ORDER BY t.updated_at DESC").all(projectId).map((row) => mapTask(row as TaskRow));
}

export function updateTaskIssue(taskId: string, issueNumber: number, githubUrl: string) {
  db.prepare("UPDATE tasks SET issue_number = ?, github_url = ?, updated_at = ? WHERE id = ?")
    .run(issueNumber, githubUrl, isoNow(), taskId);
  return getTask(taskId);
}

export function getRun(runId: string) {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  return row ? mapRun(row as RunRow) : null;
}

export function getProject(projectId: string) {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  return row ? mapProject(row as ProjectRow) : null;
}

export function createProject(input: { fullName: string; localPath: string; description?: string; githubProjectId?: string }) {
  const normalizedPath = normalizeLocalPath(input.localPath);
  const [owner, repo] = input.fullName.split("/");
  const projectName = repo || input.fullName;
  const displayName = projectName.replace(/[-_]/g, " ");
  const initials = projectName.slice(0, 2).toUpperCase();
  const existingRow = db.prepare("SELECT * FROM projects WHERE full_name = ?").get(input.fullName) as ProjectRow | undefined
    ?? (db.prepare("SELECT * FROM projects").all() as ProjectRow[]).find((row) => normalizeLocalPath(String(row.local_path)) === normalizedPath);
  if (existingRow) {
    if (Number(existingRow.is_demo) || input.githubProjectId?.trim()) {
      db.prepare("UPDATE projects SET name = ?, full_name = ?, description = ?, initials = ?, local_path = ?, github_project_id = ?, is_demo = 0, status = 'attention', last_synced_at = ? WHERE id = ?")
        .run(displayName, input.fullName, input.description ?? String(existingRow.description ?? ""), initials, input.localPath, input.githubProjectId?.trim() || String(existingRow.github_project_id ?? "") || null, isoNow(), existingRow.id);
    }
    return mapProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(existingRow.id) as ProjectRow);
  }
  const now = isoNow();
  const name = projectName;
  const id = `project-${randomUUID()}`;
  db.prepare(`
    INSERT INTO projects (id, name, full_name, description, initials, accent, local_path, default_branch, github_project_id, status, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'main', ?, 'attention', ?)
  `).run(id, name, input.fullName, input.description ?? `Managed workspace for ${owner ?? "your"}/${name}.`, initials, "#ff9d66", input.localPath, input.githubProjectId?.trim() || null, now);
  addActivity({ projectId: id, type: "project", title: "Repository added", detail: `${input.fullName} is ready to connect to GitHub Projects.`, tone: "cyan" });
  return mapProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow);
}

export function createTask(input: { projectId: string; title: string; description?: string; estimatedCostCents?: number; status?: TaskStatus; priority?: number; labels?: string[]; issueNumber?: number; githubUrl?: string | null }) {
  const now = isoNow();
  const id = `task-${randomUUID()}`;
  db.prepare(`
    INSERT INTO tasks (id, project_id, issue_number, title, description, estimated_cost_cents, status, priority, labels_json, assignee, agent_state, current_summary, github_url, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?, ?)
  `).run(id, input.projectId, input.issueNumber ?? null, input.title, input.description ?? "", input.estimatedCostCents ?? 0, input.status ?? "inbox", input.priority ?? 3, json(input.labels), "New task — ready for context.", input.githubUrl ?? null, now, now);
  addActivity({ projectId: input.projectId, taskId: id, type: "task", title: "Task created", detail: input.title, tone: "cyan" });
  return getTask(id);
}

export function upsertSyncedTask(input: { projectId: string; issueNumber: number; title: string; description: string; status: TaskStatus; labels: string[]; githubUrl: string | null }) {
  const existing = db.prepare("SELECT id FROM tasks WHERE project_id = ? AND issue_number = ?").get(input.projectId, input.issueNumber) as { id?: string } | undefined;
  if (!existing?.id) return createTask(input);
  updateTask(existing.id, { title: input.title, description: input.description, status: input.status, agentState: input.status === "done" ? "idle" : undefined, summary: "Synced from GitHub Projects V2." });
  db.prepare("UPDATE tasks SET labels_json = ?, github_url = ?, updated_at = ? WHERE id = ?").run(json(input.labels), input.githubUrl, isoNow(), existing.id);
  return getTask(existing.id);
}

export function updateTask(taskId: string, input: { status?: TaskStatus; priority?: number; title?: string; description?: string; estimatedCostCents?: number; summary?: string; agentState?: Task["agentState"]; branchName?: string | null; prUrl?: string | null }) {
  const task = getTask(taskId);
  if (!task) return null;
  const provided = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const next = { ...task, ...provided, estimatedCostUsd: input.estimatedCostCents === undefined ? task.estimatedCostUsd : input.estimatedCostCents / 100, updatedAt: isoNow() };
  db.prepare(`
    UPDATE tasks SET title = ?, description = ?, estimated_cost_cents = ?, status = ?, priority = ?, agent_state = ?, current_summary = ?, branch_name = ?, pr_url = ?, updated_at = ? WHERE id = ?
  `).run(next.title, next.description, Math.round(next.estimatedCostUsd * 100), next.status, next.priority, next.agentState, next.currentSummary, next.branchName, next.prUrl, next.updatedAt, taskId);
  return getTask(taskId);
}

export function completeTaskByHuman(taskId: string, summary?: string) {
  const task = getTask(taskId);
  if (!task) return null;
  const completionSummary = summary?.trim() || "Marked done by a human after independent verification.";
  const now = isoNow();
  const complete = db.transaction(() => {
    db.prepare("UPDATE tasks SET status = 'done', agent_state = 'idle', current_summary = ?, updated_at = ? WHERE id = ?")
      .run(completionSummary, now, taskId);
    const existingActivity = db.prepare("SELECT id FROM activity WHERE task_id = ? AND type = 'human_completion' LIMIT 1").get(taskId);
    if (!existingActivity) {
      db.prepare("INSERT INTO activity (id, project_id, task_id, run_id, type, title, detail, tone, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)")
        .run(`activity-${randomUUID()}`, task.projectId, taskId, "human_completion", "Task marked complete by human", "The task was marked Done manually; prior agent run history was preserved.", "green", now);
    }
  });
  complete();
  return getTask(taskId);
}

export function addTaskComment(taskId: string, comment: string) {
  const task = getTask(taskId);
  if (!task) return null;
  const now = isoNow();
  updateTask(taskId, { summary: comment });
  addActivity({ projectId: task.projectId, taskId, type: "human_input", title: "Human context added", detail: comment, tone: "rose" });
  return { ...getTask(taskId), createdAt: now };
}

export function addActivity(input: { projectId: string; taskId?: string | null; runId?: string | null; type: string; title: string; detail?: string | null; tone: ActivityItem["tone"] }) {
  const createdAt = isoNow();
  db.prepare(`INSERT INTO activity (id, project_id, task_id, run_id, type, title, detail, tone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`activity-${randomUUID()}`, input.projectId, input.taskId ?? null, input.runId ?? null, input.type, redactSecrets(input.title), redactSecrets(input.detail), input.tone, createdAt);
}

export function touchProject(projectId: string) {
  const now = isoNow();
  db.prepare("UPDATE projects SET last_synced_at = ?, status = 'connected' WHERE id = ?").run(now, projectId);
  addActivity({ projectId, type: "sync", title: "GitHub sync completed", detail: "Project items and issue metadata are up to date.", tone: "cyan" });
}

export function createRun(input: { taskId: string; mode: AgentRun["mode"]; reasoningEffort?: ReasoningEffort | null }) {
  const task = getTask(input.taskId);
  if (!task) return null;
  const now = isoNow();
  const id = `run-${randomUUID()}`;
  const executionMode = process.env.EXECUTION_MODE === "live" ? "live" : "demo";
  const providerId = process.env.CLINE_PROVIDER_ID ?? "anthropic";
  const modelId = process.env.CLINE_MODEL_ID ?? "claude-sonnet-4-5";
  const reasoningEffort = validateReasoningEffortSync(providerId, modelId, input.reasoningEffort);
  const costSource = executionMode === "live" ? "pending" : "unavailable";
  db.prepare(`INSERT INTO runs (id, task_id, project_id, mode, status, progress, current_activity, started_at, execution_mode, provider_id, model_id, reasoning_effort, cost_source) VALUES (?, ?, ?, ?, 'queued', 0, 'Queued for dispatch', ?, ?, ?, ?, ?, ?)`)
    .run(id, task.id, task.projectId, input.mode, now, executionMode, providerId, modelId, reasoningEffort, costSource);
  updateTask(task.id, { status: "in_progress", agentState: "running", summary: "Agent is preparing an isolated workspace." });
  addActivity({ projectId: task.projectId, taskId: task.id, runId: id, type: "run_started", title: `${input.mode === "start" ? "Agent started" : "Agent continued"}`, detail: task.title, tone: "amber" });
  addRunEvent(id, "run_started", "Run claimed by the local orchestrator", "Workspace and workflow preparation are next.");
  return mapRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow);
}

export function updateRun(runId: string, input: Partial<Pick<AgentRun, "status" | "sessionId" | "branchName" | "workspacePath" | "progress" | "currentActivity" | "finishedAt" | "error" | "commitSha" | "changedFiles" | "checks" | "providerId" | "modelId" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "actualCostUsd" | "costSource">>) {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!run) return null;
  const current = mapRun(run);
  const next = { ...current, ...input };
  const actualCostMicros = next.actualCostUsd === null ? null : next.actualCostUsd === undefined ? null : Math.round(next.actualCostUsd * 1_000_000);
  db.prepare(`UPDATE runs SET status = ?, session_id = ?, branch_name = ?, workspace_path = ?, progress = ?, current_activity = ?, finished_at = ?, error = ?, commit_sha = ?, changed_files_json = ?, checks_json = ?, provider_id = ?, model_id = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, actual_cost_micros = ?, cost_source = ? WHERE id = ?`)
    .run(next.status, next.sessionId, next.branchName, next.workspacePath, next.progress, next.currentActivity, next.finishedAt, next.error, next.commitSha, json(next.changedFiles), json(next.checks), next.providerId, next.modelId, next.inputTokens, next.outputTokens, next.cacheReadTokens, next.cacheWriteTokens, actualCostMicros, next.costSource, runId);
  return mapRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow);
}

export function addRunEvent(runId: string, type: RunEventType, message: string, detail?: string | null) {
  const normalizedType = normalizeRunEventType(type);
  const event = {
    id: `event-${randomUUID()}`,
    runId,
    type: normalizedType,
    message: normalizedType === "unknown" ? "Agent update received" : redactSecrets(message) ?? "",
    detail: normalizedType === "unknown" ? null : redactSecrets(detail),
    createdAt: isoNow(),
  };
  db.prepare("INSERT INTO run_events (id, run_id, type, message, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(event.id, event.runId, event.type, event.message, event.detail, event.createdAt);
  return event;
}

export function getRunEvents(runId?: string): RunEvent[] {
  const rows = runId
    ? db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at DESC LIMIT 100").all(runId)
    : db.prepare("SELECT * FROM run_events ORDER BY created_at DESC LIMIT 160").all();
  return rows.map((row) => {
    const event = row as Record<string, unknown>;
    const type = normalizeRunEventType(event.type);
    return {
      id: String(event.id),
      runId: String(event.run_id),
      type,
      message: type === "unknown" ? "Agent update received" : redactSecrets(String(event.message ?? "")) ?? "",
      detail: type === "unknown" ? null : event.detail ? redactSecrets(String(event.detail)) : null,
      createdAt: String(event.created_at),
    };
  });
}