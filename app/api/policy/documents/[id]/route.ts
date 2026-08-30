import { policyIngestion } from "@/lib/policy/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One policy document with its indexed sections. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const doc = await policyIngestion.getDocument(id);
    if (!doc) {
      return Response.json({ error: "Policy document not found." }, { status: 404 });
    }
    return Response.json({ document: doc });
  } catch (err) {
    return Response.json(
      { error: "Could not load the policy document.", detail: String(err) },
      { status: 500 });
  }
}

/**
 * Permanently removes a policy document and its indexed sections.
 *
 * Demo packs are deletable too: a user who has added real policy should be
 * able to clear the illustrative ones out of retrieval.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const result = await policyIngestion.deleteDocument(id);

    if (!result.deleted) {
      return Response.json({ error: "Policy document not found." }, { status: 404 });
    }
    if (result.orphanedChunks > 0) {
      // Reported rather than hidden: retrieval could still surface this text.
      return Response.json({
        error: "Deletion left indexed sections behind.",
        ...result,
      }, { status: 500 });
    }
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: "Could not delete the policy document.", detail: String(err) },
      { status: 500 });
  }
}
