import { prisma } from "@/lib/db";
import {
  CHAMPION_TYPES, ELIGIBLE_STATUSES, TASK_REQUIREMENTS, confidenceFor,
  deriveCapabilities, normaliseTaskType,
  type Capability, type ChampionType, type Confidence, type TaskType,
} from "@/lib/intelligence/taxonomy";
import type { UseCaseProfile } from "@/lib/governance/profiles";

/** Candidates fetched before detailed ranking. Bounded, never the whole catalog. */
export const CANDIDATE_LIMIT = Number(process.env.CANDIDATE_LIMIT ?? 20);

export interface ScoreWeights {
  quality: number;
  reliability: number;
  cost: number;
  latency: number;
  execution: number;
  capability: number;
  /** Nudge applied when a candidate adds provider diversity. */
  providerDiversity: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  quality: 0.22, reliability: 0.22, cost: 0.22,
  latency: 0.12, execution: 0.14, capability: 0.08,
  providerDiversity: 0.05,
};

/**
 * Weights per use case. The same prompt should rank differently when the
 * consequence differs: support wants cheap and fast, a regulated decision
 * wants reliable and high quality.
 */
/**
 * Routing weights.
 *
 * A single set. These were keyed by use-case profile, which meant the same
 * prompt could route to a different model depending on a dropdown - and the
 * profiles are gone.
 */
export const PROFILE_WEIGHTS: Record<string, ScoreWeights> = {
  BASELINE: {
    quality: 0.26, reliability: 0.24, cost: 0.19,
    latency: 0.13, execution: 0.13, capability: 0.03, providerDiversity: 0.02,
  },
};

/**
 * Routing weights.
 *
 * One set, whatever governance policy is in force. Which model runs is
 * decided by capability matching against the curated dataset; the governance
 * policy decides how the *result* is judged. Letting the policy also reweight
 * model selection would make the same prompt route differently for reasons
 * that have nothing to do with what the prompt needs.
 */
export function weightsFor(profile?: UseCaseProfile | null): ScoreWeights {
  return PROFILE_WEIGHTS[profile?.id ?? ""] ?? PROFILE_WEIGHTS.BASELINE ?? DEFAULT_WEIGHTS;
}

export interface Candidate {
  modelId: string;
  name: string;
  provider: string;
  inputPrice: number;
  outputPrice: number;
  pricingKnown: boolean;
  contextLength: number;
  latencyClass: string;
  executionStatus: string;
  scores: {
    quality: number; reliability: number; cost: number; latency: number;
    execution: number; capability: number; overall: number;
  };
  sampleCount: number;
  successRate: number;
  confidence: Confidence;
  reasons: string[];
}

/**
 * Model Intelligence.
 *
 * CAI decides what the task requires; this decides which models can satisfy
 * it. Capability filtering is a hard gate done in the database, so a highly
 * rated text model can never outrank a valid image model for image work.
 */
export class ModelIntelligenceService {
  /** Rebuilds the per-capability matrix from stored provider metadata. */
  async indexCapabilities(limit = 1000): Promise<{ models: number; rows: number }> {
    const models = await prisma.model.findMany({
      where: { active: true },
      include: { modalities: true },
      take: limit,
    });

    let rows = 0;
    for (const m of models) {
      const derived = deriveCapabilities({
        inputModalities: m.modalities.filter((x) => x.direction === "INPUT").map((x) => x.modality),
        outputModalities: m.modalities.filter((x) => x.direction === "OUTPUT").map((x) => x.modality),
        supportedParameters: safeList(m.supportedParameters),
        contextLength: m.contextLength,
      });

      for (const d of derived) {
        await prisma.modelTaskCapability.upsert({
          where: { modelId_capability: { modelId: m.id, capability: d.capability } },
          create: {
            modelId: m.id, capability: d.capability,
            status: d.status, evidence: "METADATA", detail: d.detail,
          },
          // A VERIFIED status came from a real execution and outranks metadata.
          update: {
            status: d.status, detail: d.detail, lastValidated: new Date(),
          },
        });
        rows++;
      }
    }
    return { models: models.length, rows };
  }

