import { createIssue, reconcileTaskStatus } from "@/lib/server/github";
import { claimIdempotencyKey, completeIdempotencyKey, createTask, getProject } from "@/lib/server/repository";
import { parseEstimatedCostCents } from "@/lib/server/cost";
import { API_LIMITS, apiError, apiErrorFrom, apiResponse, assertAllowedKeys, getIdempotencyKey, idempotencyResponse, optionalEnum, optionalInteger, optionalString, optionalStringArray, parseJsonBody, requestFingerprint, requiredString, validateIdentifier } from "@/lib/server/api";
import { BOARD_COLUMNS, type TaskStatus } from "@/lib/domain";

export async function POST(request: Request) {
  let key: string | null = null;
  let operation = "task.create";
  let fingerprint = "";
  try {
    const body = await parseJsonBody(request);
    assertAllowedKeys(body, ["projectId", "title", "description", "estimatedCostUsd", "status", "priority", "labels"]);
    const projectId = validateIdentifier(requiredString(body, "projectId", API_LIMITS.identifier), "projectId");
    const title = requiredString(body, "title", API_LIMITS.taskTitle);
    const description = optionalString(body, "description", API_LIMITS.taskDescription);
    const taskStatuses = BOARD_COLUMNS.map((column) => column.id) as readonly TaskStatus[];
    const status = optionalEnum(body, "status", taskStatuses) ?? "inbox";
    const priority = optionalInteger(body, "priority", 1, 4);
    const labels = optionalStringArray(body, "labels", API_LIMITS.labels, API_LIMITS.label);
    const estimatedCostCents = parseEstimatedCostCents(body.estimatedCostUsd);
    if (estimatedCostCents === null || estimatedCostCents > API_LIMITS.estimatedCostCents) throw new Error("invalid cost");
    const project = getProject(projectId);
    if (!project) return apiError("PROJECT_NOT_FOUND", "Project not found.", 404);
    key = getIdempotencyKey(request);
    fingerprint = requestFingerprint({ projectId, title, description, status, priority, labels, estimatedCostCents });
    const claim = claimIdempotencyKey(key!, operation, fingerprint);
    if (claim.kind !== "new") return claim.kind === "replay" ? apiResponse(claim.response, claim.status) : idempotencyResponse(claim);
    let issue: { number: number; url: string; nodeId: string } | undefined;
    let remoteSync: { projectChanged: boolean; issueChanged: boolean } | null = null;
    let syncWarning: string | null = null;
    try {
      if (process.env.EXECUTION_MODE === "live") {
        issue = await createIssue(project.fullName, title, description ?? "");
        if (!project.githubProjectId) syncWarning = "GitHub Issue created, but this repository has no Projects V2 ID configured.";
        else {
          try { remoteSync = await reconcileTaskStatus(project, { issueNumber: issue.number, title, description: description ?? "", githubUrl: issue.url }, status); }
          catch { syncWarning = "GitHub Issue created, but Projects V2 synchronization needs retry."; }
        }
      }
      const task = createTask({ projectId, title, description, estimatedCostCents, status, priority, labels, issueNumber: issue?.number, githubUrl: issue?.url });
      const responseStatus = syncWarning ? 207 : 201;
      const payload = { ...task, remoteSync, syncWarning };
      completeIdempotencyKey(key!, operation, fingerprint, payload, responseStatus);
      return apiResponse(payload, responseStatus);
    } catch {
      const payload = { code: "TASK_CREATE_FAILED", message: "The task could not be created. Check the remote connection and try again with a new request key." };
      completeIdempotencyKey(key!, operation, fingerprint, payload, 502);
      return apiResponse(payload, 502);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "invalid cost") return apiError("INVALID_COST", "Estimated cost must be a non-negative USD amount within the supported limit.", 400);
    return apiErrorFrom(error, "The task request could not be completed.");
  }
}