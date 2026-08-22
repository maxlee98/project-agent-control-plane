import { startAgentRun } from "@/lib/server/orchestrator";
import { claimIdempotencyKey, completeIdempotencyKey, getRun, isRunClaimError } from "@/lib/server/repository";
import { isReasoningEffort, type ReasoningEffort } from "@/lib/domain";
import { apiError, apiErrorFrom, apiResponse, assertAllowedKeys, getIdempotencyKey, idempotencyResponse, parseJsonBody, requestFingerprint, validateIdentifier } from "@/lib/server/api";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId: rawRunId } = await params;
    const runId = validateIdentifier(rawRunId, "runId");
    const body = await parseJsonBody(request);
    assertAllowedKeys(body, ["reasoningEffort"]);
    const reasoningEffort = body.reasoningEffort;
    if (reasoningEffort !== undefined && reasoningEffort !== null && reasoningEffort !== "" && !isReasoningEffort(reasoningEffort)) {
      return apiError("INVALID_ENUM", "reasoningEffort must be one of the supported effort values.", 400, { field: "reasoningEffort" });
    }
    const sourceRun = getRun(runId);
    if (!sourceRun) return apiError("RUN_NOT_FOUND", "Run not found.", 404);
    const key = getIdempotencyKey(request);
    const operation = "run.continue";
    const fingerprint = requestFingerprint({ runId, reasoningEffort: reasoningEffort || null });
    const claim = claimIdempotencyKey(key!, operation, fingerprint);
    if (claim.kind !== "new") return claim.kind === "replay" ? apiResponse(claim.response, claim.status) : idempotencyResponse(claim);
    let run;
    try {
      run = startAgentRun(sourceRun.taskId, "continue", runId, reasoningEffort as ReasoningEffort | null | undefined);
    } catch (error) {
      if (isRunClaimError(error)) {
        const payload = { code: error.code, message: error.message };
        completeIdempotencyKey(key!, operation, fingerprint, payload, error.statusCode);
        return apiResponse(payload, error.statusCode);
      }
      const payload = { code: "REASONING_UNSUPPORTED", message: "The selected reasoning effort is not supported by the configured model." };
      completeIdempotencyKey(key!, operation, fingerprint, payload, 400);
      return apiResponse(payload, 400);
    }
    if (!run) {
      const payload = { code: "RUN_CONFLICT", message: "This run could not be continued." };
      completeIdempotencyKey(key!, operation, fingerprint, payload, 409);
      return apiResponse(payload, 409);
    }
    if ("error" in run && typeof run.error === "string") {
      const payload = { code: "RUN_CONFLICT", message: "This task already has an active run." };
      completeIdempotencyKey(key!, operation, fingerprint, payload, 409);
      return apiResponse(payload, 409);
    }
    completeIdempotencyKey(key!, operation, fingerprint, run, 201);
    return apiResponse(run, 201);
  } catch (error) {
    return apiErrorFrom(error, "The run continuation request could not be completed.");
  }
}