import { policyIngestion } from "@/lib/policy/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Restores the demonstration policy packs.
 *
 * Seeding otherwise happens once on a fresh database, so that deleting a demo
 * pack is permanent. This is the deliberate way back - the user asks for it,
 * rather than the packs reappearing on their own.
 */
export async function POST() {
  try {
    const restored = await policyIngestion.reseedDemoPacks();
    return Response.json({
      restored,
      message: restored === 0
        ? "The demo policy packs are already present."
        : `Restored ${restored} demo policy pack(s).`,
    });
  } catch (err) {
    return Response.json(
      { error: "Could not restore the demo policy packs.", detail: String(err) },
      { status: 500 });
  }
}