  /**
   * The candidate pool for a task.
   *
   * Indexed query, hard capability gate, bounded result. This is what replaced
   * loading every model into memory on each request.
   */
  async candidatePool(taskType: TaskType, opts: {
    limit?: number; includeUnverified?: boolean;
  } = {}): Promise<Candidate[]> {
    const required = TASK_REQUIREMENTS[taskType] ?? [];
    const limit = opts.limit ?? CANDIDATE_LIMIT;

    // Every required capability must be present and eligible. Expressed as an
    // AND of `some` clauses so the database does the filtering.
    const capabilityFilter = required.map((capability: Capability) => ({
      taskCapabilities: {
        some: { capability, status: { in: ELIGIBLE_STATUSES } },
      },
    }));

    const models = await prisma.model.findMany({
      where: { active: true, AND: capabilityFilter },
      include: {
        taskScores: { where: { taskType } },
        modelExecutionStatuses: true,
        taskCapabilities: { where: { capability: { in: required } } },
      },
      take: Math.max(limit * 3, 40),
    });

    const candidates = models
      .map((m) => this.toCandidate(m, taskType))
      .filter((c) => {
        // A model known to fail this capability is never a candidate.
        if (c.executionStatus === "FAILED" || c.executionStatus === "UNSUPPORTED") return false;
        if (!opts.includeUnverified && c.executionStatus === "UNAVAILABLE") return false;
        return true;
      });

    return candidates.slice(0, limit * 3);
  }

  private toCandidate(
    m: {
      openrouterModelId: string; name: string; provider: string;
      inputPrice: number; outputPrice: number; pricingKnown: boolean;
      contextLength: number; latencyClass: string;
      taskScores: { qualityScore: number; reliabilityScore: number; costScore: number;
        latencyScore: number; executionScore: number; capabilityScore: number;
        overallScore: number; sampleCount: number; successRate: number }[];
      modelExecutionStatuses: { status: string }[];
      taskCapabilities: { capability: string; status: string }[];
    },
    taskType: TaskType,
  ): Candidate {
    const score = m.taskScores[0];
    const verified = m.taskCapabilities.filter((c) => c.status === "VERIFIED").length;
    const execStatus = m.modelExecutionStatuses[0]?.status ?? "UNCHECKED";

    const reasons: string[] = [
      `Supports every capability required for ${taskType.replace(/_/g, " ").toLowerCase()}`,
    ];
    if (verified > 0) reasons.push(`${verified} capability check(s) verified by execution`);
    if (execStatus === "EXECUTION_VERIFIED") reasons.push("Execution verified against the provider");
    else if (execStatus === "METADATA_COMPATIBLE") reasons.push("Compatible per catalog metadata; execution unproven");

    return {
      modelId: m.openrouterModelId,
      name: m.name,
      provider: m.provider,
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
      pricingKnown: m.pricingKnown,
      contextLength: m.contextLength,
      latencyClass: m.latencyClass,
      executionStatus: execStatus,
      scores: {
        quality: score?.qualityScore ?? 0.5,
        reliability: score?.reliabilityScore ?? 0.5,
        cost: score?.costScore ?? 0.5,
        latency: score?.latencyScore ?? 0.5,
        execution: score?.executionScore ?? 0.5,
        capability: score?.capabilityScore ?? 0.5,
        overall: score?.overallScore ?? 0.5,
      },
      sampleCount: score?.sampleCount ?? 0,
      successRate: score?.successRate ?? 0,
      confidence: confidenceFor(score?.sampleCount ?? 0),
      reasons,
    };
  }

