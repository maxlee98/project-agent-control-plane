import { publishComment, reconcileTaskStatus } from "@/lib/server/github";
import { addTaskComment, completeTaskByHuman, getProject, getTask, updateTask } from "@/lib/server/repository";

export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const body = await request.json() as { status?: "inbox" | "ready" | "in_progress" | "agent_review" | "human_review" | "blocked" | "done"; priority?: number; title?: string; description?: string; comment?: string };
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
    if (process.env.EXECUTION_MODE === "live" && currentTask.issueNumber) {
      try { remote = await reconcileTaskStatus(currentProject, currentTask.issueNumber, body.status); }
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
    if (process.env.EXECUTION_MODE === "live" && currentTask.issueNumber) {
      try { remote = await reconcileTaskStatus(currentProject, currentTask.issueNumber, body.status); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub status synchronization failed." }, { status: 502 }); }
    }
  }
  const task = updateTask(taskId, { status: body.status, priority: body.priority, title: body.title, description: body.description });
  return task ? Response.json({ ...task, remoteSync: remote ?? null }) : Response.json({ error: "Task not found." }, { status: 404 });
}