import { getDashboard } from "@/lib/server/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getDashboard());
}