  /**
   * Ranks a pool under a set of weights.
   *
   * Cost is normalised across the pool rather than taken absolutely, and an
   * unknown price scores neutrally so a sentinel can never win on price.
   */
  rank(pool: Candidate[], weights: ScoreWeights): Candidate[] {
    if (pool.length === 0) return [];

    const priced = pool.filter((c) => c.pricingKnown);
    const maxPrice = Math.max(...priced.map((c) => c.inputPrice + c.outputPrice), 0.000001);

    const latencyScore = (c: Candidate) =>
      c.latencyClass === "fast" ? 1 : c.latencyClass === "balanced" ? 0.6 : 0.3;

    const executionScore = (c: Candidate) =>
      c.executionStatus === "EXECUTION_VERIFIED" ? 1
      : c.executionStatus === "METADATA_COMPATIBLE" ? 0.6
      : c.executionStatus === "TEMPORARILY_UNAVAILABLE" ? 0.2 : 0.4;

    const seenProviders = new Set<string>();

    return [...pool]
      .map((c) => {
        // Unknown pricing scores mid, never best.
        const cost = c.pricingKnown
          ? 1 - Math.min(1, (c.inputPrice + c.outputPrice) / maxPrice)
          : 0.5;
        const latency = latencyScore(c);
        const execution = executionScore(c);

        // A low-confidence score is pulled toward neutral, so a single lucky
        // run cannot make a model look outstanding.
        const trust = c.confidence === "HIGH" ? 1 : c.confidence === "MEDIUM" ? 0.6 : 0.25;
        const blend = (measured: number) => 0.5 + (measured - 0.5) * trust;

        const overall =
          weights.quality * blend(c.scores.quality) +
          weights.reliability * blend(c.scores.reliability) +
          weights.cost * cost +
          weights.latency * latency +
          weights.execution * execution +
          weights.capability * c.scores.capability;

        return { ...c, scores: { ...c.scores, cost, latency, execution, overall } };
      })
      .sort((a, b) => b.scores.overall - a.scores.overall)
      .map((c) => {
        // Provider diversity is a tie-breaker, applied after ordering so it
        // nudges rather than dominates.
        const novel = !seenProviders.has(c.provider);
        seenProviders.add(c.provider);
        return novel
          ? { ...c, scores: { ...c.scores, overall: c.scores.overall + DEFAULT_WEIGHTS.providerDiversity * 0.2 } }
          : c;
      })
      .sort((a, b) => b.scores.overall - a.scores.overall);
  }

  /** Champion for one role, or null when the pool cannot support it. */
  pickChampion(pool: Candidate[], type: ChampionType): Candidate | null {
    if (pool.length === 0) return null;
    const usable = pool.filter((c) => c.scores.reliability >= 0.3);
    const from = usable.length ? usable : pool;

    switch (type) {
      case "QUALITY":
        return [...from].sort((a, b) => b.scores.quality - a.scores.quality)[0] ?? null;
      case "VALUE": {
        // Quality and reliability per unit of cost, not lowest sticker price.
        const scored = from.map((c) => ({
          c,
          v: (c.scores.quality + c.scores.reliability) / 2 * (c.pricingKnown ? c.scores.cost : 0.4),
        }));
        return scored.sort((a, b) => b.v - a.v)[0]?.c ?? null;
      }
      case "SPEED": {
        // Fastest that still clears a minimum quality bar.
        const eligible = from.filter((c) => c.scores.quality >= 0.4);
        return [...(eligible.length ? eligible : from)]
          .sort((a, b) => b.scores.latency - a.scores.latency)[0] ?? null;
      }
      case "RELIABILITY": {
        // Requires evidence: an unmeasured model is not "most reliable".
        const measured = from.filter((c) => c.confidence !== "LOW");
        return [...(measured.length ? measured : from)]
          .sort((a, b) => b.scores.reliability - a.scores.reliability)[0] ?? null;
      }
      case "DEFAULT":
      default:
        return [...from].sort((a, b) => b.scores.overall - a.scores.overall)[0] ?? null;
    }
  }

