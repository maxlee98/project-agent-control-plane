import { ClineCore } from "@cline/sdk";
import type { AgentRunInput } from "../integrations";
import { shouldPublishGithubCheckpoint, type RunEventDraft } from "../domain";
import { readRunUsage, type RunUsageSnapshot } from "./cost";
import { redactSecrets } from "./redaction";

export interface ClineCallbacks {
  onActivity(message: string, detail?: string | null): void;
  onEvent(event: RunEventDraft): void;
  onUsage?(usage: RunUsageSnapshot): void;
}

type ClineFinishReason = "completed" | "aborted" | "error" | "mistake_limit" | "max_iterations";
type ClineCompletion = { text: string; finishReason: ClineFinishReason; usage?: Partial<RunUsageSnapshot> };
type ClineCreateOptions = Parameters<typeof ClineCore.create>[0];

export interface ClineRuntimeDependencies {
  createCore?: (options?: ClineCreateOptions) => Promise<ClineCore>;
}

const activeSessions = new Map<string, { cline: ClineCore; sessionId: string }>();

export function hasActiveClineSession(runId: string) {
  return activeSessions.has(runId);
}

function durationFromEnv(name: string, fallbackMinutes: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value * 60_000 : fallbackMinutes * 60_000;
}

function timeoutError(label: string) {
  return new Error(`Cline ${label} timeout. The run was stopped and its workspace was preserved.`);
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message) ?? "Cline reported an unknown error.";
}

function normalizeFinishReason(value: unknown): ClineFinishReason {
  if (value === "completed" || value === "aborted" || value === "error" || value === "mistake_limit" || value === "max_iterations") return value;
  return "error";
}

function unsuccessfulCompletionError(completion: ClineCompletion) {
  return new Error(`Cline run did not complete successfully (finish reason: ${completion.finishReason}).`);
}

const AGENT_EVENT_TYPES = new Set([
  "content_start",
  "content_update",
  "content_end",
  "iteration_start",
  "iteration_end",
  "usage",
  "notice",
  "done",
  "error",
]);

function eventRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function redactedText(value: unknown, limit = 2_000) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = redactSecrets(value.trim());
  return text && text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function eventDraft(type: RunEventDraft["type"], message: string, detail?: unknown): RunEventDraft {
  return {
    type,
    message,
    detail: redactedText(detail),
    checkpoint: shouldPublishGithubCheckpoint(type),
  };
}

function agentEventFrom(input: unknown) {
  const envelope = eventRecord(input);
  const type = stringValue(envelope?.type);
  const payload = eventRecord(envelope?.payload);
  if (type === "agent_event") return eventRecord(payload?.event);
  if (type && AGENT_EVENT_TYPES.has(type)) return envelope;
  return null;
}

function usageFrom(value: unknown): Partial<RunUsageSnapshot> | undefined {
  const usage = eventRecord(value);
  if (!usage) return undefined;
  const inputTokens = numberValue(usage.totalInputTokens ?? usage.inputTokens);
  const outputTokens = numberValue(usage.totalOutputTokens ?? usage.outputTokens);
  const cacheReadTokens = numberValue(usage.totalCacheReadTokens ?? usage.cacheReadTokens);
  const cacheWriteTokens = numberValue(usage.totalCacheWriteTokens ?? usage.cacheWriteTokens);
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined && numberValue(usage.totalCost) === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalCost: numberValue(usage.totalCost),
  };
}

function toolDetail(agentEvent: Record<string, unknown>, includeError = false) {
  const toolName = redactedText(agentEvent.toolName, 240);
  const error = includeError ? redactedText(agentEvent.error, 1_200) : null;
  if (toolName && error) return `${toolName}: ${error}`;
  return error ?? toolName;
}

/**
 * Translate ClineCore's event vocabulary at the integration boundary. Only stable control-plane
 * event types and selected, redacted scalar details leave this function.
 */
