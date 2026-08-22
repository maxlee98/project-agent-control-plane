import { startAgentRun } from "@/lib/server/orchestrator";
import { isRunClaimError } from "@/lib/server/repository";
import { isReasoningEffort, type ReasoningEffort } from "@/lib/domain";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const body = await request.json().catch(() => ({})) as { mode?: "start" | "continue" | "retry"; reasoningEffort?: unknown };
  if (body.reasoningEffort !== undefined && body.reasoningEffort !== null && body.reasoningEffort !== "" && !isReasoningEffort(body.reasoningEffort)) {
    return Response.json({ error: "Reasoning effort must be one of the supported effort values." }, { status: 400 });
  }
  let run;
  try {
    run = startAgentRun(taskId, body.mode ?? "start", undefined, body.reasoningEffort as ReasoningEffort | null | undefined);
  } catch (error) {
    if (isRunClaimError(error)) return Response.json({ error: error.message, code: error.code }, { status: error.statusCode });
    return Response.json({ error: error instanceof Error ? error.message : "Reasoning effort is not supported by the configured model." }, { status: 400 });
  }
  if (!run) return Response.json({ error: "Task not found." }, { status: 404 });
  // AgentRun also carries an `error` field (normally null), so presence alone
  // cannot distinguish the guard response from a successful run.
  if ("error" in run && typeof run.error === "string") return Response.json(run, { status: 409 });
  return Response.json(run, { status: 201 });
}