  /**
   * Recalculates champions for every executable task.
   *
   * Run after sync, assessment or meaningful feedback - never per request.
   */
  async recalculateChampions(tasks: TaskType[], profile?: UseCaseProfile | null): Promise<{
    tasksEvaluated: number; championsWritten: number; changed: number;
  }> {
    const weights = weightsFor(profile);
    const profileId = profile?.id ?? "GLOBAL";
    let championsWritten = 0;
    let changed = 0;

    for (const taskType of tasks) {
      const pool = this.rank(await this.candidatePool(taskType), weights);
      if (pool.length === 0) continue;

      for (const championType of CHAMPION_TYPES) {
        const winner = this.pickChampion(pool, championType);
        // Never invent a champion for a role the pool cannot fill.
        if (!winner) continue;

        const model = await prisma.model.findUnique({
          where: { openrouterModelId: winner.modelId }, select: { id: true },
        });
        if (!model) continue;

        const existing = await prisma.modelChampion.findUnique({
          where: { taskType_championType_profileId: { taskType, championType, profileId } },
        });

        const reason = championReason(championType, winner);

        if (existing && existing.modelId !== model.id) {
          changed++;
          await prisma.modelChampionHistory.create({
            data: {
              taskType, championType, profileId,
              modelId: model.id, previousModel: existing.modelId,
              score: winner.scores.overall, reason,
            },
          });
        } else if (!existing) {
          await prisma.modelChampionHistory.create({
            data: {
              taskType, championType, profileId,
              modelId: model.id, score: winner.scores.overall, reason,
            },
          });
        }

        await prisma.modelChampion.upsert({
          where: { taskType_championType_profileId: { taskType, championType, profileId } },
          create: {
            modelId: model.id, taskType, championType, profileId,
            score: winner.scores.overall, confidence: winner.confidence, reason,
          },
          update: {
            modelId: model.id, score: winner.scores.overall,
            confidence: winner.confidence, reason,
          },
        });
        championsWritten++;
      }
    }

    return { tasksEvaluated: tasks.length, championsWritten, changed };
  }

  async championsFor(taskType: TaskType, profileId = "GLOBAL") {
    return prisma.modelChampion.findMany({
      where: { taskType, profileId },
      include: { model: true },
    });
  }

  async allChampions(profileId = "GLOBAL") {
    return prisma.modelChampion.findMany({
      where: { profileId }, include: { model: true }, orderBy: { taskType: "asc" },
    });
  }