export function translateClineEvent(input: unknown): RunEventDraft | null {
  const envelope = eventRecord(input);
  if (!envelope) return null;
  const envelopeType = stringValue(envelope.type);
  const agentEvent = agentEventFrom(input);
  const agentType = stringValue(agentEvent?.type);

  if (agentEvent && agentType === "content_start") {
    const contentType = stringValue(agentEvent.contentType);
    if (contentType === "tool") return eventDraft("tool_started", "Agent started a tool", toolDetail(agentEvent));
    if (contentType === "text") return eventDraft("progress", "Agent started producing output", agentEvent.text);
    return eventDraft("progress", "Agent started an internal update");
  }
  if (agentEvent && agentType === "content_update") {
    return eventDraft("progress", "Agent tool progress updated", toolDetail(agentEvent));
  }
  if (agentEvent && agentType === "content_end") {
    const contentType = stringValue(agentEvent.contentType);
    if (contentType === "tool") return eventDraft("tool_finished", "Agent finished a tool", toolDetail(agentEvent, true));
    if (contentType === "text") return eventDraft("output_summary", "Agent output summarized", agentEvent.text);
    return eventDraft("progress", "Agent completed an internal update");
  }
  if (agentEvent && agentType === "iteration_start") {
    const iteration = numberValue(agentEvent.iteration);
    return eventDraft("progress", "Agent iteration started", iteration === undefined ? undefined : `Iteration ${iteration}`);
  }
  if (agentEvent && agentType === "iteration_end") {
    const iteration = numberValue(agentEvent.iteration);
    const toolCallCount = numberValue(agentEvent.toolCallCount);
    const detail = iteration === undefined
      ? undefined
      : toolCallCount === undefined
        ? `Iteration ${iteration} completed`
        : `Iteration ${iteration} completed · ${toolCallCount} tool calls`;
    return eventDraft("progress", "Agent iteration completed", detail);
  }
  if (agentEvent && agentType === "usage") return eventDraft("progress", "Agent usage updated");
  if (agentEvent && agentType === "notice") return eventDraft("progress", "Agent reported an update", agentEvent.message);
  if (agentEvent && agentType === "done") {
    const completed = stringValue(agentEvent.reason) === "completed";
    return eventDraft(completed ? "run_completed" : "run_failed", completed ? "Agent turn completed" : "Agent turn ended before completion", completed ? agentEvent.text : undefined);
  }
  if (agentEvent && agentType === "error") return eventDraft("run_failed", "Agent reported an error", agentEvent.error instanceof Error ? agentEvent.error.message : agentEvent.error);

  if (envelopeType === "chunk") {
    const payload = eventRecord(envelope.payload);
    return eventDraft("output_chunk", "Agent output received", payload?.chunk);
  }
  if (envelopeType === "ended") {
    const payload = eventRecord(envelope.payload);
    const completed = stringValue(payload?.reason) === "completed";
    return eventDraft(completed ? "run_completed" : "run_failed", completed ? "Agent turn completed" : "Agent turn ended before completion");
  }
  if (envelopeType === "hook") {
    const payload = eventRecord(envelope.payload);
    switch (stringValue(payload?.hookEventName)) {
      case "tool_call": return eventDraft("tool_started", "Agent started a tool", payload?.toolName);
      case "tool_result": return eventDraft("tool_finished", "Agent finished a tool", payload?.toolName);
      case "agent_end": return eventDraft("run_completed", "Agent turn completed");
      case "agent_error": return eventDraft("run_failed", "Agent reported an error");
      case "session_shutdown": return eventDraft("progress", "Agent session shut down");
      default: return eventDraft("unknown", "Agent update received");
    }
  }
  if (envelopeType === "status") return eventDraft("progress", "Agent status updated");
  if (envelopeType === "team_progress") return eventDraft("progress", "Agent team progress updated");
  if (envelopeType === "pending_prompts") {
    const payload = eventRecord(envelope.payload);
    const prompts = Array.isArray(payload?.prompts) ? payload.prompts.length : 0;
    return eventDraft("progress", "Agent is waiting for input", `${prompts} pending instruction${prompts === 1 ? "" : "s"}`);
  }
  if (envelopeType === "pending_prompt_submitted") return eventDraft("progress", "Agent instruction submitted");
  if (envelopeType === "session_snapshot") return eventDraft("progress", "Agent session state updated");
  return eventDraft("unknown", "Agent update received");
}

