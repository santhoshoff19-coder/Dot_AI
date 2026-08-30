import { NextRequest } from "next/server";
import { z } from "zod";
import { verificationMetrics, MIN_LABELLED_FOR_RATES } from "@/lib/verification/metrics";
import { MIN_BASELINE_SAMPLES } from "@/lib/verification/anomaly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const profileId = new URL(req.url).searchParams.get("profileId") ?? undefined;
  try {
    const [verifier, anomaly] = await Promise.all([
      verificationMetrics.verifierMetrics(profileId),
      verificationMetrics.anomalyMetrics(),
    ]);
    return Response.json({
      verifier,
      anomaly,
      thresholds: {
        minLabelledForRates: MIN_LABELLED_FOR_RATES,
        minBaselineSamples: MIN_BASELINE_SAMPLES,
      },
      notice:
        "An anomaly is a signal to verify more carefully, never evidence that an " +
        "answer is wrong. Rates requiring ground truth are withheld until enough " +
        "decisions have been labelled by a human.",
    });
  } catch (err) {
    return Response.json({ error: "Could not load metrics.", detail: String(err) }, { status: 500 });
  }
}

const Label = z.object({
  requestId: z.string().min(1),
  groundTruth: z.enum(["CORRECT", "INCORRECT"]),
});

/** Records a human judgement of a verified response. */
export async function POST(req: NextRequest) {
  try {
    const body = Label.parse(await req.json());
    const ok = await verificationMetrics.label(body.requestId, body.groundTruth);
    return Response.json({ ok });
  } catch (err) {
    return Response.json({ error: "Invalid request.", detail: String(err) }, { status: 400 });
  }
}
