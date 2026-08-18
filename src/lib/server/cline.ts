import { ClineCore } from "@cline/sdk";
import type { AgentRunInput } from "../integrations";
import { shouldPublishGithubCheckpoint } from "../domain";
import type { RunEventDraft } from "../domain";
import { redactSecrets } from "./redaction";

export interface ClineCallbacks {
  onActivity(message: string, detail?: string | null): void;
  onEvent(event: RunEventDraft): void;
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

function redactedText(value: unknown, limit = 2_000) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = redactSecrets(value.trim());
  return text && text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function eventRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
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

function eventDraft(type: RunEventDraft["type"], message: string, detail?: unknown): RunEventDraft {
  return {
    type,
    message,
    detail: redactedText(detail),
    checkpoint: shouldPublishGithubCheckpoint(type),
  };
}

/**
 * Translate ClineCore's event vocabulary at the integration boundary. Nothing returned from this
 * function should require a Cline event name to render or persist a run.
 */
export function translateClineEvent(input: unknown): RunEventDraft | null {
  const envelope = eventRecord(input);
  if (!envelope) return null;
  const type = stringValue(envelope.type);
  const payload = eventRecord(envelope.payload);
  const agentEvent = type === "agent_event"
    ? eventRecord(payload?.event)
    : type && AGENT_EVENT_TYPES.has(type)
      ? envelope
      : null;
  const agentType = stringValue(agentEvent?.type);

  if (agentEvent && agentType === "content_start") {
    const contentType = stringValue(agentEvent.contentType);
    if (contentType === "tool") return eventDraft("tool_started", "Agent started a tool", agentEvent.toolName);
    return eventDraft("progress", "Agent started producing an update", agentEvent.text ?? agentEvent.reasoning);
  }
  if (agentEvent && agentType === "content_update") {
    return eventDraft("progress", "Agent tool progress updated", agentEvent.toolName);
  }
  if (agentEvent && agentType === "content_end") {
    const contentType = stringValue(agentEvent.contentType);
    if (contentType === "tool") {
      return eventDraft("tool_finished", "Agent finished a tool", agentEvent.error ?? agentEvent.toolName);
    }
    if (contentType === "text") return eventDraft("output_summary", "Agent output summarized", agentEvent.text);
    return eventDraft("progress", "Agent completed an internal update");
  }
  if (agentEvent && agentType === "iteration_start") {
    return eventDraft("progress", "Agent iteration started", typeof agentEvent.iteration === "number" ? `Iteration ${agentEvent.iteration}` : null);
  }
  if (agentEvent && agentType === "iteration_end") {
    return eventDraft("progress", "Agent iteration completed", typeof agentEvent.iteration === "number" ? `Iteration ${agentEvent.iteration}` : null);
  }
  if (agentEvent && agentType === "usage") return eventDraft("progress", "Agent usage updated");
  if (agentEvent && agentType === "notice") return eventDraft("progress", "Agent reported progress", agentEvent.message);
  if (agentEvent && agentType === "done") return eventDraft("run_completed", "Agent turn completed", agentEvent.text);
  if (agentEvent && agentType === "error") {
    const error = eventRecord(agentEvent.error);
    return eventDraft("run_failed", "Agent reported an error", error ? error.message : agentEvent.error);
  }

  if (type === "chunk") return eventDraft("output_chunk", "Agent output received", payload?.chunk);
  if (type === "ended") return eventDraft("run_completed", "Agent session ended");
  if (type === "status") return eventDraft("progress", "Agent status updated");
  if (type === "team_progress") return eventDraft("progress", "Agent team progress updated");
  if (type === "pending_prompts" || type === "pending_prompt_submitted") return eventDraft("progress", "Agent input state updated");
  if (type === "hook") {
    const hook = stringValue(payload?.hookEventName);
    if (hook === "tool_call") return eventDraft("tool_started", "Agent started a tool", payload?.toolName);
    if (hook === "tool_result") return eventDraft("tool_finished", "Agent finished a tool", payload?.toolName);
    if (hook === "agent_end") return eventDraft("run_completed", "Agent turn completed");
    if (hook === "agent_error") return eventDraft("run_failed", "Agent reported an error");
    return eventDraft("progress", "Agent lifecycle updated");
  }
  if (type) return eventDraft("unknown", "Agent update received");
  return null;
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

export async function runCline(input: AgentRunInput & { runId: string }, callbacks: ClineCallbacks) {
  const cline = await ClineCore.create({ clientName: "project-agent-control-plane", backendMode: "local" });
  let sessionId = "";
  let lastActivityAt = Date.now();
  let timedOut = false;
  const maxDurationMs = durationFromEnv("AGENT_MAX_RUN_MINUTES", 45);
  const inactivityMs = durationFromEnv("AGENT_INACTIVITY_MINUTES", 8);
  let resolveEnded: (value: { text: string }) => void = () => undefined;
  let rejectEnded: (reason: Error) => void = () => undefined;
  const ended = new Promise<{ text: string }>((resolve, reject) => {
    resolveEnded = resolve;
    rejectEnded = reject;
  });
  const stopAfterTimeout = (error: Error) => {
    if (timedOut) return;
    timedOut = true;
    rejectEnded(error);
    if (sessionId) void cline.stop(sessionId).catch(() => undefined);
    else void cline.dispose().catch(() => undefined);
  };
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivityAt >= inactivityMs) stopAfterTimeout(timeoutError("inactivity"));
  }, Math.min(30_000, inactivityMs));

  const unsubscribe = cline.subscribe((event) => {
    lastActivityAt = Date.now();
    const payload = eventRecord(event.payload);
    if (payload?.sessionId && sessionId && payload.sessionId !== sessionId) return;

    const translated = translateClineEvent(event);
    if (translated) {
      callbacks.onEvent(translated);
      if (translated.type === "progress" || translated.type === "tool_started" || translated.type === "tool_finished") {
        callbacks.onActivity(translated.message, translated.detail);
      }
    }

    const agentEvent = event.type === "agent_event"
      ? eventRecord(payload?.event)
      : typeof event.type === "string" && AGENT_EVENT_TYPES.has(event.type)
        ? eventRecord(event)
        : null;
    if (agentEvent?.type === "done") resolveEnded({ text: redactedText(agentEvent.text) ?? "" });
    if (agentEvent?.type === "error") {
      rejectEnded(agentEvent.error instanceof Error ? agentEvent.error : new Error("Cline reported an error."));
    }
    if (event.type === "ended") resolveEnded({ text: "" });
  });

  try {
    const startPromise = cline.start({
      source: "cli",
      mode: "automation",
      prompt: input.prompt,
      interactive: false,
      config: {
        providerId: process.env.CLINE_PROVIDER_ID ?? "anthropic",
        modelId: process.env.CLINE_MODEL_ID ?? "claude-sonnet-4-5",
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
    const deadline = Date.now() + maxDurationMs;
    const result = await withTimeout(startPromise, maxDurationMs, "startup", () => stopAfterTimeout(timeoutError("startup")));
    sessionId = result.sessionId;
    activeSessions.set(input.runId, { cline, sessionId });
    callbacks.onEvent(eventDraft("session_started", "Cline session started"));
    const remainingMs = Math.max(1, deadline - Date.now());
    const completion = await withTimeout(ended, remainingMs, "completion", () => stopAfterTimeout(timeoutError("completion")));
    return { sessionId, ...completion };
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
  if (active.sessionId) await active.cline.stop(active.sessionId);
  else await active.cline.dispose();
}