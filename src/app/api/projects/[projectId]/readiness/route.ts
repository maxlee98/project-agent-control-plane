import { assessProjectReadiness } from "@/lib/server/readiness";
import { apiError, apiErrorFrom, apiResponse, validateIdentifier } from "@/lib/server/api";
import { getProject, saveProjectReadiness } from "@/lib/server/repository";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const projectId = validateIdentifier((await params).projectId, "projectId");
    const project = getProject(projectId);
    if (!project) return apiError("PROJECT_NOT_FOUND", "Project not found.", 404);
    const report = await assessProjectReadiness(project);
    return apiResponse(saveProjectReadiness(project.id, report));
  } catch (error) {
    return apiErrorFrom(error, "Repository readiness could not be assessed.");
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const projectId = validateIdentifier((await params).projectId, "projectId");
    const project = getProject(projectId);
    if (!project) return apiError("PROJECT_NOT_FOUND", "Project not found.", 404);
    return apiResponse({ readiness: project.readiness ?? null });
  } catch (error) {
    return apiErrorFrom(error, "Repository readiness could not be loaded.");
  }
}