import { prisma } from "@/lib/db";
import { anomalyDetector, MIN_BASELINE_SAMPLES } from "@/lib/verification/anomaly";

/** Labelled outcomes needed before FP/FN rates are reported at all. */
export const MIN_LABELLED_FOR_RATES = Number(process.env.MIN_LABELLED_VERIFIER ?? 20);

export interface VerifierMetrics {
  profileId: string;
  calls: number;
  byOutcome: Record<string, number>;
  /** Verifier ran but could not produce a verdict. */
  unavailableRate: number;
  /** Share of calls where no independent model was available. */
  sameModelRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalCostUsd: number;
  avgCostPerCall: number;
  avgConfidence: number;
  labelled: number;
  /** Null until enough human labels exist. Never guessed. */
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  ratesNote: string;
}

export interface AnomalyMetrics {
  scored: number;
  byBand: Record<string, number>;
  /** How often an unusual response turned out to be contradicted. */
  precisionProxy: number | null;
  precisionNote: string;
  baselines: { slice: string; samples: number; usable: boolean }[];
  usableBaselines: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Verification quality metrics.
 *
 * The honesty rule from Tier 1 applies unchanged: any rate that needs ground
 * truth is withheld until enough decisions have actually been labelled.
 */
export class VerificationMetricsService {
  async verifierMetrics(profileId?: string): Promise<VerifierMetrics[]> {
    const calls = await prisma.verifierCall.findMany({
      where: profileId ? { profileId } : {},
      take: 2000,
      orderBy: { createdAt: "desc" },
    });

    const byProfile = new Map<string, typeof calls>();
    for (const c of calls) {
      const list = byProfile.get(c.profileId) ?? [];
      list.push(c);
      byProfile.set(c.profileId, list);
    }

    return [...byProfile.entries()].map(([id, rows]) => {
      const byOutcome: Record<string, number> = {};
      for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;

      const latencies = rows.map((r) => r.latencyMs);
      const labelledRows = rows.filter((r) => r.groundTruth);

      // A false positive is the verifier calling something contradicted that a
      // human judged correct; a false negative is the reverse.
      const fp = labelledRows.filter(
        (r) => r.outcome === "CONTRADICTED" && r.groundTruth === "CORRECT").length;
      const fn = labelledRows.filter(
        (r) => r.outcome === "SUPPORTED" && r.groundTruth === "INCORRECT").length;

      const enough = labelledRows.length >= MIN_LABELLED_FOR_RATES;

      return {
        profileId: id,
        calls: rows.length,
        byOutcome,
        unavailableRate: rows.length
          ? round((byOutcome.VERIFICATION_UNAVAILABLE ?? 0) / rows.length) : 0,
        sameModelRate: rows.length
          ? round(rows.filter((r) => r.sameModel).length / rows.length) : 0,
        avgLatencyMs: rows.length
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / rows.length) : 0,
        p95LatencyMs: percentile(latencies, 95),
        totalCostUsd: round(rows.reduce((n, r) => n + r.costUsd, 0), 6),
        avgCostPerCall: rows.length
          ? round(rows.reduce((n, r) => n + r.costUsd, 0) / rows.length, 6) : 0,
        avgConfidence: rows.length
          ? round(rows.reduce((n, r) => n + r.confidence, 0) / rows.length) : 0,
        labelled: labelledRows.length,
        falsePositiveRate: enough ? round(fp / Math.max(labelledRows.length, 1)) : null,
        falseNegativeRate: enough ? round(fn / Math.max(labelledRows.length, 1)) : null,
        ratesNote: enough
          ? `Based on ${labelledRows.length} human-labelled verifier calls.`
          : `Withheld: ${labelledRows.length} of ${MIN_LABELLED_FOR_RATES} labelled calls needed before a rate would mean anything.`,
      };
    });
  }

  async anomalyMetrics(): Promise<AnomalyMetrics> {
    const calls = await prisma.verifierCall.findMany({
      take: 2000, orderBy: { createdAt: "desc" },
    });

    const byBand: Record<string, number> = {};
    for (const c of calls) byBand[c.anomalyBand] = (byBand[c.anomalyBand] ?? 0) + 1;

    const unusual = calls.filter((c) => c.anomalyBand !== "NORMAL");
    const unusualAndWrong = unusual.filter((c) => c.outcome === "CONTRADICTED");

    const baselines = await anomalyDetector.baselineStats();

    return {
      scored: calls.length,
      byBand,
      // A proxy, not precision: it only counts cases where a verifier ran.
      precisionProxy: unusual.length >= 10
        ? round(unusualAndWrong.length / unusual.length) : null,
      precisionNote: unusual.length >= 10
        ? `Of ${unusual.length} responses flagged unusual, ${unusualAndWrong.length} were later contradicted. This is a proxy measured only on verified responses, not true precision.`
        : `Withheld: only ${unusual.length} flagged responses so far, too few to characterise.`,
      baselines: baselines.map((b) => ({
        slice: `${b.profileId} / ${b.taskType} / ${b.modelId}`,
        samples: b.samples,
        usable: b.usable,
      })),
      usableBaselines: baselines.filter((b) => b.usable).length,
    };
  }

  /** Records a human judgement so FP/FN can eventually be computed. */
  async label(requestId: string, groundTruth: "CORRECT" | "INCORRECT"): Promise<boolean> {
    const call = await prisma.verifierCall.findFirst({
      where: { requestId }, orderBy: { createdAt: "desc" },
    });
    if (!call) return false;
    await prisma.verifierCall.update({ where: { id: call.id }, data: { groundTruth } });
    return true;
  }

  get minBaselineSamples(): number {
    return MIN_BASELINE_SAMPLES;
  }
}

function round(n: number, dp = 4): number {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

export const verificationMetrics = new VerificationMetricsService();
