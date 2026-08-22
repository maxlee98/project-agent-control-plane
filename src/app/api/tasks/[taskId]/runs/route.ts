import { startAgentRun } from "@/lib/server/orchestrator";
import { claimIdempotencyKey, completeIdempotencyKey, getTask, isRunClaimError } from "@/lib/server/repository";
import { isReasoningEffort, type ReasoningEffort } from "@/lib/domain";
import { apiError, apiErrorFrom, apiResponse, assertAllowedKeys, getIdempotencyKey, idempotencyResponse, optionalEnum, parseJsonBody, requestFingerprint, validateIdentifier } from "@/lib/server/api";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId: rawTaskId } = await params;
    const taskId = validateIdentifier(rawTaskId, "taskId");
    const body = await parseJsonBody(request);
    assertAllowedKeys(body, ["mode", "reasoningEffort"]);
    const mode = optionalEnum(body, "mode", ["start", "continue", "retry"] as const) ?? "start";
    const reasoningEffort = body.reasoningEffort;
    if (reasoningEffort !== undefined && reasoningEffort !== null && reasoningEffort !== "" && !isReasoningEffort(reasoningEffort)) {
      return apiError("INVALID_ENUM", "reasoningEffort must be one of the supported effort values.", 400, { field: "reasoningEffort" });
    }
    if (!getTask(taskId)) return apiError("TASK_NOT_FOUND", "Task not found.", 404);
    const key = getIdempotencyKey(request);
    const operation = `run.${mode}`;
    const fingerprint = requestFingerprint({ taskId, mode, reasoningEffort: reasoningEffort || null });
    const claim = claimIdempotencyKey(key!, operation, fingerprint);
    if (claim.kind !== "new") return claim.kind === "replay" ? apiResponse(claim.response, claim.status) : idempotencyResponse(claim);
    let run;
    try {
      run = startAgentRun(taskId, mode, undefined, reasoningEffort as ReasoningEffort | null | undefined);
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
      const payload = { code: "TASK_NOT_FOUND", message: "Task not found." };
      completeIdempotencyKey(key!, operation, fingerprint, payload, 404);
      return apiResponse(payload, 404);
    }
    if ("error" in run && typeof run.error === "string") {
      const payload = { code: "RUN_CONFLICT", message: "This task already has an active run." };
      completeIdempotencyKey(key!, operation, fingerprint, payload, 409);
      return apiResponse(payload, 409);
    }
    completeIdempotencyKey(key!, operation, fingerprint, run, 201);
    return apiResponse(run, 201);
  } catch (error) {
    return apiErrorFrom(error, "The run request could not be completed.");
  }
}