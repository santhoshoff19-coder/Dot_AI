import { prisma } from "@/lib/db";
import { getProfile, listProfiles } from "@/lib/governance/profiles";

export interface ProfileMetrics {
  profileId: string;
  profileName: string;
  interactions: number;

  /** Counts that need no ground truth. */
  interventionRate: number;
  escalationRate: number;
  blockRate: number;
  verificationCoverage: number;
  p50CheckerLatencyMs: number | null;
  p95CheckerLatencyMs: number | null;
  byDecision: Record<string, number>;
  topCategories: { category: string; count: number }[];

  /** Real cost, aggregated from what each request actually recorded. */
  cost: {
    estimated: number;
    generation: number;
    cai: number;
    rag: number;
    verification: number;
    retry: number;
    total: number;
    controlPlaneOverhead: number;
    avgTotalPerRequest: number;
    avgCheckerPerRequest: number;
    /** How far actual spend drifted from the estimate, as a ratio. */
    estimateDrift: number | null;
  };

  /**
   * Rates that require a human verdict. Null means we do not have enough
   * labelled data - reported as unavailable rather than estimated, because a
   * fabricated false-positive rate is worse than an absent one.
   */
  labelledCount: number;
  truePositives: number | null;
  falsePositives: number | null;
  trueNegatives: number | null;
  falseNegatives: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  riskEscapeRate: number | null;
  groundTruthNote: string;

  /** Human feedback recorded against this profile, by verdict. */
  feedback: Record<string, number>;
  disputedFeedback: number;
}

/** Verdicts a reviewer may record. */
export const HUMAN_VERDICTS = [
  "CORRECT", "INCORRECT", "UNSAFE", "POLICY_VIOLATION",
  "FALSE_POSITIVE", "FALSE_NEGATIVE", "UNVERIFIABLE",
] as const;
export type HumanVerdict = (typeof HUMAN_VERDICTS)[number];

/**
 * Maps a reviewer verdict onto the confusion matrix.
 *
 * Only verdicts that clearly speak to whether the checker was right are used
 * as ground truth. UNVERIFIABLE deliberately maps to nothing: a reviewer who
 * could not tell is not evidence either way.
 */
export const VERDICT_TO_GROUND_TRUTH: Record<HumanVerdict, string | null> = {
  CORRECT: "CORRECT_PASS",
  INCORRECT: "MISSED_RISK",
  UNSAFE: "MISSED_RISK",
  POLICY_VIOLATION: "MISSED_RISK",
  FALSE_POSITIVE: "FALSE_ALARM",
  FALSE_NEGATIVE: "MISSED_RISK",
  UNVERIFIABLE: null,
};

/** Below this many labelled samples a rate is noise, so it is not reported. */
export const MIN_LABELLED = Number(process.env.MIN_LABELLED_SAMPLES ?? 10);

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/** Aggregates the cost actually recorded on each request. */
function costOf(rows: {
  estimatedCost: number; generationCost: number; caiCost: number;
  ragCost: number; verificationCost: number; retryCost: number;
  totalCost: number; controlPlaneOverhead: number;
}[]): ProfileMetrics["cost"] {
  const sum = (f: (r: (typeof rows)[number]) => number) =>
    rows.reduce((n, r) => n + f(r), 0);
  const n = rows.length;

  const estimated = sum((r) => r.estimatedCost);
  const total = sum((r) => r.totalCost);

  return {
    estimated: round(estimated),
    generation: round(sum((r) => r.generationCost)),
    cai: round(sum((r) => r.caiCost)),
    rag: round(sum((r) => r.ragCost)),
    verification: round(sum((r) => r.verificationCost)),
    retry: round(sum((r) => r.retryCost)),
    total: round(total),
    controlPlaneOverhead: round(sum((r) => r.controlPlaneOverhead)),
    avgTotalPerRequest: n ? round(total / n) : 0,
    avgCheckerPerRequest: n ? round(sum((r) => r.controlPlaneOverhead) / n) : 0,
    // Drift is only meaningful once something was actually estimated.
    estimateDrift: estimated > 0 ? round(total / estimated, 3) : null,
  };
}

