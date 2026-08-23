import { createSelectedFollowUps, normalizeFollowUpProposals } from "@/lib/server/follow-ups";
import { claimIdempotencyKey, completeIdempotencyKey, getProject, getTask } from "@/lib/server/repository";
import { API_LIMITS, apiError, apiErrorFrom, apiResponse, assertAllowedKeys, getIdempotencyKey, idempotencyResponse, parseJsonBody, requestFingerprint, validateIdentifier } from "@/lib/server/api";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  let key: string | null = null;
  let fingerprint = "";
  try {
    const taskId = validateIdentifier((await params).taskId, "taskId");
    const body = await parseJsonBody(request);
    assertAllowedKeys(body, ["proposals"]);
    const task = getTask(taskId);
    const project = task ? getProject(task.projectId) : null;
    if (!task || !project) return apiError("TASK_NOT_FOUND", "Task not found.", 404);
    if (task.status !== "done" && task.status !== "human_review") return apiError("FOLLOW_UPS_NOT_AVAILABLE", "Follow-ups can only be created from a Done or Review task.", 409);
    const proposals = normalizeFollowUpProposals(body.proposals, API_LIMITS.followUpProposals);
    key = getIdempotencyKey(request);
    fingerprint = requestFingerprint({ taskId, proposals });
    const claim = claimIdempotencyKey(key!, "task.follow-ups.create", fingerprint);
    if (claim.kind !== "new") return claim.kind === "replay" ? apiResponse(claim.response, claim.status) : idempotencyResponse(claim);
    try {
      const outcomes = await createSelectedFollowUps(task, project, proposals);
      const failed = outcomes.filter((outcome) => outcome.result === "failed").length;
      const status = failed === 0 ? 201 : failed === outcomes.length ? 502 : 207;
      const payload = { taskId, mode: process.env.EXECUTION_MODE === "live" ? "live" : "demo", noGithubRequest: process.env.EXECUTION_MODE !== "live", outcomes };
      completeIdempotencyKey(key!, "task.follow-ups.create", fingerprint, payload, status);
      return apiResponse(payload, status);
    } catch {
      const payload = { code: "FOLLOW_UP_CREATE_FAILED", message: "The selected follow-ups could not be created. Check the connection and retry with a new request key." };
      completeIdempotencyKey(key!, "task.follow-ups.create", fingerprint, payload, 502);
      return apiResponse(payload, 502);
    }
  } catch (error) {
    return apiErrorFrom(error, "Selected follow-ups could not be created.");
  }
}