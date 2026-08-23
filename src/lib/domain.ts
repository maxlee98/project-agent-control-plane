export const BOARD_COLUMNS = [
  { id: "inbox", label: "Inbox", color: "slate" },
  { id: "ready", label: "Ready", color: "cyan" },
  { id: "in_progress", label: "In progress", color: "amber" },
  { id: "human_review", label: "Review", color: "rose" },
  { id: "blocked", label: "Blocked", color: "red" },
  { id: "done", label: "Done", color: "emerald" },
] as const;

export type TaskStatus = (typeof BOARD_COLUMNS)[number]["id"];
export type AgentState = "idle" | "running" | "waiting" | "failed" | "succeeded";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped";
export type ExecutionMode = "demo" | "live";
export type ActivityTone = "cyan" | "amber" | "violet" | "rose" | "red" | "green" | "slate";
export type RunCostSource = "pending" | "sdk" | "catalog" | "unavailable";
export type TaskCostStatus = "not_started" | "pending" | "available" | "partial" | "unavailable";
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ReasoningCapability {
  providerId: string;
  modelId: string;
  supportedEfforts: ReasoningEffort[];
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Keep legacy persisted/API values readable while exposing one canonical review state. */
export function normalizeTaskStatus(value: unknown): TaskStatus {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (normalized === "agent_review" || normalized === "in_review" || normalized === "human_review" || normalized === "review") return "human_review";
  if ((BOARD_COLUMNS as readonly { id: string }[]).some((column) => column.id === normalized)) return normalized as TaskStatus;
  return "inbox";
}

/** Stable vocabulary exposed by the control plane, not by an agent implementation. */
export type RunEventType =
  | "run_started"
  | "dispatch"
  | "workspace_ready"
  | "workspace_created"
  | "workspace_reused"
  | "session_started"
  | "progress"
  | "tool_started"
  | "tool_finished"
  | "output_summary"
  | "output_chunk"
  | "validation_started"
  | "validation_passed"
  | "validation_failed"
  | "run_completed"
  | "run_failed"
  | "run_stopped"
  | "handoff_complete"
  | "stage_started"
  | "stage_failed"
  | "handoff_comment_failed"
  | "issue_checkpoint_failed"
  | "checkpoint_publish_failed"
  | "unknown";

export interface RunEventDraft {
  type: RunEventType;
  message: string;
  detail: string | null;
  /** Whether this event is meaningful enough for a future host checkpoint policy. */
  checkpoint: boolean;
}

const RUN_EVENT_TYPES = new Set<RunEventType>([
  "run_started",
  "dispatch",
  "workspace_ready",
  "workspace_created",
  "workspace_reused",
  "session_started",
  "progress",
  "tool_started",
  "tool_finished",
  "output_summary",
  "output_chunk",
  "validation_started",
  "validation_passed",
  "validation_failed",
  "run_completed",
  "run_failed",
  "run_stopped",
  "handoff_complete",
  "stage_started",
  "stage_failed",
  "handoff_comment_failed",
  "issue_checkpoint_failed",
  "checkpoint_publish_failed",
  "unknown",
]);

/** Normalize persisted values so future or legacy source vocabulary cannot leak into the UI. */
export function normalizeRunEventType(value: unknown): RunEventType {
  if (value === "cline") return "progress";
  return typeof value === "string" && RUN_EVENT_TYPES.has(value as RunEventType) ? value as RunEventType : "unknown";
}

const GITHUB_CHECKPOINT_EVENT_TYPES = new Set<RunEventType>([
  "validation_passed",
  "validation_failed",
  "run_failed",
  "run_stopped",
  "handoff_complete",
]);

export function shouldPublishGithubCheckpoint(type: RunEventType) {
  return GITHUB_CHECKPOINT_EVENT_TYPES.has(type);
}

export interface RunCheck {
  name: string;
  command: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  output?: string;
  durationMs?: number;
}

export interface Project {
  id: string;
  name: string;
  fullName: string;
  description: string;
  initials: string;
  accent: string;
  localPath: string;
  defaultBranch: string;
  githubProjectId: string | null;
  githubProjectUrl: string | null;
  isDemo: boolean;
  status: "connected" | "syncing" | "attention";
  lastSyncedAt: string;
  activeAgents: number;
  openTasks: number;
  openPrs: number;
}

export interface Task {
  id: string;
  projectId: string;
  issueNumber: number | null;
  title: string;
  description: string;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  actualCostStatus: TaskCostStatus;
  status: TaskStatus;
  priority: 1 | 2 | 3 | 4;
  labels: string[];
  assignee: "You" | "Agent" | null;
  agentState: AgentState;
  currentSummary: string;
  branchName: string | null;
  prUrl: string | null;
  githubUrl: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  taskId: string;
  projectId: string;
  mode: "start" | "continue" | "retry";
  status: RunStatus;
  sessionId: string | null;
  branchName: string | null;
  workspacePath: string | null;
  progress: number;
  currentActivity: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  executionMode: ExecutionMode;
  providerId: string;
  modelId: string;
  reasoningEffort: ReasoningEffort | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  actualCostUsd: number | null;
  costSource: RunCostSource;
  isActive: boolean;
  commitSha: string | null;
  changedFiles: string[];
  checks: RunCheck[];
}

export interface ActivityItem {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  type: string;
  title: string;
  detail: string | null;
  tone: ActivityTone;
  createdAt: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  type: RunEventType;
  message: string;
  detail: string | null;
  createdAt: string;
}

export interface DashboardData {
  projects: Project[];
  tasks: Task[];
  runs: AgentRun[];
  activity: ActivityItem[];
  runEvents: RunEvent[];
  runtime: {
    executionMode: ExecutionMode;
    liveReady: boolean;
    reason: string | null;
    reasoning: ReasoningCapability;
    capacity: {
      active: number;
      globalLimit: number;
      perProjectLimit: number;
    };
  };
}

export function getColumnLabel(status: TaskStatus) {
  return BOARD_COLUMNS.find((column) => column.id === status)?.label ?? status;
}

export function formatRelativeTime(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(delta / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatEstimatedCost(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function formatActualCost(value: number) {
  if (value > 0 && value < 0.01) return `$${value.toFixed(6)}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
}

export function getInitials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}