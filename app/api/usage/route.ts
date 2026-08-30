import { prisma } from "@/lib/db";
import { learningService } from "@/lib/learning/service";
import { modelRegistry } from "@/lib/models/registry";
import { isMockMode } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const events = await prisma.controlEvent.findMany({ orderBy: { createdAt: "desc" }, take: 500 });

    const requests = events.length;
    const totalCost = events.reduce((n, e) => n + e.actualCost, 0);
    const totalEstimated = events.reduce((n, e) => n + e.estimatedCost, 0);

    // "Savings" = what the highest-capability model would have cost for the
    // same token volume, minus what was actually spent.
    const premium = modelRegistry.all().reduce((a, b) =>
      a.relativeCapability > b.relativeCapability ? a : b);
    const counterfactual = events.reduce(
      (n, e) => n + modelRegistry.price(premium, e.inputTokens, e.outputTokens), 0);
    const estimatedSavings = Math.max(0, counterfactual - totalCost);

    const byModel = new Map<string, { modelId: string; requests: number; cost: number }>();
    for (const e of events) {
      const row = byModel.get(e.selectedModel) ?? { modelId: e.selectedModel, requests: 0, cost: 0 };
      row.requests++; row.cost += e.actualCost;
      byModel.set(e.selectedModel, row);
    }

    const decisions = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.decision] = (acc[e.decision] ?? 0) + 1; return acc;
    }, {});

    return Response.json({
      simulated: isMockMode(),
      requests,
      totalCost,
      totalEstimated,
      averageCost: requests ? totalCost / requests : 0,
      estimatedSavings,
      counterfactualCost: counterfactual,
      verificationCost: 0,
      modelUsage: [...byModel.values()].map((m) => ({
        ...m, name: modelRegistry.get(m.modelId)?.name ?? m.modelId,
      })),
      decisions,
      learning: await learningService.stats(),
    });
  } catch (err) {
    return Response.json({ error: "Could not load usage.", detail: String(err) }, { status: 500 });
  }
}
