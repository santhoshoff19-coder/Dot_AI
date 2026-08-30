import { modelRegistry, type ModelRegistry } from "@/lib/models/registry";
import { HIGH_RISK_POLICY, routingConfig } from "@/lib/routing/routing-config";
import type {
  ModelOption, ModelOptions, TaskRequirements,
} from "@/lib/routing/route-types";
import type { ModelSpec, TaskType, UserSettings } from "@/types";
import type { QualifiedModel } from "@/lib/models/intelligence";
import type { QualificationResult } from "@/lib/capability/matching";

/**
 * Observed reliability for a model on a specific task, supplied by the
 * learning loop. MODEL x TASK x COMPLEXITY - never one universal score.
 */
export interface ReliabilityLookup {
  (modelId: string, taskType: TaskType): { rate: number; samples: number } | null;
}

export interface ScoringInput {
  requirements: TaskRequirements;
  settings?: Partial<UserSettings>;
  reliability?: ReliabilityLookup;
  /** The user's previously chosen model, offered as the Alternative. */
  previousModelId?: string | null;
  highRisk?: boolean;
  /**
   * Models that already passed the capability filter. When supplied, scoring
   * ranks only these - the hard capability constraints have been applied
   * upstream and must not be re-litigated by cost.
   */
  qualifiedModels?: QualifiedModel[];
}

interface Scored extends ModelOption {
  spec: ModelSpec;
  qualification: QualificationResult | null;
  successProbability: number;
  retryCost: number;
  expectedValue: number;
}

const EFFORT_MULTIPLIER: Record<string, number> = { low: 0, medium: 0.6, high: 2 };

/**
 * ModelScoringEngine — Level 3.
 *
 * Ranks candidates by expected value, not by price and not by raw intelligence:
 *
 *   expectedValue = success x taskValue - cost - expectedRetryCost
 *
 * A cheap model that fails half the time is worth less than a slightly dearer
 * one that succeeds, because the retry is paid for twice.
 */
export class ModelScoringEngine {
  constructor(private registry: ModelRegistry = modelRegistry) {}

