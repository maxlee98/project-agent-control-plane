import { stopAgentRun } from "@/lib/server/orchestrator";
import { getRun } from "@/lib/server/repository";
import { apiError, apiErrorFrom, apiResponse, assertAllowedKeys, parseJsonBody, validateIdentifier } from "@/lib/server/api";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId: rawRunId } = await params;
  try {
    const runId = validateIdentifier(rawRunId, "runId");
    const body = await parseJsonBody(request, { allowEmpty: true });
    assertAllowedKeys(body, []);
    if (!getRun(runId)) return apiError("RUN_NOT_FOUND", "Run not found.", 404);
    const run = stopAgentRun(runId);
    return run ? apiResponse(run) : apiError("RUN_NOT_FOUND", "Run not found.", 404);
  } catch (error) {
    return apiErrorFrom(error, "The stop request could not be completed.");
  }
}