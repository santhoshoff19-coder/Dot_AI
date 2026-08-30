import { prisma } from "@/lib/db";
import { complexityBand } from "@/lib/capability/derive";
import {
  LEVELS, levelRank, type Disagreement, type Level, type OutcomeCategory,
} from "@/lib/capability/taxonomy";
import type { ControlEventData } from "@/types";

/**
 * Minimum evidence before observed performance may revise a declared
 * capability. One bad afternoon must not downgrade a model.
 */
export const MIN_CAPABILITY_UPDATE_SAMPLES = Number(
  process.env.MIN_CAPABILITY_UPDATE_SAMPLES ?? 5,
);

/** Success rate below which a capability level is considered overstated. */
const DOWNGRADE_THRESHOLD = Number(process.env.CAPABILITY_DOWNGRADE_THRESHOLD ?? 0.6);
/** Sustained success rate that can restore a previously downgraded level. */
const UPGRADE_THRESHOLD = Number(process.env.CAPABILITY_UPGRADE_THRESHOLD ?? 0.92);

export interface OutcomeInput {
  requestId: string;
  openrouterModelId: string;
  event: ControlEventData;
  humanDecision?: string | null;
}

/**
 * Classifies what actually happened. Rejections are never collapsed into a
 * boolean, because routing needs to know *why* a model failed.
 */
export function classifyOutcome(
  event: ControlEventData,
  humanDecision?: string | null,
): { category: OutcomeCategory; success: boolean; disagreement: Disagreement } {
  const decision = event.decision.decision;
  const checkerFailed =
    event.verification.status === "CONTRADICTED" ||
    event.responsibility.status === "PROHIBITED";

  // Human judgement, where it exists, is the strongest signal we have.
  if (humanDecision === "reject") {
    return {
      category: "HUMAN_REJECTED",
      success: false,
      // The checker passed but a human disagreed: the checker may have missed
      // something. Recorded separately so checking can improve too.
      disagreement: checkerFailed ? "NONE" : "FALSE_NEGATIVE",
    };
  }
  if (humanDecision === "approve" || humanDecision === "edit") {
    return {
      category: "SUCCESS",
      success: true,
      // The checker flagged it and a human overruled: possibly too strict.
      disagreement: checkerFailed || decision === "HOLD" ? "FALSE_POSITIVE" : "NONE",
    };
  }

  if (decision === "BLOCK") {
    return { category: "RESPONSIBILITY_BLOCK", success: false, disagreement: "NONE" };
  }
  if (decision === "HOLD") {
    return { category: "PERFORMANCE_FAILURE", success: false, disagreement: "NONE" };
  }
  if (event.attempts > 1) {
    return { category: "REGENERATED", success: true, disagreement: "NONE" };
  }
  if (event.cost.status === "OVER BUDGET") {
    return { category: "COST_FAILURE", success: true, disagreement: "NONE" };
  }
  return { category: "SUCCESS", success: true, disagreement: "NONE" };
}

export class ModelFeedbackService {
  /** Records one outcome per generation. This is the evidence base. */
  async recordOutcome(input: OutcomeInput): Promise<string | null> {
    const { event } = input;
    try {
      const model = await prisma.model.findUnique({
        where: { openrouterModelId: input.openrouterModelId },
      });
      if (!model) return null;

      const { category, success, disagreement } =
        classifyOutcome(event, input.humanDecision);

      const row = await prisma.modelOutcome.create({
        data: {
          modelId: model.id,
          requestId: input.requestId,
          taskType: event.taskClassification,
          complexity: event.complexity,
          complexityBand: complexityBand(event.complexity),
          requirements: JSON.stringify(event.requirementProfile ?? {}),
          estimatedCost: event.estimatedCost,
          actualCost: event.actualCost,
          caiCost: event.routingCostUsd ?? 0,
          verificationCost: event.cost.verificationCost,
          retryCost: event.attempts > 1 ? event.actualCost : 0,
          totalCost: event.cost.totalCost + (event.routingCostUsd ?? 0),
          latencyMs: event.latencyMs,
          performanceResult: event.verification.status,
          responsibilityResult: event.responsibility.status,
          costResult: event.cost.status,
          decision: event.decision.decision,
          regenerationCount: Math.max(0, event.attempts - 1),
          humanDecision: input.humanDecision ?? null,
          category,
          success,
          disagreement,
          simulated: event.mock,
        },
      });

      // Evidence accumulates first; revision is considered only afterwards.
      await this.considerRevision(model.id, event.taskClassification);
      return row.id;
    } catch (err) {
      console.error("[feedback] outcome write failed", err);
      return null;
    }
  }

  /** Updates a recorded outcome once a human resolves a held response. */
  async attachHumanDecision(requestId: string, humanDecision: string): Promise<void> {
    try {
      const outcome = await prisma.modelOutcome.findFirst({
        where: { requestId }, orderBy: { createdAt: "desc" },
      });
      if (!outcome) return;

      const checkerFailed =
        outcome.performanceResult === "CONTRADICTED" ||
        outcome.responsibilityResult === "PROHIBITED";

      let category: OutcomeCategory = outcome.category as OutcomeCategory;
      let success = outcome.success;
      let disagreement: Disagreement = "NONE";

      if (humanDecision === "reject") {
        category = "HUMAN_REJECTED";
        success = false;
        disagreement = checkerFailed ? "NONE" : "FALSE_NEGATIVE";
      } else if (humanDecision === "approve" || humanDecision === "edit") {
        category = "SUCCESS";
        success = true;
        disagreement = checkerFailed || outcome.decision === "HOLD" ? "FALSE_POSITIVE" : "NONE";
      }

      await prisma.modelOutcome.update({
        where: { id: outcome.id },
        data: { humanDecision, category, success, disagreement },
      });

      await this.considerRevision(outcome.modelId, outcome.taskType);
    } catch (err) {
      console.error("[feedback] human decision write failed", err);
    }
  }

