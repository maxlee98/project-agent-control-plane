import { listProjectItems, reconcileProjectItemLifecycle, reconcileResolvedTaskStatus, resolveTaskIssue } from "@/lib/server/github";
import { getProject, getTaskByIssue, getTasksByProject, touchProject, updateTaskIssue, upsertSyncedTask } from "@/lib/server/repository";

export async function POST(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (process.env.EXECUTION_MODE !== "live") { touchProject(projectId); return Response.json({ ok: true, mode: "demo", count: 0, repairedIssues: 0, syncedAt: new Date().toISOString() }); }
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  try {
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
    return Response.json({ ok: true, mode: "live", count: items.length, imported, updated, repairedIssues, createdIssues, correctedIssues, addedProjectItems, syncedAt: new Date().toISOString() });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub sync failed." }, { status: 502 }); }
}