import { getDashboard } from "@/lib/server/repository";
import { apiError, apiResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return apiResponse(getDashboard());
  } catch {
    return apiError("DASHBOARD_UNAVAILABLE", "The dashboard could not be loaded. Retry the request.", 503);
  }
}