  /**
   * Observed reliability for MODEL x TASK x COMPLEXITY.
   * Deliberately not a single universal score.
   */
  async observedReliability(modelId: string, taskType: string, band?: Level) {
    const rows = await prisma.modelOutcome.findMany({
      where: { modelId, taskType, ...(band ? { complexityBand: band } : {}) },
    });
    if (!rows.length) return null;
    const successes = rows.filter((r) => r.success).length;
    return { rate: successes / rows.length, samples: rows.length };
  }

  /**
   * Considers - and only sometimes performs - a capability revision.
   *
   * A revision requires: enough samples, a sustained rate past the threshold,
   * and a level that is actually wrong. Every change is written to
   * ModelCapabilityRevision so the history is auditable.
   */
  async considerRevision(modelId: string, taskType: string): Promise<boolean> {
    const capability = await prisma.modelCapability.findUnique({ where: { modelId } });
    if (!capability || capability.status !== "ASSESSED") return false;

    const rows = await prisma.modelOutcome.findMany({ where: { modelId, taskType } });
    if (rows.length < MIN_CAPABILITY_UPDATE_SAMPLES) return false;

    const successes = rows.filter((r) => r.success).length;
    const rate = successes / rows.length;

    // Only the reliability field is revised automatically. Reasoning, effort
    // and the rest describe what a model *can* do and are not safely inferable
    // from outcome counts alone; those remain a benchmark/manual decision.
    const current = capability.reliability as Level;
    let next: Level | null = null;
    let reason = "";

    if (rate < DOWNGRADE_THRESHOLD && levelRank(current) > 0) {
      next = LEVELS[levelRank(current) - 1];
      reason = `Observed ${rows.length - successes} failures across ${rows.length} ${taskType} tasks.`;
    } else if (
      rate >= UPGRADE_THRESHOLD &&
      levelRank(current) < LEVELS.length - 1 &&
      rows.length >= MIN_CAPABILITY_UPDATE_SAMPLES * 2
    ) {
      next = LEVELS[levelRank(current) + 1];
      reason = `Sustained ${(rate * 100).toFixed(0)}% success across ${rows.length} ${taskType} tasks.`;
    }

    if (!next || next === current) return false;

    await prisma.$transaction([
      prisma.modelCapabilityRevision.create({
        data: {
          modelId,
          fieldChanged: "reliability",
          oldValue: current,
          newValue: next,
          reason,
          evidenceCount: rows.length,
          successRate: rate,
          taskType,
        },
      }),
      prisma.modelCapability.update({
        where: { modelId },
        data: {
          reliability: next,
          assessmentSource: "OBSERVED",
          lastEvaluatedAt: new Date(),
          // Confidence rises with evidence but is capped: observation informs,
          // it does not become certainty.
          capabilityConfidence: Math.min(0.95, 0.5 + rows.length / 100),
        },
      }),
    ]);
    return true;
  }

  async revisions(modelId?: string) {
    return prisma.modelCapabilityRevision.findMany({
      where: modelId ? { modelId } : {},
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  /** Aggregate statistics for the Model Intelligence page. */
  async statsFor(modelId: string) {
    const rows = await prisma.modelOutcome.findMany({ where: { modelId } });
    if (!rows.length) {
      return {
        samples: 0, successRate: 0, failureRate: 0, avgCost: 0, avgLatencyMs: 0,
        byTask: [] as { taskType: string; band: string; samples: number; successRate: number }[],
        falseNegatives: 0, falsePositives: 0,
      };
    }
    const successes = rows.filter((r) => r.success).length;

    const grouped = new Map<string, { taskType: string; band: string; n: number; ok: number }>();
    for (const r of rows) {
      const key = `${r.taskType}::${r.complexityBand}`;
      const g = grouped.get(key) ?? { taskType: r.taskType, band: r.complexityBand, n: 0, ok: 0 };
      g.n++;
      if (r.success) g.ok++;
      grouped.set(key, g);
    }

    return {
      samples: rows.length,
      successRate: successes / rows.length,
      failureRate: 1 - successes / rows.length,
      avgCost: rows.reduce((n, r) => n + r.totalCost, 0) / rows.length,
      avgLatencyMs: rows.reduce((n, r) => n + r.latencyMs, 0) / rows.length,
      byTask: [...grouped.values()].map((g) => ({
        taskType: g.taskType, band: g.band, samples: g.n, successRate: g.ok / g.n,
      })),
      falseNegatives: rows.filter((r) => r.disagreement === "FALSE_NEGATIVE").length,
      falsePositives: rows.filter((r) => r.disagreement === "FALSE_POSITIVE").length,
    };
  }
}

export const modelFeedback = new ModelFeedbackService();