  score(input: ScoringInput): ModelOptions {
    const { requirements: req, settings = {}, highRisk = false } = input;

    // Prefer the capability-filtered set when the intelligence database has
    // supplied one; fall back to the static registry otherwise.
    const qualification = new Map<string, QualificationResult>();
    let pool: ModelSpec[];

    if (input.qualifiedModels?.length) {
      for (const q of input.qualifiedModels) qualification.set(q.openrouterModelId, q.qualification);
      pool = input.qualifiedModels.map((q) => this.toSpec(q));
    } else {
      const eligible = this.registry
        .eligible(req.requiredCapabilities, req.contextRequirement)
        .filter((m) => this.supportsModalities(m, req));
      pool = eligible.length ? eligible : this.registry.all();
    }

    // Value at stake scales with consequence: getting a payment wrong costs
    // far more than getting a summary slightly off.
    const taskValue = this.taskValue(req, highRisk);

    const scored: Scored[] = pool.map((m) => {
      const cost = this.estimateCost(m, req);
      const success = this.successProbability(m, req, input.reliability);
      // A failure means regenerating, typically on a stronger model.
      const retryCost = (1 - success) * cost * 1.8;
      const expectedValue = success * taskValue - cost - retryCost;

      return {
        modelId: m.id,
        name: m.name,
        provider: m.provider,
        estimatedCost: round(cost),
        expectedSuccess: round(success, 4),
        latencyClass: m.latencyClass,
        score: round(expectedValue),
        fit: success >= 0.9 ? "high" : success >= 0.78 ? "medium" : "low",
        rationale: "",
        qualification: qualification.get(m.id) ?? null,
        spec: m,
        successProbability: success,
        retryCost: round(retryCost),
        expectedValue,
      };
    });

    // ---- floors --------------------------------------------------------
    let floor = 0.8;
    if (req.riskLevel === "high") floor = 0.86;
    if (req.riskLevel === "critical") floor = 0.9;
    if (settings.costPreference === "BEST_QUALITY") floor = Math.max(floor, 0.9);
    // A cost preference may lower the bar for ordinary work only. Mandatory
    // high-risk controls are never negotiable.
    if (settings.costPreference === "LOWEST" && !highRisk) floor = Math.min(floor, 0.72);

    if (highRisk) {
      floor = Math.max(floor, HIGH_RISK_POLICY.minExpectedSuccess);
    }

    const meetsPolicy = (s: Scored) =>
      !highRisk || s.spec.relativeCapability >= HIGH_RISK_POLICY.minRelativeCapability;

    const viable = scored.filter((s) => s.expectedSuccess >= floor && meetsPolicy(s));
    const candidatePool = viable.length ? viable : scored.filter(meetsPolicy);
    const finalPool = candidatePool.length ? candidatePool : scored;

    // RECOMMENDABLE: lowest cost among those likely to succeed.
    //
    // If nothing clears the floor the fallback depends on consequence. For
    // ordinary work the cheapest option is a reasonable compromise; for
    // high-risk work it is not - falling back to the cheapest model precisely
    // when no model is reliable enough would invert the control. There we take
    // the strongest available instead.
    const noneViable = viable.length === 0;
    const recommendable = noneViable && highRisk
      ? [...finalPool].sort(
          (a, b) => b.expectedSuccess - a.expectedSuccess || a.estimatedCost - b.estimatedCost,
        )[0]
      : [...finalPool].sort(
          (a, b) => a.estimatedCost - b.estimatedCost || b.expectedSuccess - a.expectedSuccess,
        )[0];

    // BEST: highest capability suitable for the task.
    const best = [...scored]
      .filter(meetsPolicy)
      .sort(
        (a, b) =>
          b.spec.relativeCapability - a.spec.relativeCapability ||
          b.expectedSuccess - a.expectedSuccess,
      )[0] ?? recommendable;

    // ALTERNATIVE: the user's previous pick when it is viable, otherwise the
    // next best expected value that is not already shown.
    const shown = new Set([recommendable.modelId, best.modelId]);
    const previous = input.previousModelId
      ? scored.find((s) => s.modelId === input.previousModelId && !shown.has(s.modelId) && meetsPolicy(s))
      : undefined;
    const alternative =
      previous ??
      [...scored]
        .filter((s) => !shown.has(s.modelId) && meetsPolicy(s))
        .sort((a, b) => b.expectedValue - a.expectedValue)[0] ??
      null;

    recommendable.rationale = this.rationaleFor("recommendable", recommendable, req, highRisk);
    best.rationale = this.rationaleFor("best", best, req, highRisk);
    if (alternative) {
      alternative.rationale = previous
        ? "Your previous choice, still suitable for this task."
        : this.rationaleFor("alternative", alternative, req, highRisk);
    }

    return {
      recommendable: strip(recommendable),
      best: strip(best),
      alternative: alternative ? strip(alternative) : null,
      all: [...scored].sort((a, b) => b.expectedValue - a.expectedValue).map(strip),
    };
  }

  /**
   * Adapts a capability-filtered database record to the shape the scorer
   * works in. Skill per task falls back to the registry when the model is one
   * dotAI ships with, and to a capability-derived estimate otherwise.
   */
  private toSpec(q: QualifiedModel): ModelSpec {
    const known = this.registry.get(q.openrouterModelId);
    if (known) return known;

    const levelScore = { LOW: 0.55, MEDIUM: 0.78, HIGH: 0.93 } as const;
    const relative =
      (levelScore[q.capability.reasoning] + levelScore[q.capability.instructionComplexity]) / 2;

    return {
      id: q.openrouterModelId,
      provider: q.provider,
      name: q.name,
      capabilities: ["text"],
      inputCost: q.inputPrice,
      outputCost: q.outputPrice,
      contextLimit: q.contextLength,
      modalities: ["text"],
      reasoningSupport: q.capability.reasoning === "HIGH",
      relativeCapability: relative,
      latencyClass: (q.latencyClass as ModelSpec["latencyClass"]) ?? "balanced",
      enabled: true,
      skills: {},
    };
  }

