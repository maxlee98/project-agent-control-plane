import { listProjectItems, reconcileProjectItemLifecycle, reconcileResolvedTaskStatus, resolveTaskIssue } from "@/lib/server/github";
import { claimIdempotencyKey, completeIdempotencyKey, getProject, getTaskByIssue, getTasksByProject, touchProject, updateTaskIssue, upsertSyncedTask } from "@/lib/server/repository";
import { apiError, apiErrorFrom, apiResponse, assertAllowedKeys, getIdempotencyKey, idempotencyResponse, parseJsonBody, requestFingerprint, validateIdentifier } from "@/lib/server/api";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId: rawProjectId } = await params;
  let projectId: string;
  try {
    projectId = validateIdentifier(rawProjectId, "projectId");
    const body = await parseJsonBody(request, { allowEmpty: true });
    assertAllowedKeys(body, []);
  } catch (error) {
    return apiErrorFrom(error, "The sync request could not be completed.");
  }
  const project = getProject(projectId);
  if (!project) return apiError("PROJECT_NOT_FOUND", "Project not found.", 404);
  try {
    const key = getIdempotencyKey(request);
    const operation = "project.sync";
    const fingerprint = requestFingerprint({ projectId });
    const claim = claimIdempotencyKey(key!, operation, fingerprint);
    if (claim.kind !== "new") return claim.kind === "replay" ? apiResponse(claim.response, claim.status) : idempotencyResponse(claim);
    if (process.env.EXECUTION_MODE !== "live") {
      touchProject(projectId);
      const payload = { ok: true, mode: "demo", count: 0, repairedIssues: 0, syncedAt: new Date().toISOString() };
      completeIdempotencyKey(key!, operation, fingerprint, payload, 200);
      return apiResponse(payload);
    }
    let items = await listProjectItems(project);
    let repairedIssues = 0;
    let imported = 0;
    let updated = 0;
    let createdIssues = 0;
    let correctedIssues = 0;
    let addedProjectItems = 0;
    for (const task of getTasksByProject(projectId)) {
      const resolved = await resolveTaskIssue(project, task);
      if (resolved.created) createdIssues += 1;
      if (task.issueNumber !== resolved.issue.number || task.githubUrl !== resolved.issue.url) {
        updateTaskIssue(task.id, resolved.issue.number, resolved.issue.url);
        correctedIssues += 1;
      }
      if (!items.some((item) => item.issueNumber === resolved.issue.number)) {
        const statusSync = await reconcileResolvedTaskStatus(project, resolved.issue, task.status);
        if (statusSync.projectItemAdded) addedProjectItems += 1;
      }
    }
    items = await listProjectItems(project);
    for (const item of items) {
      const result = await reconcileProjectItemLifecycle(project, item);
      if (result.issueChanged) repairedIssues += 1;
      if (getTaskByIssue(projectId, item.issueNumber)) updated += 1;
      else imported += 1;
    }
    items.forEach((item) => upsertSyncedTask({ projectId, ...item }));
    touchProject(projectId);
    const payload = { ok: true, mode: "live", count: items.length, imported, updated, repairedIssues, createdIssues, correctedIssues, addedProjectItems, syncedAt: new Date().toISOString() };
    completeIdempotencyKey(key!, operation, fingerprint, payload, 200);
    return apiResponse(payload);
  } catch (error) {
    if (error instanceof Error && "code" in error) return apiErrorFrom(error, "The sync request could not be completed.");
    return apiError("GITHUB_SYNC_FAILED", "GitHub sync failed. Check the connection and try again.", 502);
  }
}