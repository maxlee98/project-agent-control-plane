import { ClineCore } from "@cline/sdk";
import type { AgentRunInput } from "../integrations";
import { readRunUsage, type RunUsageSnapshot } from "./cost";
import { redactSecrets } from "./redaction";

export interface ClineCallbacks {
  onActivity(message: string, detail?: string | null): void;
  onEvent(type: string, message: string, detail?: string | null): void;
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
    const payload = event.payload as {
      sessionId?: string;
      event?: { type?: string; text?: string; message?: string; toolName?: string; error?: Error | string; reason?: string; usage?: Partial<RunUsageSnapshot> };
      chunk?: string;
    };
    if (!payload.sessionId || !sessionId || payload.sessionId !== sessionId) return;
    lastActivityAt = Date.now();

    if (event.type === "agent_event" && payload.event) {
      const agentEvent = payload.event as {
        type?: string;
        text?: string;
        message?: string;
        toolName?: string;
        error?: Error | string;
        reason?: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        totalInputTokens?: number;
        totalOutputTokens?: number;
        totalCacheReadTokens?: number;
        totalCacheWriteTokens?: number;
        totalCost?: number;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          totalInputTokens?: number;
          totalOutputTokens?: number;
          totalCacheReadTokens?: number;
          totalCacheWriteTokens?: number;
          totalCost?: number;
        };
      };
      const detail = redactSecrets(
        agentEvent.type === "error"
          ? safeErrorMessage(agentEvent.error)
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
      if (agentEvent.type === "usage") {
        const usage = {
          inputTokens: agentEvent.totalInputTokens ?? agentEvent.inputTokens ?? 0,
          outputTokens: agentEvent.totalOutputTokens ?? agentEvent.outputTokens ?? 0,
          cacheReadTokens: agentEvent.totalCacheReadTokens ?? agentEvent.cacheReadTokens ?? 0,
          cacheWriteTokens: agentEvent.totalCacheWriteTokens ?? agentEvent.cacheWriteTokens ?? 0,
          totalCost: agentEvent.totalCost,
        };
        void readRunUsage(providerId, modelId, usage).then((snapshot) => {
          if (snapshot) {
            latestUsage = snapshot;
            callbacks.onUsage?.(snapshot);
          }
        }).catch(() => undefined);
      }
      if (agentEvent.type === "done") {
        if (agentEvent.usage) {
          void readRunUsage(providerId, modelId, {
            inputTokens: agentEvent.usage.totalInputTokens ?? agentEvent.usage.inputTokens ?? 0,
            outputTokens: agentEvent.usage.totalOutputTokens ?? agentEvent.usage.outputTokens ?? 0,
            cacheReadTokens: agentEvent.usage.totalCacheReadTokens ?? agentEvent.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: agentEvent.usage.totalCacheWriteTokens ?? agentEvent.usage.cacheWriteTokens ?? 0,
            totalCost: agentEvent.usage.totalCost,
          }).then((snapshot) => {
            if (snapshot) {
              latestUsage = snapshot;
              callbacks.onUsage?.(snapshot);
            }
          }).catch(() => undefined);
        }
        resolveEnded({ text: redactSecrets(agentEvent.text) ?? "", finishReason: normalizeFinishReason(agentEvent.reason), usage: agentEvent.usage });
      }
      if (agentEvent.type === "error") rejectEnded(new Error(safeErrorMessage(agentEvent.error)));
    } else if (event.type === "chunk" && payload.chunk) {
      callbacks.onEvent("chunk", "Agent output", redactSecrets(payload.chunk.slice(-1000)));
    } else if (event.type === "ended") {
      resolveEnded({ text: "", finishReason: normalizeFinishReason((event.payload as { reason?: string }).reason) });
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
    callbacks.onEvent("session_started", "Cline session started", sessionId);
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