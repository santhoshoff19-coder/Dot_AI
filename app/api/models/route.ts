import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Models with no usable price sort last, never first. Ordering by the raw
 * column alone put the "-1" sentinel at the top of "cheapest".
 */
const SORTS: Record<string, Prisma.ModelOrderByWithRelationInput[]> = {
  inputCost: [{ pricingKnown: "desc" }, { inputPrice: "asc" }],
  inputCostDesc: [{ pricingKnown: "desc" }, { inputPrice: "desc" }],
  outputCost: [{ pricingKnown: "desc" }, { outputPrice: "asc" }],
  outputCostDesc: [{ pricingKnown: "desc" }, { outputPrice: "desc" }],
  contextLength: [{ contextLength: "desc" }],
  name: [{ name: "asc" }],
  provider: [{ provider: "asc" }],
  newest: [{ firstSeenAt: "desc" }],
};

/**
 * Paginated, searchable, filterable catalog. Everything is done in the
 * database so the endpoint stays fast with hundreds or thousands of models.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 25)));
  const q = (url.searchParams.get("q") ?? "").trim();
  const category = url.searchParams.get("category") ?? "ALL";
  const inputModality = url.searchParams.get("inputModality") ?? "ALL";
  const outputModality = url.searchParams.get("outputModality") ?? "ALL";
  const assessment = url.searchParams.get("assessment") ?? "ALL";
  const provider = url.searchParams.get("provider") ?? "ALL";
  const execution = url.searchParams.get("execution") ?? "ALL";
  const activity = url.searchParams.get("activity") ?? "ACTIVE";
  const sort = url.searchParams.get("sort") ?? "inputCost";

  const where: Prisma.ModelWhereInput = {};

  if (activity === "ACTIVE") where.active = true;
  else if (activity === "INACTIVE") where.active = false;

  if (q) {
    // Search covers name, model id and provider.
    where.OR = [
      { name: { contains: q } },
      { openrouterModelId: { contains: q } },
      { provider: { contains: q } },
    ];
  }
  if (category !== "ALL") where.categories = { some: { category } };
  if (inputModality !== "ALL") {
    where.modalities = { some: { direction: "INPUT", modality: inputModality } };
  }
  if (outputModality !== "ALL") {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { modalities: { some: { direction: "OUTPUT", modality: outputModality } } },
    ];
  }
  if (assessment !== "ALL") where.capability = { status: assessment };
  if (provider !== "ALL") where.provider = provider;
  if (execution !== "ALL") {
    where.modelExecutionStatuses = execution === "UNCHECKED"
      ? { none: {} }
      : { some: { status: execution } };
  }

  try {
    const [total, rows] = await Promise.all([
      prisma.model.count({ where }),
      prisma.model.findMany({
        where,
        orderBy: SORTS[sort] ?? SORTS.inputCost,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          capability: true,
          modalities: true,
          categories: true,
          modelExecutionStatuses: true,
        },
      }),
    ]);

    const models = rows.map((r) => ({
      openrouterModelId: r.openrouterModelId,
      name: r.name,
      provider: r.provider,
      active: r.active,
      contextLength: r.contextLength,
      inputPrice: r.inputPrice,
      outputPrice: r.outputPrice,
      pricingKnown: r.pricingKnown,
      latencyClass: r.latencyClass,
      categories: r.categories.map((c) => c.category),
      inputModalities: r.modalities.filter((m) => m.direction === "INPUT").map((m) => m.modality),
      outputModalities: r.modalities.filter((m) => m.direction === "OUTPUT").map((m) => m.modality),
      status: r.capability?.status ?? "ASSESSMENT_PENDING",
      unassessedReason: r.capability?.unassessedReason ?? null,
      capabilityConfidence: r.capability?.capabilityConfidence ?? 0,
      evidenceLevel: r.capability?.evidenceLevel ?? "INFERRED",
      capability: r.capability
        ? {
            effort: r.capability.effort,
            reasoning: r.capability.reasoning,
            contextHandling: r.capability.contextHandling,
            instructionComplexity: r.capability.instructionComplexity,
            reliability: r.capability.reliability,
            toolCapability: r.capability.toolCapability,
          }
        : null,
      execution: r.modelExecutionStatuses.map((e) => ({
        modality: e.modality, status: e.status,
        attempts: e.attempts, successes: e.successes,
        failureReason: e.failureReason,
      })),
    }));

    // Provider list for the filter dropdown, derived from the catalog itself.
    const providers = await prisma.model.groupBy({
      by: ["provider"], where: { active: true }, _count: true, orderBy: { provider: "asc" },
    });

    return Response.json({
      models, total, page, pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      providers: providers.map((p) => p.provider),
    });
  } catch (err) {
    return Response.json({ error: "Could not load models.", detail: String(err) }, { status: 500 });
  }
}
