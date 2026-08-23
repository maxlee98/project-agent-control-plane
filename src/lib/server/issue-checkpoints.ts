import { redactSecrets } from "./redaction";

export type IssueCheckpointPhase = "started" | "workspace" | "progress" | "validation" | "handoff" | "failed";

export type IssueCheckpoint = {
  phase: IssueCheckpointPhase;
  progress?: number;
  detail?: string;
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
};

const MAX_CHECKPOINT_DETAIL_LENGTH = 2_000;

function safeDetail(value: string | undefined) {
  const redacted = redactSecrets(value?.trim()) ?? "";
  return redacted.length > MAX_CHECKPOINT_DETAIL_LENGTH ? `${redacted.slice(0, MAX_CHECKPOINT_DETAIL_LENGTH)}…` : redacted;
}

export function formatIssueCheckpoint(runId: string, checkpoint: IssueCheckpoint) {
  const lines = [
    `Agent checkpoint: ${checkpoint.phase}`,
    "",
    `Run: ${runId}`,
    `Status: ${phaseStatus[checkpoint.phase]}`,
  ];
  if (typeof checkpoint.progress === "number") lines.push(`Progress: ${Math.max(0, Math.min(100, Math.round(checkpoint.progress)))}%`);
  const detail = safeDetail(checkpoint.detail);
  if (detail) lines.push(`${checkpoint.phase === "failed" ? "Blocked reason" : "Detail"}: ${detail}`);
  if (checkpoint.phase === "failed") {
    lines.push("", "Next step: Inspect the preserved workspace and resolve the blocker before rerunning the agent. If human input or an external change is required, add it to the Issue.");
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
    if (!options.force && this.now() - this.lastScheduledAt < this.intervalMs) {
      return this.queue;
    }
    return this.enqueue(checkpoint);
  }

  flushPending() {
    if (!this.latest || this.stopped || this.now() - this.lastScheduledAt < this.intervalMs) return this.queue;
    return this.enqueue(this.latest);
  }

  private enqueue(checkpoint: IssueCheckpoint) {
    this.lastScheduledAt = this.now();
    this.queue = this.queue.then(async () => {
      try {
        await this.options.publishComment(this.options.fullName, this.options.issueNumber, formatIssueCheckpoint(this.options.runId, checkpoint));
      } catch (error) {
        try { this.options.onFailure?.(checkpoint, error); } catch { /* Failure reporting must not break the queue. */ }
      }
    });
    return this.queue;
  }
}
