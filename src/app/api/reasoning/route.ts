import { getConfiguredReasoningCapability } from "@/lib/server/reasoning";
import { apiError, apiResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return apiResponse(await getConfiguredReasoningCapability());
  } catch {
    return apiError("REASONING_UNAVAILABLE", "Reasoning capabilities could not be loaded. Retry the request.", 503);
  }
}