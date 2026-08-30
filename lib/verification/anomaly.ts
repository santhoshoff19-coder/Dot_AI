import { prisma } from "@/lib/db";
import { embeddingService, type RetrievalMode } from "@/lib/policy/embeddings";
import { cosine } from "@/lib/policy/vector-store";
import type { UseCaseProfile } from "@/lib/governance/profiles";

export type AnomalyBand = "NORMAL" | "UNUSUAL" | "HIGHLY_UNUSUAL";

export interface AnomalyResult {
  band: AnomalyBand;
  /** 0 = indistinguishable from normal, 1 = nothing like the baseline. */
  score: number;
  baselineSize: number;
  mode: RetrievalMode;
  costUsd: number;
  /** Plain-English, and deliberately non-accusatory. */
  explanation: string;
  /** Never true. Present so callers cannot mistake this for a truth claim. */
  provesHallucination: false;
}

export interface AnomalySlice {
  profileId: string;
  taskType: string;
  modelId: string;
  modality?: string;
}

/**
 * Minimum samples before a baseline means anything. Below this, "unusual" is
 * indistinguishable from "we have barely seen this kind of traffic".
 */
export const MIN_BASELINE_SAMPLES = Number(process.env.ANOMALY_MIN_SAMPLES ?? 5);

/** How many baseline samples one slice retains. */
const MAX_BASELINE_SAMPLES = Number(process.env.ANOMALY_MAX_SAMPLES ?? 60);

/**
 * Default bands. A profile with low risk tolerance narrows them, so the same
 * response is escalated for scrutiny sooner in a regulated use case.
 */
const DEFAULT_THRESHOLDS = {
  unusual: Number(process.env.ANOMALY_UNUSUAL ?? 0.45),
  highlyUnusual: Number(process.env.ANOMALY_HIGHLY_UNUSUAL ?? 0.7),
};

export function thresholdsFor(
  profile?: UseCaseProfile,
  mode: RetrievalMode = "SEMANTIC",
): { unusual: number; highlyUnusual: number } {
  const tolerance = profile?.riskTolerance;
  // Lower tolerance -> flag sooner.
  const risk = tolerance === "low" ? -0.1 : tolerance === "high" ? 0.1 : 0;

  // Lexical vectors compare shared vocabulary, not meaning, so a paraphrase of
  // a perfectly normal answer looks distant. Measured on the shipped baseline,
  // paraphrases scored ~0.51 against ~0.09 for near-identical wording. Widening
  // the bands on this path keeps that noise out of the UNUSUAL band; the honest
  // fix is real embeddings, and `mode` reports which path produced the score.
  const noise = mode === "LEXICAL_FALLBACK" ? 0.25 : 0;

  return {
    unusual: clamp(DEFAULT_THRESHOLDS.unusual + risk + noise),
    highlyUnusual: clamp(DEFAULT_THRESHOLDS.highlyUnusual + risk + noise),
  };
}

function clamp(n: number): number {
  return Math.max(0.05, Math.min(0.98, n));
}

/**
 * Anomaly detection.
 *
 * Compares a response against what this slice of traffic normally looks like.
 * A high score means "this is unlike previous answers here", which is a reason
 * to check more carefully - not evidence that the answer is false. Novel but
 * correct answers score high, and the band names avoid implying otherwise.
 */
