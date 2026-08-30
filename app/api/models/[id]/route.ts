import { prisma } from "@/lib/db";
import { modelFeedback } from "@/lib/models/feedback";
import { modelIntelligence } from "@/lib/models/intelligence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const openrouterModelId = decodeURIComponent(id);
  try {
    const model = await modelIntelligence.byOpenRouterId(openrouterModelId);
    if (!model) return Response.json({ error: "Model not found." }, { status: 404 });

    const row = await prisma.model.findUnique({
      where: { openrouterModelId }, select: { id: true },
    });
    if (!row) return Response.json({ error: "Model not found." }, { status: 404 });

    return Response.json({
      model,
      stats: await modelFeedback.statsFor(row.id),
      revisions: await modelFeedback.revisions(row.id),
      outcomes: await prisma.modelOutcome.findMany({
        where: { modelId: row.id }, orderBy: { createdAt: "desc" }, take: 50,
      }),
    });
  } catch (err) {
    return Response.json({ error: "Could not load model.", detail: String(err) }, { status: 500 });
  }
}
