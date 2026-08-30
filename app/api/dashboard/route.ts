import { NextRequest } from "next/server";
import { z } from "zod";
import {
  checkerMetrics, HUMAN_VERDICTS, MIN_LABELLED, type HumanVerdict,
} from "@/lib/governance/metrics";
import { modelHealth, MIN_HEALTH_RUNS } from "@/lib/models/health";
import { verificationMetrics } from "@/lib/verification/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  try {
    const [profiles, health, verifier, anomaly] = await Promise.all([
      checkerMetrics.all(),
      modelHealth.all(20),
      verificationMetrics.verifierMetrics(),
      verificationMetrics.anomalyMetrics(),
    ]);

    return Response.json({
      profiles,
      modelHealth: health,
      verifier,
      anomaly,
      thresholds: { minLabelled: MIN_LABELLED, minHealthRuns: MIN_HEALTH_RUNS },
      verdicts: HUMAN_VERDICTS,
      notice:
        "Rates requiring human ground truth are withheld until enough decisions " +
        "have been labelled. Absent values are shown as unavailable, never estimated.",
    });
  } catch (err) {
    return Response.json(
      { error: "Could not load dashboard.", detail: String(err) }, { status: 500 });
  }
}

const Feedback = z.object({
  requestId: z.string().min(1),
  verdict: z.enum(HUMAN_VERDICTS),
  comment: z.string().max(2000).optional(),
  reviewer: z.string().max(120).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/** Records a reviewer's judgement as auditable evidence. */
export async function POST(req: NextRequest) {
  try {
    const body = Feedback.parse(await req.json());
    const result = await checkerMetrics.recordFeedback({
      ...body, verdict: body.verdict as HumanVerdict,
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: "Invalid feedback.", detail: String(err) }, { status: 400 });
  }
}
