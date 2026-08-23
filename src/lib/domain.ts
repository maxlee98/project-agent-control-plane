export const BOARD_COLUMNS = [
  { id: "inbox", label: "Inbox", color: "slate" },
  { id: "ready", label: "Ready", color: "cyan" },
  { id: "in_progress", label: "In progress", color: "amber" },
  { id: "human_review", label: "Review", color: "rose" },
  { id: "blocked", label: "Blocked", color: "red" },
  { id: "done", label: "Done", color: "emerald" },
] as const;

export type TaskStatus = (typeof BOARD_COLUMNS)[number]["id"];
export const TASK_PRIORITIES = [1, 2, 3, 4] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"] as const;
export const DEFAULT_TASK_PRIORITY: TaskPriority = 3;

export function isTaskPriority(value: unknown): value is TaskPriority {
  return Number.isInteger(value) && TASK_PRIORITIES.includes(value as TaskPriority);
}

export function priorityLabel(priority: TaskPriority | number) {
  return PRIORITY_LABELS[priority - 1] ?? "P2";
}

export function priorityFromLabel(value: unknown): TaskPriority | null {
  if (typeof value !== "string") return null;
  const index = PRIORITY_LABELS.indexOf(value.trim().toUpperCase() as typeof PRIORITY_LABELS[number]);
  return index === -1 ? null : (index + 1) as TaskPriority;
}

export type AgentState = "idle" | "running" | "waiting" | "failed" | "succeeded";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped";
export type RunRecoveryStatus = "none" | "interrupted";
export type ExecutionMode = "demo" | "live";
export type ActivityTone = "cyan" | "amber" | "violet" | "rose" | "red" | "green" | "slate";
export type RunCostSource = "pending" | "sdk" | "catalog" | "unavailable";
export type TaskCostStatus = "not_started" | "pending" | "available" | "partial" | "unavailable";
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const READINESS_CONTRACT_VERSION = "1.0";
export type ReadinessLevel = "registered" | "inspectable" | "demo_ready" | "live_ready";
export type ReadinessCheckStatus = "pass" | "warning" | "blocker" | "unknown";
export type ReadinessCategory = "checkout" | "policy" | "validation" | "github" | "runtime" | "handoff";
export type ProjectStatusConcept = "ready" | "in_progress" | "review" | "blocked" | "done";

export interface ProjectStatusMapping {
  concept: ProjectStatusConcept;
  optionId: string | null;
  optionName: string | null;
  state: "mapped" | "missing" | "ambiguous" | "unavailable";
  candidates: string[];
}

export interface ReadinessCheck {
  id: string;
  category: ReadinessCategory;
  status: ReadinessCheckStatus;
  summary: string;
  remediation: string;
  liveRequired: boolean;
}

export interface ReadinessReport {
  contractVersion: string;
  checkedAt: string;
  overallLevel: ReadinessLevel;
  checks: ReadinessCheck[];
  categories: Record<ReadinessCategory, { pass: number; warning: number; blocker: number; unknown: number }>;
  baseline: {
    workflow: "local" | "default" | "missing";
    workflowPath: string | null;
    agents: boolean;
    skills: boolean;
    pullRequestTemplate: boolean;
    proposal: "none" | "create_baseline_via_pr";
  };
  projectStatus: {
    configured: boolean;
    reachable: boolean | null;
    fieldName: string | null;
    statusFieldIssue?: "missing_status_field" | "ambiguous_status_fields" | null;
    options: string[];
    mappings: ProjectStatusMapping[];
  };
}

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
  | "run_recovered"
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
  "run_recovered",
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
  readiness?: ReadinessReport | null;
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
  priority: TaskPriority;
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
  ownerId: string | null;
  leaseHeartbeatAt: string | null;
  leaseExpiresAt: string | null;
  currentStage: string;
  recoveryStatus: RunRecoveryStatus;
  recoveryReason: string | null;
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