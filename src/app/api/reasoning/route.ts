import { getConfiguredReasoningCapability } from "@/lib/server/reasoning";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getConfiguredReasoningCapability());
}