import { prisma } from "@/lib/db";
import type { ControlEventData } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns the stored ControlEvent for a message, for the Control Details panel. */
export async function GET(req: Request) {
  const messageId = new URL(req.url).searchParams.get("messageId");
  if (!messageId) return Response.json({ error: "Missing messageId." }, { status: 400 });

  try {
    const row = await prisma.controlEvent.findUnique({ where: { messageId } });
    if (!row) return Response.json({ error: "No control event for that message." }, { status: 404 });
    let payload: ControlEventData | null = null;
    try { payload = JSON.parse(row.payload) as ControlEventData; } catch { payload = null; }
    return Response.json({ event: payload, summary: {
      decision: row.decision, performance: row.performanceResult,
      responsibility: row.responsibilityResult, cost: row.costResult,
    } });
  } catch (err) {
    return Response.json({ error: "Could not load control event.", detail: String(err) }, { status: 500 });
  }
}
