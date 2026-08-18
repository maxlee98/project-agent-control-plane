import { ClineCore } from "@cline/sdk";
import type { AgentRunInput } from "../integrations";
import { redactSecrets } from "./redaction";

export interface ClineCallbacks {
  onActivity(message: string, detail?: string | null): void;
  onEvent(type: string, message: string, detail?: string | null): void;
}

const activeSessions = new Map<string, { cline: ClineCore; sessionId: string }>();

function durationFromEnv(name: string, fallbackMinutes: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value * 60_000 : fallbackMinutes * 60_000;
}

function timeoutError(label: string) {
  return new Error(`Cline ${label} timeout. The run was stopped and its workspace was preserved.`);
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
    const payload = event.payload as {
      sessionId?: string;
      event?: { type?: string; text?: string; message?: string; toolName?: string; error?: Error };
      chunk?: string;
    };
    if (payload.sessionId && sessionId && payload.sessionId !== sessionId) return;

    if (event.type === "agent_event" && payload.event) {
      const agentEvent = payload.event;
      const detail = redactSecrets(
        agentEvent.type === "error"
          ? agentEvent.error?.message
          : agentEvent.type === "content_end"
            ? agentEvent.text
            : agentEvent.type === "notice"
              ? agentEvent.message
              : agentEvent.toolName,
      );
      callbacks.onEvent(agentEvent.type ?? "agent_event", agentEvent.type ?? "Agent event", detail);
      if (agentEvent.type === "content_start" || agentEvent.type === "notice") {
        callbacks.onActivity(redactSecrets(agentEvent.message ?? agentEvent.toolName ?? agentEvent.type) ?? "Agent event", detail);
      }
      if (agentEvent.type === "done") resolveEnded({ text: redactSecrets(agentEvent.text) ?? "" });
      if (agentEvent.type === "error") rejectEnded(agentEvent.error instanceof Error ? agentEvent.error : new Error("Cline reported an error."));
    } else if (event.type === "chunk" && payload.chunk) {
      callbacks.onEvent("chunk", "Agent output", redactSecrets(payload.chunk.slice(-1000)));
    } else if (event.type === "ended") {
      resolveEnded({ text: "" });
    }
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
    callbacks.onEvent("session_started", "Cline session started", sessionId);
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