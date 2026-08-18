import { startAgentRun } from "@/lib/server/orchestrator";
import { db } from "@/lib/server/db";

export async function POST(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const row = db.prepare("SELECT task_id FROM runs WHERE id = ?").get(runId) as { task_id?: string } | undefined;
  if (!row?.task_id) return Response.json({ error: "Run not found." }, { status: 404 });
  const run = startAgentRun(row.task_id, "retry", runId);
  if (!run) return Response.json({ error: "Could not retry this run." }, { status: 409 });
  return Response.json(run);
}