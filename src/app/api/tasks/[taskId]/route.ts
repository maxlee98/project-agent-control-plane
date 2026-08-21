import { publishComment, reconcileTaskStatus } from "@/lib/server/github";
import { addTaskComment, completeTaskByHuman, getProject, getTask, updateTask, updateTaskIssue } from "@/lib/server/repository";
import { parseEstimatedCostCents } from "@/lib/server/cost";
import type { Project, Task, TaskStatus } from "@/lib/domain";

type SyncableTask = Pick<Task, "id" | "issueNumber" | "title" | "description" | "githubUrl">;

async function syncTaskStatus(project: Project, task: SyncableTask, status: TaskStatus) {
  const remote = await reconcileTaskStatus(project, task, status);
  if (remote.issueCorrected) updateTaskIssue(task.id, remote.issueNumber, remote.githubUrl);
  return remote;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const body = await request.json() as { status?: "inbox" | "ready" | "in_progress" | "agent_review" | "human_review" | "blocked" | "done"; priority?: number; title?: string; description?: string; estimatedCostUsd?: unknown; comment?: string };
  const estimatedCostCents = body.estimatedCostUsd === undefined ? undefined : parseEstimatedCostCents(body.estimatedCostUsd);
  if (estimatedCostCents === null) return Response.json({ error: "Estimated cost must be a non-negative USD amount." }, { status: 400 });
  if (body.comment?.trim()) {
    const task = getTask(taskId);
    const project = task ? getProject(task.projectId) : null;
    if (!task || !project) return Response.json({ error: "Task not found." }, { status: 404 });
    if (process.env.EXECUTION_MODE === "live" && task.issueNumber) {
      try { await publishComment(project.fullName, task.issueNumber, body.comment.trim()); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub comment failed." }, { status: 502 }); }
    }
    return Response.json(addTaskComment(taskId, body.comment.trim()));
  }
  if (body.status === "done") {
    const currentTask = getTask(taskId);
    const currentProject = currentTask ? getProject(currentTask.projectId) : null;
    if (!currentTask || !currentProject) return Response.json({ error: "Task not found." }, { status: 404 });
    let remote;
    if (process.env.EXECUTION_MODE === "live") {
      try { remote = await syncTaskStatus(currentProject, currentTask, body.status); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub status synchronization failed." }, { status: 502 }); }
    }
    const task = completeTaskByHuman(taskId);
    return task ? Response.json({ ...task, remoteSync: remote ?? null }) : Response.json({ error: "Task not found." }, { status: 404 });
  }
  let remote;
  if (body.status) {
    const currentTask = getTask(taskId);
    const currentProject = currentTask ? getProject(currentTask.projectId) : null;
    if (!currentTask || !currentProject) return Response.json({ error: "Task not found." }, { status: 404 });
    if (process.env.EXECUTION_MODE === "live") {
      try { remote = await syncTaskStatus(currentProject, currentTask, body.status); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub status synchronization failed." }, { status: 502 }); }
    }
  }
  const task = updateTask(taskId, { status: body.status, priority: body.priority, title: body.title, description: body.description, estimatedCostCents });
  return task ? Response.json({ ...task, remoteSync: remote ?? null }) : Response.json({ error: "Task not found." }, { status: 404 });
}