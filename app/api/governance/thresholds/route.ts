import { selectThreshold, LABELLED_SET } from "@/lib/governance/threshold-eval";
import { overrideQuality } from "@/lib/governance/threshold-eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The threshold report: the labelled set, FP/FN at each candidate, the chosen
 * threshold and the reason it was chosen.
 */
export async function GET() {
  try {
    const report = selectThreshold();
    return Response.json({
      ...report,
      cases: LABELLED_SET.map((c) => ({
        id: c.id, expected: c.expected, note: c.note,
        profileId: c.profileId, external: c.destinationExternal,
      })),
      overrides: await overrideQuality(),
    });
  } catch (err) {
    return Response.json(
      { error: "Could not evaluate thresholds.", detail: String(err) },
      { status: 500 });
  }
}