export class AnomalyDetector {
  async score(
    answer: string, slice: AnomalySlice, profile?: UseCaseProfile,
  ): Promise<AnomalyResult> {
    const modality = slice.modality ?? "TEXT";

    const baseline = await prisma.anomalyBaselineSample.findMany({
      where: {
        profileId: slice.profileId,
        taskType: slice.taskType,
        modelId: slice.modelId,
        modality,
      },
      orderBy: { createdAt: "desc" },
      take: MAX_BASELINE_SAMPLES,
    });

    if (baseline.length < MIN_BASELINE_SAMPLES) {
      return {
        band: "NORMAL",
        score: 0,
        baselineSize: baseline.length,
        mode: "LEXICAL_FALLBACK",
        costUsd: 0,
        explanation:
          `Only ${baseline.length} baseline sample(s) exist for this use case, task ` +
          `and model, which is too few to call anything unusual.`,
        provesHallucination: false,
      };
    }

    const embedded = await embeddingService.embed([answer]);
    const vector = embedded.vectors[0] ?? [];
    // Thresholds depend on how the vectors were produced, so they are resolved
    // only once the embedding mode is known.
    const thresholds = thresholdsFor(profile, embedded.mode);

    // Distance to the *nearest* normal example, not the average. An answer
    // close to any established pattern is normal even if the slice is diverse.
    let best = 0;
    for (const sample of baseline) {
      let vec: number[] = [];
      try {
        const parsed = JSON.parse(sample.embedding) as unknown;
        if (Array.isArray(parsed)) vec = parsed as number[];
      } catch { continue; }
      const sim = cosine(vector, vec);
      if (sim > best) best = sim;
    }

    const score = Math.round(Math.max(0, Math.min(1, 1 - best)) * 1e4) / 1e4;
    const band: AnomalyBand =
      score >= thresholds.highlyUnusual ? "HIGHLY_UNUSUAL"
      : score >= thresholds.unusual ? "UNUSUAL"
      : "NORMAL";

    return {
      band,
      score,
      baselineSize: baseline.length,
      mode: embedded.mode,
      costUsd: embedded.costUsd,
      explanation:
        band === "NORMAL"
          ? "This response resembles previous answers for this use case and task."
          : `This response is ${band === "HIGHLY_UNUSUAL" ? "markedly" : "somewhat"} ` +
            `different from the ${baseline.length} previous answers in this slice. ` +
            `That is a reason to verify it more carefully, not evidence that it is wrong.` +
            (embedded.mode === "LEXICAL_FALLBACK"
              ? " Scored on lexical similarity, which cannot recognise paraphrase."
              : ""),
      provesHallucination: false,
    };
  }

  /**
   * Adds a response to the baseline. Only responses that actually passed the
   * checker are learned from - otherwise a run of bad answers would redefine
   * normal and quietly stop looking unusual.
   */
  async learn(
    answer: string, slice: AnomalySlice, opts: { passed: boolean },
  ): Promise<boolean> {
    if (!opts.passed || answer.trim().length < 20) return false;
    const modality = slice.modality ?? "TEXT";

    try {
      const embedded = await embeddingService.embed([answer]);
      await prisma.anomalyBaselineSample.create({
        data: {
          profileId: slice.profileId,
          taskType: slice.taskType,
          modelId: slice.modelId,
          modality,
          embedding: JSON.stringify(embedded.vectors[0] ?? []),
          excerpt: answer.slice(0, 160),
        },
      });

      // Keep the window bounded so the baseline tracks recent behaviour.
      const count = await prisma.anomalyBaselineSample.count({
        where: { profileId: slice.profileId, taskType: slice.taskType, modelId: slice.modelId, modality },
      });
      if (count > MAX_BASELINE_SAMPLES) {
        const stale = await prisma.anomalyBaselineSample.findMany({
          where: { profileId: slice.profileId, taskType: slice.taskType, modelId: slice.modelId, modality },
          orderBy: { createdAt: "asc" },
          take: count - MAX_BASELINE_SAMPLES,
          select: { id: true },
        });
        await prisma.anomalyBaselineSample.deleteMany({
          where: { id: { in: stale.map((s) => s.id) } },
        });
      }
      return true;
    } catch (err) {
      console.error("[anomaly] baseline write failed", err);
      return false;
    }
  }

  async baselineStats() {
    const rows = await prisma.anomalyBaselineSample.groupBy({
      by: ["profileId", "taskType", "modelId", "modality"],
      _count: true,
    });
    return rows.map((r) => ({
      profileId: r.profileId, taskType: r.taskType, modelId: r.modelId,
      modality: r.modality, samples: r._count,
      usable: r._count >= MIN_BASELINE_SAMPLES,
    }));
  }
}

export const anomalyDetector = new AnomalyDetector();
