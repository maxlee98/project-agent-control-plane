import { publishComment, reconcileTaskStatus } from "@/lib/server/github";
import { addTaskComment, claimIdempotencyKey, completeIdempotencyKey, completeTaskByHuman, getProject, getTask, updateTask, updateTaskIssue } from "@/lib/server/repository";
import { parseEstimatedCostCents } from "@/lib/server/cost";
import { API_LIMITS, apiError, apiErrorFrom, apiResponse, assertAllowedKeys, getIdempotencyKey, idempotencyResponse, optionalEnum, optionalInteger, optionalNonEmptyString, optionalString, parseJsonBody, requestFingerprint, validateIdentifier } from "@/lib/server/api";
import { BOARD_COLUMNS, normalizeTaskStatus, type Project, type Task, type TaskStatus } from "@/lib/domain";

type SyncableTask = Pick<Task, "id" | "issueNumber" | "title" | "description" | "githubUrl">;

async function syncTaskStatus(project: Project, task: SyncableTask, status: TaskStatus) {
  const remote = await reconcileTaskStatus(project, task, status);
  if (remote.issueCorrected) updateTaskIssue(task.id, remote.issueNumber, remote.githubUrl);
  return remote;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId: rawTaskId } = await params;
    const taskId = validateIdentifier(rawTaskId, "taskId");
    const body = await parseJsonBody(request);
    assertAllowedKeys(body, ["status", "priority", "title", "description", "estimatedCostUsd", "comment"]);
    const task = getTask(taskId);
    const project = task ? getProject(task.projectId) : null;
    if (!task || !project) return apiError("TASK_NOT_FOUND", "Task not found.", 404);
    const rawStatus = optionalEnum(body, "status", [...BOARD_COLUMNS.map((column) => column.id), "agent_review", "in_review", "review"] as const);
    const status = rawStatus === undefined ? undefined : normalizeTaskStatus(rawStatus);
    const priority = optionalInteger(body, "priority", 1, 4);
    const title = optionalNonEmptyString(body, "title", API_LIMITS.taskTitle);
    const description = optionalString(body, "description", API_LIMITS.taskDescription);
    const comment = optionalNonEmptyString(body, "comment", API_LIMITS.comment);
    const estimatedCostCents = body.estimatedCostUsd === undefined ? undefined : parseEstimatedCostCents(body.estimatedCostUsd);
    if (estimatedCostCents === null || (estimatedCostCents !== undefined && estimatedCostCents > API_LIMITS.estimatedCostCents)) return apiError("INVALID_COST", "Estimated cost must be a non-negative USD amount within the supported limit.", 400, { field: "estimatedCostUsd" });
    const remoteMutation = Boolean(comment || status);
    if (comment && (status || priority !== undefined || title !== undefined || description !== undefined || estimatedCostCents !== undefined)) return apiError("VALIDATION_ERROR", "A comment cannot be combined with another task mutation.", 400);
    if (!comment && status === undefined && priority === undefined && title === undefined && description === undefined && estimatedCostCents === undefined) return apiError("VALIDATION_ERROR", "At least one task field is required.", 400);
    if (!remoteMutation) {
      const updated = updateTask(taskId, { status, priority, title, description, estimatedCostCents });
      return updated ? apiResponse(updated) : apiError("TASK_NOT_FOUND", "Task not found.", 404);
    }
    const key = getIdempotencyKey(request);
    const operation = comment ? "task.comment" : "task.status";
    const fingerprint = requestFingerprint({ taskId, status: status ?? null, comment: comment ?? null });
    const claim = claimIdempotencyKey(key!, operation, fingerprint);
    if (claim.kind !== "new") return claim.kind === "replay" ? apiResponse(claim.response, claim.status) : idempotencyResponse(claim);
    try {
      if (comment) {
        if (process.env.EXECUTION_MODE === "live" && task.issueNumber) await publishComment(project.fullName, task.issueNumber, comment);
        const payload = addTaskComment(taskId, comment);
        completeIdempotencyKey(key!, operation, fingerprint, payload, 200);
        return apiResponse(payload);
      }
      let remote: Awaited<ReturnType<typeof syncTaskStatus>> | null = null;
      if (process.env.EXECUTION_MODE === "live") remote = await syncTaskStatus(project, task, status!);
      const updated = status === "done" ? completeTaskByHuman(taskId) : updateTask(taskId, { status });
      const payload = updated ? { ...updated, remoteSync: remote } : null;
      if (!payload) {
        const errorPayload = { code: "TASK_NOT_FOUND", message: "Task not found." };
        completeIdempotencyKey(key!, operation, fingerprint, errorPayload, 404);
        return apiResponse(errorPayload, 404);
      }
      completeIdempotencyKey(key!, operation, fingerprint, payload, 200);
      return apiResponse(payload);
    } catch {
      const errorPayload = { code: "REMOTE_MUTATION_FAILED", message: comment ? "Comment could not be published. Check the connection and try again with a new request key." : "Task status could not be synchronized. Check the connection and try again with a new request key." };
      completeIdempotencyKey(key!, operation, fingerprint, errorPayload, 502);
      return apiResponse(errorPayload, 502);
    }
  } catch (error) {
    return apiErrorFrom(error, "The task mutation could not be completed.");
  }
}