async function abortAndStopSession(cline: ClineCore, sessionId: string, reason: Error) {
  if (!sessionId) {
    await cline.dispose();
    return;
  }
  try {
    await cline.abort(sessionId, reason);
  } finally {
    await cline.stop(sessionId);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout: () => void) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(timeoutError(label));
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function runCline(input: AgentRunInput & { runId: string; providerId?: string; modelId?: string }, callbacks: ClineCallbacks, dependencies: ClineRuntimeDependencies = {}) {
  const createCore = dependencies.createCore ?? ClineCore.create;
  const cline = await createCore({ clientName: "project-agent-control-plane", backendMode: "local" });
  const providerId = input.providerId ?? process.env.CLINE_PROVIDER_ID ?? "anthropic";
  const modelId = input.modelId ?? process.env.CLINE_MODEL_ID ?? "claude-sonnet-4-5";
  let sessionId = "";
  let latestUsage: RunUsageSnapshot | null = null;
  let lastActivityAt = Date.now();
  let timedOut = false;
  const maxDurationMs = durationFromEnv("AGENT_MAX_RUN_MINUTES", 45);
  const inactivityMs = durationFromEnv("AGENT_INACTIVITY_MINUTES", 8);
  let resolveEnded: (value: ClineCompletion) => void = () => undefined;
  let rejectEnded: (reason: Error) => void = () => undefined;
  const ended = new Promise<ClineCompletion>((resolve, reject) => {
    resolveEnded = resolve;
    rejectEnded = reject;
  });
  const stopAfterTimeout = (error: Error) => {
    if (timedOut) return;
    timedOut = true;
    rejectEnded(error);
    void abortAndStopSession(cline, sessionId, error).catch(() => undefined);
  };
  const reportUsage = async () => {
    if (!sessionId) return latestUsage;
    try {
      const summary = await cline.getAccumulatedUsage(sessionId);
      latestUsage = await readRunUsage(providerId, modelId, summary?.aggregateUsage ?? summary?.usage) ?? latestUsage;
      if (latestUsage) callbacks.onUsage?.(latestUsage);
    } catch {
      // Usage collection must not turn a completed agent run into a failed handoff.
    }
    return latestUsage;
  };
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivityAt >= inactivityMs) stopAfterTimeout(timeoutError("inactivity"));
  }, Math.min(30_000, inactivityMs));

  const unsubscribe = cline.subscribe((event) => {
    const payload = eventRecord(event.payload);
    const eventSessionId = stringValue(payload?.sessionId);
    if (!eventSessionId || !sessionId || eventSessionId !== sessionId) return;
    lastActivityAt = Date.now();

    const translated = translateClineEvent(event);
    if (translated) {
      callbacks.onEvent(translated);
      if (translated.type === "progress" || translated.type === "tool_started" || translated.type === "tool_finished" || translated.type === "output_summary") {
        callbacks.onActivity(translated.message, translated.detail);
      }
    }

    const agentEvent = agentEventFrom(event);
    const agentType = stringValue(agentEvent?.type);
    if (agentEvent && agentType === "usage") {
      const usage = usageFrom(agentEvent);
      if (usage) {
        void readRunUsage(providerId, modelId, usage).then((snapshot) => {
          if (snapshot) {
            latestUsage = snapshot;
            callbacks.onUsage?.(snapshot);
          }
        }).catch(() => undefined);
      }
    }
    if (agentEvent && agentType === "done") {
      const usage = usageFrom(agentEvent.usage);
      if (usage) {
        void readRunUsage(providerId, modelId, usage).then((snapshot) => {
          if (snapshot) {
            latestUsage = snapshot;
            callbacks.onUsage?.(snapshot);
          }
        }).catch(() => undefined);
      }
      resolveEnded({ text: redactedText(agentEvent.text) ?? "", finishReason: normalizeFinishReason(agentEvent.reason), usage });
    }
    if (agentEvent && agentType === "error") rejectEnded(new Error(safeErrorMessage(agentEvent.error)));
    if (stringValue(event.type) === "ended") {
      resolveEnded({ text: "", finishReason: normalizeFinishReason(payload?.reason) });
    }
  });

  try {
    const deadline = Date.now() + maxDurationMs;
    const startPromise = cline.start({
      source: "cli",
      mode: "automation",
      interactive: false,
      config: {
        providerId,
        modelId,
        apiKey: process.env.CLINE_API_KEY,
        systemPrompt: "You are an autonomous coding agent. Work only in the assigned workspace. Make focused changes, run validation, and report a concise handoff.",
        cwd: input.workspacePath,
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        yolo: true,
        checkpoint: { enabled: true },
      },
    });
    const result = await withTimeout(startPromise, maxDurationMs, "startup", () => stopAfterTimeout(timeoutError("startup")));
    sessionId = result.sessionId.trim();
    if (!sessionId) throw new Error("Cline startup returned no session ID.");
    activeSessions.set(input.runId, { cline, sessionId });
    callbacks.onEvent(eventDraft("session_started", "Cline session started"));
    const remainingMs = Math.max(1, deadline - Date.now());
    const sendResult = await withTimeout(cline.send({ sessionId, prompt: input.prompt, mode: "act" }), remainingMs, "completion", () => stopAfterTimeout(timeoutError("completion")));
    const completion: ClineCompletion = sendResult
      ? { text: redactSecrets(sendResult.text) ?? "", finishReason: normalizeFinishReason(sendResult.finishReason), usage: sendResult.usage }
      : await withTimeout(ended, remainingMs, "completion", () => stopAfterTimeout(timeoutError("completion")));
    if (completion.usage) {
      latestUsage = await readRunUsage(providerId, modelId, completion.usage) ?? latestUsage;
      if (latestUsage) callbacks.onUsage?.(latestUsage);
    }
    if (completion.finishReason !== "completed") throw unsuccessfulCompletionError(completion);
    await reportUsage();
    return { sessionId, ...completion, usage: latestUsage };
  } catch (error) {
    await reportUsage();
    throw new Error(safeErrorMessage(error));
  } finally {
    clearInterval(watchdog);
    activeSessions.delete(input.runId);
    unsubscribe();
    await cline.dispose().catch(() => undefined);
  }
}

export async function stopClineRun(runId: string) {
  const active = activeSessions.get(runId);
  if (!active) return;
  await abortAndStopSession(active.cline, active.sessionId, new Error("Cline run stopped by operator."));
}