import { prepareBaselinePullRequest } from "@/lib/server/baseline";
import { apiError, apiErrorFrom, apiResponse, assertAllowedKeys, getIdempotencyKey, idempotencyResponse, parseJsonBody, requestFingerprint, validateIdentifier } from "@/lib/server/api";
import { claimIdempotencyKey, completeIdempotencyKey, getProject } from "@/lib/server/repository";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  let key: string | null = null;
  const operation = "project.baseline";
  let fingerprint = "";
  try {
    const projectId = validateIdentifier((await params).projectId, "projectId");
    const body = await parseJsonBody(request);
    assertAllowedKeys(body, ["approve"]);
    if (body.approve !== true) return apiError("BASELINE_APPROVAL_REQUIRED", "Explicit approval is required before a baseline pull request can be prepared.", 400);
    const project = getProject(projectId);
    if (!project) return apiError("PROJECT_NOT_FOUND", "Project not found.", 404);
    key = getIdempotencyKey(request);
    fingerprint = requestFingerprint({ projectId, approve: true });
    const claim = claimIdempotencyKey(key!, operation, fingerprint);
    if (claim.kind !== "new") return claim.kind === "replay" ? apiResponse(claim.response, claim.status) : idempotencyResponse(claim);
    try {
      const result = await prepareBaselinePullRequest(project);
      const payload = "alreadyPresent" in result ? { alreadyPresent: true, files: [], message: "The repository already has the requested baseline files." } : { ...result, message: "Baseline pull request opened for human review. It was not merged automatically." };
      completeIdempotencyKey(key!, operation, fingerprint, payload, 201);
      return apiResponse(payload, 201);
    } catch {
      const payload = { code: "BASELINE_PREPARATION_FAILED", message: "The baseline pull request could not be prepared. Check the checkout and GitHub connection, then retry with a new request key." };
      completeIdempotencyKey(key!, operation, fingerprint, payload, 502);
      return apiResponse(payload, 502);
    }
  } catch (error) {
    return apiErrorFrom(error, "The baseline request could not be completed.");
  }
}