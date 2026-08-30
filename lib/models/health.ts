import { prisma } from "@/lib/db";

export interface ModelHealth {
  modelId: string;
  name: string;
  /** Real generations recorded for this model. */
  runs: number;
  successRate: number | null;
  failureRate: number | null;
  avgLatencyMs: number | null;
  avgCostUsd: number | null;
  totalCostUsd: number;

  /** Execution attempts against a real provider, per modality. */
  executionAttempts: number;
  executionSuccesses: number;
  executionSuccessRate: number | null;
  executionFailures: { reason: string; count: number }[];
  lastSuccessfulExecution: string | null;

  /** How often the checker had to intervene on this model's output. */
  responsibilityFailures: number;
  performanceFailures: number;

  /** Agreement between the AI verifier and this model's output. */
  verifierCalls: number;
  verifierAgreementRate: number | null;

  /** Whether there is enough evidence to rank on any of this. */
  sufficientEvidence: boolean;
  note: string;
}

/** Runs required before health influences ranking. */
export const MIN_HEALTH_RUNS = Number(process.env.MIN_HEALTH_RUNS ?? 5);

/**
 * Aggregated model health.
 *
 * Deliberately separates *execution* health (can we call it) from *capability*
 * outcomes (was the answer any good). A provider outage must never read as the
 * model being unintelligent, so the two are counted apart and reported apart.
 */
export class ModelHealthService {
  async forModel(openrouterModelId: string): Promise<ModelHealth | null> {
    const model = await prisma.model.findUnique({
      where: { openrouterModelId },
      include: { modelExecutionStatuses: true },
    });
    if (!model) return null;

    const outcomes = await prisma.modelOutcome.findMany({
      where: { modelId: model.id }, take: 1000, orderBy: { createdAt: "desc" },
    });

    const events = await prisma.modelExecutionEvent.findMany({
      where: { openrouterModelId }, take: 1000, orderBy: { createdAt: "desc" },
    });

    const verifierCalls = await prisma.verifierCall.findMany({
      where: { generationModel: openrouterModelId }, take: 500,
    });

    const successes = outcomes.filter((o) => o.success).length;
    const n = outcomes.length;

    // Execution counters come from the status rows, which already exclude
    // simulated runs.
    const executionAttempts = model.modelExecutionStatuses
      .reduce((a, s) => a + s.attempts, 0);
    const executionSuccesses = model.modelExecutionStatuses
      .reduce((a, s) => a + s.successes, 0);

    const failureCounts = new Map<string, number>();
    for (const e of events) {
      if (e.success || !e.failureReason) continue;
      failureCounts.set(e.failureReason, (failureCounts.get(e.failureReason) ?? 0) + 1);
    }

    const lastSuccess = events.find((e) => e.success);

    // The verifier agreeing means it did not contradict what the model said.
    const decisive = verifierCalls.filter(
      (v) => v.outcome === "SUPPORTED" || v.outcome === "CONTRADICTED");
    const agreed = decisive.filter((v) => v.outcome === "SUPPORTED").length;

    const sufficient = n >= MIN_HEALTH_RUNS;

    return {
      modelId: openrouterModelId,
      name: model.name,
      runs: n,
      successRate: sufficient ? round(successes / n) : null,
      failureRate: sufficient ? round(1 - successes / n) : null,
      avgLatencyMs: n ? Math.round(outcomes.reduce((a, o) => a + o.latencyMs, 0) / n) : null,
      avgCostUsd: n ? round(outcomes.reduce((a, o) => a + o.totalCost, 0) / n) : null,
      totalCostUsd: round(outcomes.reduce((a, o) => a + o.totalCost, 0)),

      executionAttempts,
      executionSuccesses,
      executionSuccessRate: executionAttempts > 0
        ? round(executionSuccesses / executionAttempts) : null,
      executionFailures: [...failureCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      lastSuccessfulExecution: lastSuccess?.createdAt.toISOString() ?? null,

      responsibilityFailures: outcomes.filter(
        (o) => o.category === "RESPONSIBILITY_BLOCK").length,
      performanceFailures: outcomes.filter(
        (o) => o.category === "PERFORMANCE_FAILURE").length,

      verifierCalls: verifierCalls.length,
      verifierAgreementRate: decisive.length >= 5 ? round(agreed / decisive.length) : null,

      sufficientEvidence: sufficient,
      note: sufficient
        ? `Based on ${n} recorded runs.`
        : `Only ${n} of ${MIN_HEALTH_RUNS} runs needed before health influences ranking.`,
    };
  }

  /** Health for every model that has any recorded activity. */
  async all(limit = 50): Promise<ModelHealth[]> {
    const active = await prisma.modelOutcome.groupBy({
      by: ["modelId"], _count: true, orderBy: { _count: { modelId: "desc" } }, take: limit,
    });
    const ids = await prisma.model.findMany({
      where: { id: { in: active.map((a) => a.modelId) } },
      select: { openrouterModelId: true },
    });

    const out: ModelHealth[] = [];
    for (const { openrouterModelId } of ids) {
      const h = await this.forModel(openrouterModelId);
      if (h) out.push(h);
    }
    return out.sort((a, b) => b.runs - a.runs);
  }

  /**
   * Ranking multiplier from observed health. Returns 1 (neutral) until there
   * is enough evidence, so a single bad run never demotes a model.
   */
  async rankingFactor(openrouterModelId: string): Promise<number> {
    const h = await this.forModel(openrouterModelId);
    if (!h || !h.sufficientEvidence || h.successRate === null) return 1;
    // Bounded so health nudges ranking rather than dominating it.
    return Math.max(0.6, Math.min(1.15, 0.6 + h.successRate * 0.55));
  }
}

function round(n: number, dp = 4): number {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

export const modelHealth = new ModelHealthService();
