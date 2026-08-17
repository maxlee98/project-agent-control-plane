import { createIssue } from "@/lib/server/github";
import { createTask, getProject } from "@/lib/server/repository";

export async function POST(request: Request) {
  const body = await request.json() as { projectId?: string; title?: string; description?: string; status?: "inbox" | "ready"; priority?: number; labels?: string[] };
  if (!body.projectId || !body.title?.trim()) return Response.json({ error: "A project and task title are required." }, { status: 400 });
  const project = getProject(body.projectId);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  let issue: { number: number; url: string } | undefined;
  if (process.env.EXECUTION_MODE === "live") {
    try { issue = await createIssue(project.fullName, body.title.trim(), body.description?.trim() ?? ""); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub issue creation failed." }, { status: 502 }); }
  }
  const task = createTask({ projectId: body.projectId, title: body.title.trim(), description: body.description?.trim(), status: body.status, priority: body.priority, labels: body.labels, issueNumber: issue?.number, githubUrl: issue?.url });
  return Response.json(task, { status: 201 });
}