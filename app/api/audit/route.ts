import { auditService } from "@/lib/audit/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  try {
    const events = await auditService.recent(Math.min(Math.max(limit, 1), 200));
    return Response.json({ events });
  } catch (err) {
    return Response.json({ error: "Could not load audit log.", detail: String(err) }, { status: 500 });
  }
}
