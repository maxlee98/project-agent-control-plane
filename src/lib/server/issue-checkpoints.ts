import { redactSecrets } from "./redaction";

export type IssueCheckpointPhase = "started" | "workspace" | "progress" | "validation" | "handoff" | "failed" | "stopped";

export type IssueCheckpoint = {
  phase: IssueCheckpointPhase;
  progress?: number;
  detail?: string;
  workspace?: string;
  branchName?: string;
  now?: string;
  next?: string;
  validation?: string;
  changedFiles?: string[];
  commitSha?: string;
  pullRequestUrl?: string;
};

type PublishComment = (fullName: string, issueNumber: number, body: string) => Promise<void>;

type IssueCheckpointPublisherOptions = {
  fullName: string;
  issueNumber: number;
  runId: string;
  intervalMs?: number;
  publishComment: PublishComment;
  onFailure?: (checkpoint: IssueCheckpoint, error: unknown) => void;
  now?: () => number;
};

const phaseStatus: Record<IssueCheckpointPhase, string> = {
  started: "Agent started; preparing an isolated workspace.",
  workspace: "Agent is working in an isolated worktree.",
  progress: "Agent is actively working in the isolated worktree.",
  validation: "Agent is running repository validation.",
  handoff: "Pull request handoff is ready for human review.",
  failed: "Agent run is blocked because it failed before handoff.",
  stopped: "Agent run was stopped before handoff.",
};

const MAX_CHECKPOINT_DETAIL_LENGTH = 1_200;
const MAX_CHECKPOINT_INTENT_LENGTH = 1_200;
const MAX_CHECKPOINT_NEXT_LENGTH = 600;
const MAX_CHECKPOINT_PATHS = 12;
const MAX_CHECKPOINT_PATH_LENGTH = 180;

function safeText(value: string | undefined, limit: number) {
  const redacted = redactSecrets(value?.trim()) ?? "";
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

function safePaths(values: string[] | undefined) {
  return (values ?? [])
    .map((value) => safeText(value, MAX_CHECKPOINT_PATH_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_CHECKPOINT_PATHS);
}

export function formatIssueCheckpoint(runId: string, checkpoint: IssueCheckpoint) {
  const lines = [
    `Agent progress: ${checkpoint.phase}`,
    "",
    `Run: ${runId}`,
    `Status: ${phaseStatus[checkpoint.phase]}`,
  ];
  const workspace = safeText(checkpoint.workspace, MAX_CHECKPOINT_INTENT_LENGTH);
  const branchName = safeText(checkpoint.branchName, MAX_CHECKPOINT_INTENT_LENGTH);
  const now = safeText(checkpoint.now, MAX_CHECKPOINT_INTENT_LENGTH);
  const next = safeText(checkpoint.next, MAX_CHECKPOINT_NEXT_LENGTH);
  const validation = safeText(checkpoint.validation, MAX_CHECKPOINT_INTENT_LENGTH);
  if (workspace) lines.push(`Workspace: ${workspace}`);
  if (branchName) lines.push(`Branch: ${branchName}`);
  if (typeof checkpoint.progress === "number") lines.push(`Progress: ${Math.max(0, Math.min(100, Math.round(checkpoint.progress)))}%`);
  if (now) lines.push(`Now: ${now}`);
  if (next) lines.push(`Next: ${next}`);
  if (validation) lines.push(`Validation: ${validation}`);
  const detail = safeText(checkpoint.detail, MAX_CHECKPOINT_DETAIL_LENGTH);
  if (detail) lines.push(`${checkpoint.phase === "failed" ? "Blocked reason" : "Detail"}: ${detail}`);
  const changedFiles = safePaths(checkpoint.changedFiles);
  if (changedFiles.length) lines.push(`Changed: ${changedFiles.join(", ")}`);
  const commitSha = safeText(checkpoint.commitSha, 120);
  if (commitSha) lines.push(`Commit: ${commitSha}`);
  const pullRequestUrl = safeText(checkpoint.pullRequestUrl, 500);
  if (pullRequestUrl) lines.push(`Pull request: ${pullRequestUrl}`);
  if (checkpoint.phase === "failed" || checkpoint.phase === "stopped") {
    lines.push("", `Next step: ${checkpoint.phase === "stopped" ? "Inspect the preserved workspace, then continue or retry when ready." : "Inspect the preserved workspace and resolve the blocker before rerunning the agent. If human input or an external change is required, add it to the Issue."}`);
  }
  return lines.join("\n");
}

export class IssueCheckpointPublisher {
  private queue: Promise<void> = Promise.resolve();
  private latest: IssueCheckpoint | null = null;
  private lastScheduledAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly options: IssueCheckpointPublisherOptions;
  private lastEnqueuedBody: string | null = null;

  constructor(options: IssueCheckpointPublisherOptions) {
    this.options = options;
    this.intervalMs = Math.max(1, options.intervalMs ?? 8 * 60_000);
    this.now = options.now ?? Date.now;
  }

  startHeartbeat() {
    if (this.heartbeatTimer || this.stopped) return;
    this.heartbeatTimer = setInterval(() => { void this.flushPending(); }, this.intervalMs);
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.latest = null;
    this.stopped = true;
  }

  checkpoint(checkpoint: IssueCheckpoint, options: { force?: boolean } = {}) {
    if (this.stopped) return this.queue;
    this.latest = checkpoint;
    const body = formatIssueCheckpoint(this.options.runId, checkpoint);
    if (body === this.lastEnqueuedBody) return this.queue;
    if (!options.force && this.now() - this.lastScheduledAt < this.intervalMs) {
      return this.queue;
    }
    return this.enqueue(checkpoint, body);
  }

  flushPending() {
    if (!this.latest || this.stopped || this.now() - this.lastScheduledAt < this.intervalMs) return this.queue;
    const body = formatIssueCheckpoint(this.options.runId, this.latest);
    if (body === this.lastEnqueuedBody) return this.queue;
    return this.enqueue(this.latest, body);
  }

  private enqueue(checkpoint: IssueCheckpoint, body = formatIssueCheckpoint(this.options.runId, checkpoint)) {
    this.lastScheduledAt = this.now();
    this.lastEnqueuedBody = body;
    this.queue = this.queue.then(async () => {
      try {
        await this.options.publishComment(this.options.fullName, this.options.issueNumber, body);
      } catch (error) {
        try { this.options.onFailure?.(checkpoint, error); } catch { /* Failure reporting must not break the queue. */ }
      }
    });
    return this.queue;
  }
}
