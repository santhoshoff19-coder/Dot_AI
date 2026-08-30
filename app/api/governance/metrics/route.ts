import { NextRequest } from "next/server";
import { z } from "zod";
import { checkerMetrics, MIN_LABELLED } from "@/lib/governance/metrics";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const metrics = await checkerMetrics.all();
  const sessions = await prisma.sessionRisk.findMany({
    orderBy: { lastUpdatedAt: "desc" }, take: 20,
  });
  return Response.json({ metrics, minLabelled: MIN_LABELLED, sessions });
}

const LabelSchema = z.object({
  requestId: z.string().min(1),
  verdict: z.enum(["CORRECT_FLAG", "FALSE_ALARM", "MISSED_RISK", "CORRECT_PASS"]),
});

/** Human labelling: the only source of ground truth for FP/FN rates. */
export async function POST(req: NextRequest) {
  try {
    const body = LabelSchema.parse(await req.json());
    await checkerMetrics.label(body.requestId, body.verdict);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: "Invalid request.", detail: String(err) }, { status: 400 });
  }
}
