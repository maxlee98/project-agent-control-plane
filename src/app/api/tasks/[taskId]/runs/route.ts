import { startAgentRun } from "@/lib/server/orchestrator";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const body = await request.json().catch(() => ({})) as { mode?: "start" | "continue" | "retry" };
  const run = startAgentRun(taskId, body.mode ?? "start");
  if (!run) return Response.json({ error: "Task not found." }, { status: 404 });
  // AgentRun also carries an `error` field (normally null), so presence alone
  // cannot distinguish the guard response from a successful run.
  if ("error" in run && typeof run.error === "string") return Response.json(run, { status: 409 });
  return Response.json(run, { status: 201 });
}