import { recommendFollowUps, recommendationActivityDetail } from "@/lib/server/follow-ups";
import { addActivity, claimIdempotencyKey, completeIdempotencyKey, getProject, getTask } from "@/lib/server/repository";
import { API_LIMITS, apiError, apiErrorFrom, apiResponse, assertAllowedKeys, getIdempotencyKey, idempotencyResponse, optionalInteger, parseJsonBody, requestFingerprint, validateIdentifier } from "@/lib/server/api";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  let key: string | null = null;
  let fingerprint = "";
  let activityContext: { projectId: string; taskId: string } | null = null;
  try {
    const taskId = validateIdentifier((await params).taskId, "taskId");
    const body = await parseJsonBody(request, { allowEmpty: true });
    assertAllowedKeys(body, ["count"]);
    const requestedCount = optionalInteger(body, "count", 1, API_LIMITS.followUpProposals) ?? API_LIMITS.followUpProposals;
    const task = getTask(taskId);
    const project = task ? getProject(task.projectId) : null;
    if (!task || !project) return apiError("TASK_NOT_FOUND", "Task not found.", 404);
    activityContext = { projectId: task.projectId, taskId: task.id };
    if (task.status !== "done" && task.status !== "human_review") return apiError("FOLLOW_UPS_NOT_AVAILABLE", "Follow-ups can only be recommended for Done or Review tasks.", 409);
    key = getIdempotencyKey(request);
    fingerprint = requestFingerprint({ taskId, requestedCount });
    const claim = claimIdempotencyKey(key!, "task.follow-ups.recommend", fingerprint);
    if (claim.kind !== "new") return claim.kind === "replay" ? apiResponse(claim.response, claim.status) : idempotencyResponse(claim);
    try {
      const proposals = await recommendFollowUps(task, project, requestedCount);
      addActivity({ projectId: task.projectId, taskId: task.id, type: "follow_up_recommendation", title: "Follow-up proposals prepared", detail: recommendationActivityDetail(proposals.length), tone: "violet" });
      const payload = { taskId: task.id, mode: process.env.EXECUTION_MODE === "live" ? "live" : "demo", proposals };
      completeIdempotencyKey(key!, "task.follow-ups.recommend", fingerprint, payload, 200);
      return apiResponse(payload);
    } catch {
      addActivity({ projectId: task.projectId, taskId: task.id, type: "follow_up_recommendation_failed", title: "Follow-up recommendations failed", detail: "Recommendations could not be prepared; review the connection and try again.", tone: "red" });
      const payload = { code: "FOLLOW_UP_RECOMMENDATION_FAILED", message: "Follow-up recommendations could not be prepared. Check the connection and try again with a new request key." };
      completeIdempotencyKey(key!, "task.follow-ups.recommend", fingerprint, payload, 502);
      return apiResponse(payload, 502);
    }
  } catch (error) {
    if (activityContext) addActivity({ ...activityContext, type: "follow_up_recommendation_failed", title: "Follow-up recommendations failed", detail: "Recommendations could not be prepared; review the connection and try again.", tone: "red" });
    return apiErrorFrom(error, "Follow-up recommendations could not be prepared.");
  }
}