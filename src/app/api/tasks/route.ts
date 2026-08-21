import { createIssue, reconcileTaskStatus } from "@/lib/server/github";
import { createTask, getProject } from "@/lib/server/repository";
import { parseEstimatedCostCents } from "@/lib/server/cost";

export async function POST(request: Request) {
  const body = await request.json() as { projectId?: string; title?: string; description?: string; estimatedCostUsd?: unknown; status?: "inbox" | "ready"; priority?: number; labels?: string[] };
  if (!body.projectId || !body.title?.trim()) return Response.json({ error: "A project and task title are required." }, { status: 400 });
  const estimatedCostCents = parseEstimatedCostCents(body.estimatedCostUsd);
  if (estimatedCostCents === null) return Response.json({ error: "Estimated cost must be a non-negative USD amount." }, { status: 400 });
  const project = getProject(body.projectId);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  let issue: { number: number; url: string; nodeId: string } | undefined;
  let remoteSync: { projectChanged: boolean; issueChanged: boolean } | null = null;
  let syncWarning: string | null = null;
  if (process.env.EXECUTION_MODE === "live") {
    try { issue = await createIssue(project.fullName, body.title.trim(), body.description?.trim() ?? ""); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub issue creation failed." }, { status: 502 }); }
    if (!project.githubProjectId) {
      syncWarning = "GitHub Issue created, but this repository has no Projects V2 ID configured.";
    } else {
      try {
        remoteSync = await reconcileTaskStatus(project, {
          issueNumber: issue.number,
          title: body.title.trim(),
          description: body.description?.trim() ?? "",
          githubUrl: issue.url,
        }, body.status ?? "inbox");
      } catch (error) {
        syncWarning = `GitHub Issue created, but Projects V2 synchronization needs retry: ${error instanceof Error ? error.message : "remote synchronization failed."}`;
      }
    }
  }
  const task = createTask({ projectId: body.projectId, title: body.title.trim(), description: body.description?.trim(), estimatedCostCents, status: body.status, priority: body.priority, labels: body.labels, issueNumber: issue?.number, githubUrl: issue?.url });
  return Response.json({ ...task, remoteSync, syncWarning }, { status: syncWarning ? 207 : 201 });
}