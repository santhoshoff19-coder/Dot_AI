import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { modelIntelligenceService } from "@/lib/intelligence/service";
import { EXECUTABLE_TASKS, type TaskType } from "@/lib/intelligence/taxonomy";
import { getProfile } from "@/lib/governance/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const profileId = url.searchParams.get("profileId") ?? "GLOBAL";
  const task = url.searchParams.get("task") as TaskType | null;

  try {
    const [total, active, champions, capabilityCounts, lastHistory] = await Promise.all([
      prisma.model.count(),
      prisma.model.count({ where: { active: true } }),
      modelIntelligenceService.allChampions(profileId),
      prisma.modelTaskCapability.groupBy({ by: ["capability"], _count: true }),
      prisma.modelChampionHistory.findFirst({ orderBy: { createdAt: "desc" } }),
    ]);

    const [assessed, execVerified, execFailed] = await Promise.all([
      prisma.modelCapability.count({ where: { status: "ASSESSED" } }),
      prisma.modelExecutionStatus.count({ where: { status: "EXECUTION_VERIFIED" } }),
      prisma.modelExecutionStatus.count({ where: { status: { in: ["FAILED", "UNAVAILABLE"] } } }),
    ]);

    // Pool sizes are what make "capable" concrete rather than a claim.
    const pools: Record<string, number> = {};
    for (const t of EXECUTABLE_TASKS) {
      pools[t] = (await modelIntelligenceService.candidatePool(t, { limit: 200 })).length;
    }

    const taskDetail = task
      ? modelIntelligenceService
          .rank(await modelIntelligenceService.candidatePool(task),
            (await import("@/lib/intelligence/service")).weightsFor(getProfile(profileId)))
          .slice(0, 10)
      : null;

    return Response.json({
      totals: { total, active, assessed, execVerified, execFailed },
      champions: champions.map((c) => ({
        taskType: c.taskType, championType: c.championType,
        modelId: c.model.openrouterModelId, name: c.model.name,
        provider: c.model.provider,
        inputPrice: c.model.inputPrice, pricingKnown: c.model.pricingKnown,
        latencyClass: c.model.latencyClass,
        score: c.score, confidence: c.confidence, reason: c.reason,
      })),
      pools,
      capabilities: Object.fromEntries(capabilityCounts.map((c) => [c.capability, c._count])),
      tasks: EXECUTABLE_TASKS,
      taskDetail,
      lastRecalculated: lastHistory?.createdAt ?? null,
      notice:
        "Champions are computed from measured scores. Where dotAI has not yet " +
        "executed a model, confidence is LOW and execution is reported unproven.",
    });
  } catch (err) {
    return Response.json({ error: "Could not load intelligence.", detail: String(err) }, { status: 500 });
  }
}

/** Administrative recalculation. Never triggered by a user request. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { profileId?: string };
    const profile = body.profileId ? getProfile(body.profileId) : null;

    const indexed = await modelIntelligenceService.indexCapabilities();
    const result = await modelIntelligenceService.recalculateChampions(
      [...EXECUTABLE_TASKS], profile);

    return Response.json({ indexed, ...result, at: new Date().toISOString() });
  } catch (err) {
    return Response.json({ error: "Recalculation failed.", detail: String(err) }, { status: 500 });
  }
}
