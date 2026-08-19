import { listProjectItems, reconcileProjectItemLifecycle } from "@/lib/server/github";
import { getProject, touchProject, upsertSyncedTask } from "@/lib/server/repository";

export async function POST(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (process.env.EXECUTION_MODE !== "live") { touchProject(projectId); return Response.json({ ok: true, mode: "demo", count: 0, repairedIssues: 0, syncedAt: new Date().toISOString() }); }
  const project = getProject(projectId);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  try {
    const items = await listProjectItems(project);
    let repairedIssues = 0;
    for (const item of items) {
      const result = await reconcileProjectItemLifecycle(project, item);
      if (result.issueChanged) repairedIssues += 1;
    }
    items.forEach((item) => upsertSyncedTask({ projectId, ...item }));
    touchProject(projectId);
    return Response.json({ ok: true, mode: "live", count: items.length, repairedIssues, syncedAt: new Date().toISOString() });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub sync failed." }, { status: 502 }); }
}