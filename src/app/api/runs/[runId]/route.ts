import { getRun, getRunEvents } from "@/lib/server/repository";
import { apiError, apiErrorFrom, apiResponse, validateIdentifier } from "@/lib/server/api";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId: rawRunId } = await params;
  try {
    const runId = validateIdentifier(rawRunId, "runId");
    if (!getRun(runId)) return apiError("RUN_NOT_FOUND", "Run not found.", 404);
    return apiResponse({ events: getRunEvents(runId) });
  } catch (error) {
    return apiErrorFrom(error, "The run events request could not be completed.");
  }
}