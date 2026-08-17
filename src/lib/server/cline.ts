import { ClineCore } from "@cline/sdk";
import type { AgentRunInput } from "../integrations";

export interface ClineCallbacks {
  onActivity(message: string, detail?: string): void;
  onEvent(type: string, message: string, detail?: string): void;
}

const activeSessions = new Map<string, { cline: ClineCore; sessionId: string }>();

export async function runCline(input: AgentRunInput & { runId: string }, callbacks: ClineCallbacks) {
  const cline = await ClineCore.create({ clientName: "project-agent-control-plane", backendMode: "local" });
  let sessionId = "";
  let resolveEnded: (value: { text: string }) => void = () => undefined;
  let rejectEnded: (reason: Error) => void = () => undefined;
  const ended = new Promise<{ text: string }>((resolve, reject) => { resolveEnded = resolve; rejectEnded = reject; });
  const unsubscribe = cline.subscribe((event) => {
    const payload = event.payload as { sessionId?: string; event?: { type?: string; text?: string; message?: string; toolName?: string; error?: Error }; reason?: string; chunk?: string };
    if (payload.sessionId && sessionId && payload.sessionId !== sessionId) return;
    if (event.type === "agent_event" && payload.event) {
      const agentEvent = payload.event;
      const detail = agentEvent.type === "error" ? agentEvent.error?.message : agentEvent.type === "content_end" ? agentEvent.text : agentEvent.type === "notice" ? agentEvent.message : agentEvent.toolName;
      callbacks.onEvent(agentEvent.type ?? "agent_event", agentEvent.type ?? "Agent event", detail);
      if (agentEvent.type === "content_start" || agentEvent.type === "notice") callbacks.onActivity(agentEvent.message ?? agentEvent.toolName ?? agentEvent.type, detail);
      if (agentEvent.type === "done") resolveEnded({ text: agentEvent.text ?? "" });
      if (agentEvent.type === "error") rejectEnded(agentEvent.error instanceof Error ? agentEvent.error : new Error("Cline reported an error."));
    } else if (event.type === "chunk" && payload.chunk) {
      callbacks.onEvent("chunk", "Agent output", payload.chunk.slice(-1000));
    } else if (event.type === "ended") {
      resolveEnded({ text: "" });
    }
  });
  try {
    const result = await cline.start({
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
    sessionId = result.sessionId;
    activeSessions.set(input.runId, { cline, sessionId });
    callbacks.onEvent("session_started", "Cline session started", sessionId);
    return { sessionId, ...(await ended) };
  } finally {
    activeSessions.delete(input.runId);
    unsubscribe();
    await cline.dispose();
  }
}

export async function stopClineRun(runId: string) {
  const active = activeSessions.get(runId);
  if (active) await active.cline.stop(active.sessionId);
}