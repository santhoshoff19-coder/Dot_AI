import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { overrideQuality } from "@/lib/governance/threshold-eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DECISIONS = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"] as const;

const Body = z.object({
  requestId: z.string().min(1),
  originalDecision: z.enum(DECISIONS),
  humanDecision: z.enum(DECISIONS),
  source: z.string().max(60).default(""),
  comment: z.string().max(2000).default(""),
  correction: z.string().max(8000).default(""),
  profileId: z.string().max(60).default(""),
  reviewer: z.string().max(120).default(""),
});

/** Records a human's verdict on a decision dotAI made. */
export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid feedback.", detail: parsed.error.flatten() }, { status: 400 });
    }

    const row = await prisma.decisionFeedback.create({ data: parsed.data });
    return Response.json({
      id: row.id,
      // Whether this verdict agreed with the system, so the UI can say so.
      overturned: row.humanDecision !== row.originalDecision,
    });
  } catch (err) {
    return Response.json(
      { error: "Could not record feedback.", detail: String(err) }, { status: 500 });
  }
}

/** Agreement between dotAI's decisions and the humans who reviewed them. */
export async function GET() {
  try {
    return Response.json(await overrideQuality());
  } catch (err) {
    return Response.json(
      { error: "Could not read feedback.", detail: String(err) }, { status: 500 });
  }
}
