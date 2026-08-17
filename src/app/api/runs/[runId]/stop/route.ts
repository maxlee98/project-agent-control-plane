import { stopAgentRun } from "@/lib/server/orchestrator";

export async function POST(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = stopAgentRun(runId);
  return run ? Response.json(run) : Response.json({ error: "Run not found." }, { status: 404 });
}