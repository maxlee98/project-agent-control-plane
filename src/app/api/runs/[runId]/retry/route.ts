import { startAgentRun } from "@/lib/server/orchestrator";
import { db } from "@/lib/server/db";
import { isReasoningEffort, type ReasoningEffort } from "@/lib/domain";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const row = db.prepare("SELECT task_id FROM runs WHERE id = ?").get(runId) as { task_id?: string } | undefined;
  if (!row?.task_id) return Response.json({ error: "Run not found." }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { reasoningEffort?: unknown };
  if (body.reasoningEffort !== undefined && body.reasoningEffort !== null && body.reasoningEffort !== "" && !isReasoningEffort(body.reasoningEffort)) {
    return Response.json({ error: "Reasoning effort must be one of the supported effort values." }, { status: 400 });
  }
  let run;
  try {
    run = startAgentRun(row.task_id, "retry", runId, body.reasoningEffort as ReasoningEffort | null | undefined);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Reasoning effort is not supported by the configured model." }, { status: 400 });
  }
  if (!run) return Response.json({ error: "Could not retry this run." }, { status: 409 });
  return Response.json(run);
}