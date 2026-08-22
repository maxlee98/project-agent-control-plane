import { createProject, claimIdempotencyKey, completeIdempotencyKey } from "@/lib/server/repository";
import { API_LIMITS, apiError, apiErrorFrom, assertAllowedKeys, getIdempotencyKey, idempotencyResponse, optionalString, parseJsonBody, requiredString, requestFingerprint, validatePath, validateProjectNodeId, validateRepository, apiResponse } from "@/lib/server/api";

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    assertAllowedKeys(body, ["fullName", "localPath", "description", "githubProjectId"]);
    const fullName = validateRepository(requiredString(body, "fullName", API_LIMITS.repository));
    const localPath = validatePath(requiredString(body, "localPath", API_LIMITS.path));
    const description = optionalString(body, "description", API_LIMITS.projectDescription);
    const githubProjectIdValue = optionalString(body, "githubProjectId", API_LIMITS.identifier);
    const githubProjectId = githubProjectIdValue ? validateProjectNodeId(githubProjectIdValue) : githubProjectIdValue;
    const key = getIdempotencyKey(request);
    const operation = "project.create";
    const fingerprint = requestFingerprint({ fullName, localPath, description, githubProjectId });
    const claim = claimIdempotencyKey(key!, operation, fingerprint);
    if (claim.kind !== "new") return claim.kind === "replay" ? apiResponse(claim.response, claim.status) : idempotencyResponse(claim);
    try {
      const response = apiResponse(createProject({ fullName, localPath, description, githubProjectId }), 201);
      completeIdempotencyKey(key!, operation, fingerprint, await response.clone().json(), 201);
      return response;
    } catch {
      const response = apiError("PROJECT_CREATE_FAILED", "The repository could not be added. Check the repository details and try again with a new request key.", 409);
      completeIdempotencyKey(key!, operation, fingerprint, await response.clone().json(), 409);
      return response;
    }
  } catch (error) {
    return apiErrorFrom(error, "The repository request could not be completed.");
  }
}