  // ------------------------------------------------------------------
  private supportsModalities(m: ModelSpec, req: TaskRequirements): boolean {
    return req.modalities.every((mod) => mod === "text" || m.modalities.includes(mod));
  }

  /**
   * An unknown price cannot be compared. Such a model is costed at Infinity so
   * it can still be recommended on capability, but can never be presented as
   * the cheapest option on the strength of a sentinel value.
   */
  private estimateCost(m: ModelSpec, req: TaskRequirements): number {
    if (m.inputCost < 0 || m.outputCost < 0) return Number.POSITIVE_INFINITY;
    return this.estimateKnownCost(m, req);
  }

  private estimateKnownCost(m: ModelSpec, req: TaskRequirements): number {
    const mult = EFFORT_MULTIPLIER[req.recommendedEffort] ?? 0.6;
    const reasoning = m.reasoningSupport ? Math.round(req.expectedOutputSize * mult) : 0;
    return this.registry.price(m, req.estimatedInputTokens, req.expectedOutputSize, reasoning);
  }

  /**
   * P(this model completes THIS task). Declared skill is discounted by
   * complexity, then blended with observed reliability once we have enough
   * samples to trust it.
   */
  private successProbability(
    m: ModelSpec,
    req: TaskRequirements,
    reliability?: ReliabilityLookup,
  ): number {
    const skill = m.skills && Object.keys(m.skills).length
      ? this.registry.skill(m, req.taskType)
      : m.relativeCapability;
    let p = skill - req.complexity * (1 - skill) * 1.15;

    if (req.reasoningRequirement === "heavy" && !m.reasoningSupport) p -= 0.25;
    if (req.contextRequirement > m.contextLimit) p -= 0.4;

    const observed = reliability?.(m.id, req.taskType);
    if (observed && observed.samples >= routingConfig.RELIABILITY_MIN_SAMPLE) {
      // Blend, never replace: one bad afternoon must not rewrite a model.
      p = p * 0.7 + observed.rate * 0.3;
    }

    return Math.max(0.01, Math.min(0.99, p));
  }

  private taskValue(req: TaskRequirements, highRisk: boolean): number {
    const base = { low: 0.5, medium: 1.5, high: 6, critical: 20 }[req.riskLevel];
    return base * (1 + req.complexity) * (highRisk ? 2 : 1);
  }

  private rationaleFor(
    kind: "recommendable" | "best" | "alternative",
    s: Scored,
    req: TaskRequirements,
    highRisk: boolean,
  ): string {
    const task = req.taskType.replace(/_/g, " ");
    if (kind === "recommendable") {
      if (highRisk) {
        return s.expectedSuccess >= HIGH_RISK_POLICY.minExpectedSuccess
          ? "Meets the mandatory capability floor for high-risk work at the lowest expected cost."
          : "Strongest available model; this task is above the confidence bar for automated handling.";
      }
      return `Sufficient capability for this ${task} task at the lowest expected cost.`;
    }
    if (kind === "best") {
      return `Highest-capability model suitable for this ${task} task.`;
    }
    return `A viable third option, trading ${s.latencyClass === "fast" ? "capability for speed" : "cost for capability"}.`;
  }
}

function strip(s: Scored): ModelOption {
  const { spec, successProbability, retryCost, expectedValue, qualification, ...rest } = s;
  void spec; void successProbability; void retryCost; void expectedValue;
  return {
    ...rest,
    capabilityChecks: qualification
      ? qualification.checks.map((c) => ({
          label: c.label, required: c.required, actual: c.actual, passed: c.passed,
        }))
      : undefined,
  };
}

function round(n: number, dp = 6) { return Math.round(n * 10 ** dp) / 10 ** dp; }

export const modelScoringEngine = new ModelScoringEngine();
