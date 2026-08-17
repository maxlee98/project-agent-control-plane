import { createProject } from "@/lib/server/repository";

export async function POST(request: Request) {
  const body = await request.json() as { fullName?: string; localPath?: string; description?: string; githubProjectId?: string };
  if (!body.fullName?.includes("/") || !body.localPath?.trim()) return Response.json({ error: "Repository and local checkout are required." }, { status: 400 });
  try { return Response.json(createProject({ fullName: body.fullName.trim(), localPath: body.localPath.trim(), description: body.description?.trim(), githubProjectId: body.githubProjectId?.trim() })); }
  catch { return Response.json({ error: "That repository is already registered or could not be added." }, { status: 409 }); }
}