function round(n: number, dp = 6): number {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

export class CheckerMetricsService {
  /** Records one checker run. Ground truth, if it ever arrives, comes later. */
  async record(row: {
    requestId: string;
    profileId: string;
    sessionId?: string | null;
    decision: string;
    escalatedToHuman: boolean;
    categories: string[];
    findingCount: number;
    verificationDepth: string;
    sessionRiskLevel: string;
    checkerLatencyMs: number;
    verificationAttempted: boolean;
    verificationPossible: boolean;
    selectedModel?: string;
    /** Full cost accounting. Estimated stays separate from actual. */
    cost?: {
      estimated: number; generation: number; cai: number; rag: number;
      verification: number; retry: number; total: number;
      controlPlaneOverhead: number;
    };
  }): Promise<void> {
    try {
      await prisma.checkerOutcome.create({
        data: {
          requestId: row.requestId,
          profileId: row.profileId,
          sessionId: row.sessionId ?? null,
          decision: row.decision,
          interventionTaken: row.decision !== "ALLOW",
          escalatedToHuman: row.escalatedToHuman,
          selectedModel: row.selectedModel ?? "",
          estimatedCost: row.cost?.estimated ?? 0,
          generationCost: row.cost?.generation ?? 0,
          caiCost: row.cost?.cai ?? 0,
          ragCost: row.cost?.rag ?? 0,
          verificationCost: row.cost?.verification ?? 0,
          retryCost: row.cost?.retry ?? 0,
          totalCost: row.cost?.total ?? 0,
          controlPlaneOverhead: row.cost?.controlPlaneOverhead ?? 0,
          categories: JSON.stringify(row.categories),
          findingCount: row.findingCount,
          verificationDepth: row.verificationDepth,
          sessionRiskLevel: row.sessionRiskLevel,
          checkerLatencyMs: row.checkerLatencyMs,
          verificationAttempted: row.verificationAttempted,
          verificationPossible: row.verificationPossible,
        },
      });
    } catch (err) {
      console.error("[metrics] write failed", err);
    }
  }

  /**
   * A human labelling a decision is the only source of ground truth we have.
   *   CORRECT_FLAG  - we intervened and were right      (true positive)
   *   FALSE_ALARM   - we intervened and were wrong      (false positive)
   *   MISSED_RISK   - we allowed something we shouldn't (false negative)
   *   CORRECT_PASS  - we allowed correctly              (true negative)
   */
  /**
   * Records a reviewer's judgement.
   *
   * The feedback row is the audit record and is always kept. It is promoted to
   * ground truth only when the verdict actually speaks to whether the checker
   * was right, and a conflicting second opinion marks both as disputed rather
   * than overwriting the first.
   */
  async recordFeedback(input: {
    requestId: string;
    verdict: HumanVerdict;
    comment?: string;
    reviewer?: string;
    confidence?: number;
  }): Promise<{ recorded: boolean; groundTruth: string | null; disputed: boolean }> {
    const outcome = await prisma.checkerOutcome.findFirst({
      where: { requestId: input.requestId }, orderBy: { createdAt: "desc" },
    });

    const existing = await prisma.humanFeedback.findMany({
      where: { requestId: input.requestId },
    });
    const conflicting = existing.filter((e) => e.verdict !== input.verdict);
    const disputed = conflicting.length > 0;

    await prisma.humanFeedback.create({
      data: {
        requestId: input.requestId,
        outcomeId: outcome?.id ?? null,
        verdict: input.verdict,
        comment: input.comment ?? "",
        reviewer: input.reviewer ?? "local-user",
        confidence: input.confidence ?? 1,
        disputed,
      },
    });

    // A disagreement between reviewers is flagged on both sides, so the
    // conflict is visible rather than resolved by whoever answered last.
    if (disputed) {
      await prisma.humanFeedback.updateMany({
        where: { requestId: input.requestId }, data: { disputed: true },
      });
    }

    const groundTruth = VERDICT_TO_GROUND_TRUTH[input.verdict];
    // Disputed or low-confidence feedback is not treated as settled truth.
    if (outcome && groundTruth && !disputed && (input.confidence ?? 1) >= 0.7) {
      await prisma.checkerOutcome.update({
        where: { id: outcome.id }, data: { humanVerdict: groundTruth },
      });
    }

    return { recorded: true, groundTruth: disputed ? null : groundTruth, disputed };
  }

  async feedbackFor(requestId: string) {
    return prisma.humanFeedback.findMany({
      where: { requestId }, orderBy: { createdAt: "desc" },
    });
  }

  async label(requestId: string, verdict:
    "CORRECT_FLAG" | "FALSE_ALARM" | "MISSED_RISK" | "CORRECT_PASS"): Promise<void> {
    try {
      const row = await prisma.checkerOutcome.findFirst({
        where: { requestId }, orderBy: { createdAt: "desc" },
      });
      if (row) {
        await prisma.checkerOutcome.update({
          where: { id: row.id }, data: { humanVerdict: verdict },
        });
      }
    } catch (err) {
      console.error("[metrics] label failed", err);
    }
  }

  /** Metrics are always computed per profile: a global average hides the tradeoff. */
  async forProfile(profileId: string): Promise<ProfileMetrics> {
    const rows = await prisma.checkerOutcome.findMany({ where: { profileId } });
    const profile = getProfile(profileId);

    const n = rows.length;
    const interventions = rows.filter((r) => r.interventionTaken).length;
    const escalations = rows.filter((r) => r.escalatedToHuman).length;
    const blocks = rows.filter((r) => r.decision === "BLOCK").length;
    const verifiable = rows.filter((r) => r.verificationPossible).length;

    const latencies = rows.map((r) => r.checkerLatencyMs).sort((a, b) => a - b);

    const byDecision: Record<string, number> = {};
    const categoryCounts = new Map<string, number>();
    for (const r of rows) {
      byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
      try {
        for (const c of JSON.parse(r.categories) as string[]) {
          categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
        }
      } catch { /* ignore malformed */ }
    }

    const labelled = rows.filter((r) => r.humanVerdict);

    // Human feedback for these requests, counted by verdict.
    const feedbackRows = rows.length
      ? await prisma.humanFeedback.findMany({
          where: { requestId: { in: rows.map((r) => r.requestId) } },
        })
      : [];
    const feedbackCounts: Record<string, number> = {};
    for (const f of feedbackRows) {
      feedbackCounts[f.verdict] = (feedbackCounts[f.verdict] ?? 0) + 1;
    }
    const disputed = feedbackRows.filter((f) => f.disputed).length;
    const enough = labelled.length >= MIN_LABELLED;

    const tp = labelled.filter((r) => r.humanVerdict === "CORRECT_FLAG").length;
    const fp = labelled.filter((r) => r.humanVerdict === "FALSE_ALARM").length;
    const fn = labelled.filter((r) => r.humanVerdict === "MISSED_RISK").length;
    const tn = labelled.filter((r) => r.humanVerdict === "CORRECT_PASS").length;

    return {
      profileId,
      profileName: profile.name,
      interactions: n,
      interventionRate: n ? interventions / n : 0,
      escalationRate: n ? escalations / n : 0,
      blockRate: n ? blocks / n : 0,
      verificationCoverage: n ? verifiable / n : 0,
      p50CheckerLatencyMs: percentile(latencies, 50),
      p95CheckerLatencyMs: percentile(latencies, 95),
      byDecision,
      topCategories: [...categoryCounts.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),

      labelledCount: labelled.length,
      truePositives: enough ? tp : null,
      falsePositives: enough ? fp : null,
      trueNegatives: enough ? tn : null,
      falseNegatives: enough ? fn : null,
      falsePositiveRate: enough && fp + tn > 0 ? fp / (fp + tn) : null,
      falseNegativeRate: enough && fn + tp > 0 ? fn / (fn + tp) : null,
      riskEscapeRate: enough && n > 0 ? fn / labelled.length : null,
      cost: costOf(rows),
      feedback: feedbackCounts,
      disputedFeedback: disputed,
      groundTruthNote: enough
        ? `Based on ${labelled.length} human-labelled decisions.`
        : `Unavailable: ${labelled.length} of the ${MIN_LABELLED} labelled decisions needed. Rates that require ground truth are withheld rather than estimated.`,
    };
  }

  async all(): Promise<ProfileMetrics[]> {
    return Promise.all(listProfiles().map((p) => this.forProfile(p.id)));
  }
}

export const checkerMetrics = new CheckerMetricsService();