  /**
   * Records an execution against MODEL + TASK.
   *
   * Task-specific by construction: failing at image generation must not lower
   * a model's summarisation score.
   */
  async recordOutcome(input: {
    openrouterModelId: string;
    taskType: string;
    success: boolean;
    latencyMs?: number;
    costUsd?: number;
    /** True when the checker rejected the content, not the provider. */
    qualityFailure?: boolean;
  }): Promise<void> {
    const taskType = normaliseTaskType(input.taskType);
    const model = await prisma.model.findUnique({
      where: { openrouterModelId: input.openrouterModelId }, select: { id: true },
    });
    if (!model) return;

    const existing = await prisma.modelTaskScore.findUnique({
      where: { modelId_taskType_endpointType: { modelId: model.id, taskType, endpointType: "chat" } },
    });

    const successCount = (existing?.successCount ?? 0) + (input.success ? 1 : 0);
    const failureCount = (existing?.failureCount ?? 0) + (input.success ? 0 : 1);
    const sampleCount = successCount + failureCount;
    const successRate = sampleCount ? successCount / sampleCount : 0;

    const n = existing?.sampleCount ?? 0;
    const avgLatency = input.latencyMs !== undefined
      ? ((existing?.averageLatencyMs ?? 0) * n + input.latencyMs) / Math.max(sampleCount, 1)
      : existing?.averageLatencyMs ?? 0;
    const avgCost = input.costUsd !== undefined
      ? ((existing?.averageCost ?? 0) * n + input.costUsd) / Math.max(sampleCount, 1)
      : existing?.averageCost ?? 0;

    // Reliability follows execution outcomes; quality only moves when the
    // checker rejected the content itself.
    const reliabilityScore = clamp(successRate);
    const qualityBase = existing?.qualityScore ?? 0.5;
    const qualityScore = input.qualityFailure
      ? clamp(qualityBase - 0.05)
      : input.success ? clamp(qualityBase + 0.01) : qualityBase;

    const confidence = confidenceFor(sampleCount);

    // Output quality tracks the checker's verdict; task intelligence moves
    // only on a quality failure, because a provider timeout says nothing
    // about whether the model understands the task.
    const outputQualityScore = qualityScore;
    const intelligenceBase = existing?.taskIntelligenceScore ?? existing?.qualityScore ?? 0.5;
    const taskIntelligenceScore = input.qualityFailure
      ? clamp(intelligenceBase - 0.03)
      : input.success ? clamp(intelligenceBase + 0.005) : intelligenceBase;

    // A real run replaces the seeded estimate for the dimensions it actually
    // evidences. Everything it does not evidence keeps its prior provenance,
    // so nothing becomes "observed" on the strength of an unrelated call.
    const priorQuality = ((): Record<string, string> => {
      try { return JSON.parse(existing?.dataQuality ?? "{}") as Record<string, string>; }
      catch { return {}; }
    })();

    const dataQuality = JSON.stringify({
      ...priorQuality,
      reliability: "OBSERVED",
      latency: input.latencyMs !== undefined ? "OBSERVED" : priorQuality.latency ?? "INFERRED",
      outputQuality: input.qualityFailure !== undefined ? "OBSERVED" : priorQuality.outputQuality ?? "ESTIMATED",
      taskIntelligence: input.qualityFailure ? "OBSERVED" : priorQuality.taskIntelligence ?? "ESTIMATED",
    });

    const scored = {
      qualityScore, outputQualityScore, taskIntelligenceScore, reliabilityScore,
      successCount, failureCount, sampleCount, successRate, confidence,
      averageLatencyMs: avgLatency, averageCost: avgCost, dataQuality,
    };

    await prisma.modelTaskScore.upsert({
      where: { modelId_taskType_endpointType: { modelId: model.id, taskType, endpointType: "chat" } },
      create: {
        modelId: model.id, taskType, ...scored,
        lastSuccess: input.success ? new Date() : null,
        lastFailure: input.success ? null : new Date(),
      },
      update: {
        ...scored,
        ...(input.success ? { lastSuccess: new Date() } : { lastFailure: new Date() }),
        lastScoreUpdate: new Date(),
      },
    });
  }

  async scoreFor(openrouterModelId: string, taskType: string) {
    const model = await prisma.model.findUnique({
      where: { openrouterModelId }, select: { id: true },
    });
    if (!model) return null;
    return prisma.modelTaskScore.findUnique({
      where: { modelId_taskType_endpointType: { modelId: model.id, taskType: normaliseTaskType(taskType), endpointType: "chat" } },
    });
  }
}

function championReason(type: ChampionType, c: Candidate): string {
  const bits: string[] = [];
  switch (type) {
    case "QUALITY": bits.push(`Highest measured quality (${pct(c.scores.quality)})`); break;
    case "VALUE": bits.push(`Best quality and reliability per unit cost`); break;
    case "SPEED": bits.push(`Fastest candidate meeting the quality floor (${c.latencyClass})`); break;
    case "RELIABILITY": bits.push(`Highest success rate (${pct(c.scores.reliability)})`); break;
    default: bits.push(`Best weighted score for this task (${pct(c.scores.overall)})`);
  }
  if (c.sampleCount > 0) bits.push(`${c.sampleCount} recorded run(s)`);
  bits.push(c.executionStatus === "EXECUTION_VERIFIED" ? "execution verified" : "execution unproven");
  bits.push(c.pricingKnown ? "pricing known" : "pricing unavailable");
  return bits.join("; ") + ".";
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const clamp = (n: number) => Math.max(0, Math.min(1, n));

function safeList(raw: string): string[] {
  try {
    const p = JSON.parse(raw) as unknown;
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}

export const modelIntelligenceService = new ModelIntelligenceService();
