import { prisma } from "@/lib/db";
import { modelIntelligence } from "@/lib/models/intelligence";
import { modelFeedback } from "@/lib/models/feedback";
import { isMockMode } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await modelIntelligence.ensureSeeded();
    const models = await modelIntelligence.all(true);

    const withStats = await Promise.all(
      models.map(async (m) => {
        const row = await prisma.model.findUnique({
          where: { openrouterModelId: m.openrouterModelId }, select: { id: true },
        });
        const stats = row ? await modelFeedback.statsFor(row.id) : null;
        return { ...m, stats };
      }),
    );

    const outcomes = await prisma.modelOutcome.findMany({ take: 1000, orderBy: { createdAt: "desc" } });
    const byCategory = outcomes.reduce<Record<string, number>>((acc, o) => {
      acc[o.category] = (acc[o.category] ?? 0) + 1; return acc;
    }, {});

    return Response.json({
      simulated: isMockMode(),
      models: withStats,
      totals: {
        models: models.length,
        assessed: models.filter((m) => m.status === "ASSESSED").length,
        unassessed: models.filter((m) => m.status === "UNASSESSED").length,
        outcomes: outcomes.length,
        byCategory,
        falseNegatives: outcomes.filter((o) => o.disagreement === "FALSE_NEGATIVE").length,
        falsePositives: outcomes.filter((o) => o.disagreement === "FALSE_POSITIVE").length,
      },
      revisions: await modelFeedback.revisions(),
    });
  } catch (err) {
    return Response.json({ error: "Could not load stats.", detail: String(err) }, { status: 500 });
  }
}
