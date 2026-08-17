import { getRunEvents } from "@/lib/server/repository";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return Response.json({ events: getRunEvents(runId) });
}