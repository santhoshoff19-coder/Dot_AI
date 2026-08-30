import { caiService } from "@/lib/cai/service";
import { modelScoringEngine } from "@/lib/models/scoring";
import { fastRouter } from "@/lib/routing/fast-router";
import { modelIntelligence } from "@/lib/models/intelligence";
import {
  isVerified, modelExecution,
  type ExecutionStatus, type Modality as ExecModality,
} from "@/lib/models/execution";
import { deriveRequirementProfile } from "@/lib/capability/derive";
import { modelIntelligenceService, weightsFor } from "@/lib/intelligence/service";
import { normaliseTaskType } from "@/lib/intelligence/taxonomy";
import { HIGH_RISK_POLICY, routingConfig } from "@/lib/routing/routing-config";
import type {
  FastRouteResult, RouteSource, RoutingResult, TaskRequirements,
} from "@/lib/routing/route-types";
import type {
  AttachmentRef, ModelCandidate, StreamEvent, UserSettings, VerificationDepth,
} from "@/types";

export interface RouteInput {
  prompt: string;
  attachments?: AttachmentRef[];
  historyChars?: number;
  settings?: Partial<UserSettings>;
  previousModelId?: string | null;
  reliability?: Parameters<typeof modelScoringEngine.score>[0]["reliability"];
  /**
   * The output modality the caller has already resolved (explicit user choice
   * or an explicit phrase in the request). It is authoritative: capability
   * filtering must select models that can produce what was actually asked for.
   */
  outputOverride?: "TEXT" | "IMAGE";
  /** Governing use case, so ranking weights match the consequence. */
  profile?: import("@/lib/governance/profiles").UseCaseProfile | null;
  /**
   * Compact summary of the conversation so far, so a follow-up such as
   * "make it blue" can be classified against what came before.
   */
  conversationDigest?: string;
}

/**
 * The routing stage.
 *
 *   FAST ROUTER -> can we classify this for free?
 *      yes, ordinary  -> DIRECT
 *      yes, dangerous -> HIGH_RISK_POLICY
 *      no             -> CAI
 *   -> MODEL SCORING ENGINE -> three options
 *
 * The guiding rule: do not spend money to decide something we already know.
 */
export async function routeRequest(
  input: RouteInput,
  emit?: (e: StreamEvent) => void,
): Promise<RoutingResult> {
  const { prompt, attachments = [], historyChars = 0, settings = {} } = input;

  emit?.({ type: "status", stage: "understanding", label: "Understanding request" });

  // ---- LEVEL 1: Fast Router (free) --------------------------------------
  const fast: FastRouteResult = fastRouter.route({ prompt, attachments, historyChars });

  let requirements: TaskRequirements;
  let routeSource: RouteSource;
  let caiUsed = false;
  let caiSkippedReason: string | undefined;
  // When CAI runs, its seven-field output is authoritative and is used
  // directly rather than being re-derived from an intermediate structure.
  let caiProfile: import("@/lib/capability/taxonomy").TaskRequirementProfile | undefined;
  let caiCost = 0;
  let caiSchemaValid = true;

  const directBar = fast.highRisk
    ? routingConfig.HIGH_RISK_DIRECT_CONFIDENCE
    : routingConfig.FAST_ROUTE_MIN_CONFIDENCE;

  const canRouteDirectly = fast.routeType === "DIRECT" && fast.confidence >= directBar;

  if (canRouteDirectly && fast.highRisk) {
    // ---- HIGH-RISK POLICY ROUTE -----------------------------------------
    routeSource = "HIGH_RISK_POLICY";
    caiSkippedReason = "High-risk intent was recognised directly; CAI adds nothing.";

    emit?.({
      type: "status",
      stage: "route",
      label: `Task recognised: high-risk action (${Math.round(fast.confidence * 100)}% confidence)`,
    });
    emit?.({
      type: "status",
      stage: "policy",
      label: "High-risk policy route — mandatory deep verification",
    });

    requirements = {
      ...caiService.classifyLegacy({ prompt, attachments, historyChars, hint: fast }),
      riskLevel: fast.riskLevel,
      recommendedEffort: HIGH_RISK_POLICY.effort,
      requiredCapabilities: fast.directRoute?.requiredCapabilities ?? ["text", "reasoning"],
      confidence: fast.confidence,
      rationale: "Recognised as a consequential action; routed under high-risk policy.",
    };
  } else if (canRouteDirectly) {
    // ---- DIRECT ROUTE ----------------------------------------------------
    routeSource = "DIRECT";
    caiSkippedReason = "CAI skipped — task was confidently classified.";

    emit?.({
      type: "status",
      stage: "route",
      label: `Task recognised: ${label(fast.taskType)} (${Math.round(fast.confidence * 100)}% confidence)`,
    });
    emit?.({ type: "status", stage: "direct", label: "Direct routing — CAI not required" });

    const baseline = caiService.classifyLegacy({ prompt, attachments, historyChars, hint: fast });
    requirements = {
      ...baseline,
      taskType: fast.directRoute?.taskType ?? fast.taskType,
      complexity: fast.complexity,
      riskLevel: fast.riskLevel,
      requiredCapabilities: fast.directRoute?.requiredCapabilities ?? baseline.requiredCapabilities,
      recommendedEffort: fast.directRoute?.recommendedEffort ?? baseline.recommendedEffort,
      confidence: fast.confidence,
      rationale: fast.reason,
    };
  } else {
    // ---- LEVEL 2: CAI ----------------------------------------------------
    routeSource = "CAI";
    caiUsed = true;

    emit?.({ type: "status", stage: "route", label: "Task requires deeper analysis" });
    emit?.({ type: "status", stage: "cai", label: "CAI analysing requirements" });

    const cai = await caiService.understand({
      prompt, attachments, historyChars, settings, hint: fast,
    });
    caiProfile = cai.profile;
    caiCost = cai.costUsd;
    caiSchemaValid = cai.schemaValid;

    requirements = profileToRequirements(cai.profile, fast, historyChars, prompt, attachments);
  }

  // Explicit model preference still respects mandatory controls: it changes
  // which model runs, never whether the risk controls apply.
  const highRisk = routeSource === "HIGH_RISK_POLICY" ||
    requirements.riskLevel === "critical";

  // ---- CAPABILITY FILTER -------------------------------------------------
  // The task requirements are expressed in dotAI's controlled vocabulary, then
  // matched against every model's capability profile. Models that cannot
  // satisfy the requirements - above all the output modality - are removed
  // before cost is considered at all.
  const derived = caiProfile ?? deriveRequirementProfile(requirements);
  const requirementProfile = input.outputOverride
    ? { ...derived, requiredOutputModalities: [input.outputOverride] as typeof derived.requiredOutputModalities }
    : derived;

  // --- MODEL INTELLIGENCE ------------------------------------------------
  // CAI has decided what the task needs; the index decides which models can
  // satisfy it. Capability filtering happens in the database over a bounded
  // candidate pool, not by loading the catalog into memory.
  const normalisedTask = normaliseTaskType(requirementProfile.taskType);
  let intelligencePool: Awaited<ReturnType<typeof modelIntelligenceService.candidatePool>> = [];
  try {
    const pool = await modelIntelligenceService.candidatePool(normalisedTask);
    intelligencePool = modelIntelligenceService.rank(pool, weightsFor(input.profile));
    emit?.({
      type: "status",
      stage: "intelligence",
      label: `${normalisedTask.replace(/_/g, " ").toLowerCase()} pool: ${pool.length} capable models`,
    });
  } catch (err) {
    console.error("[intelligence] pool lookup failed", err);
  }

  /*
   * Model selection no longer happens here.
   *
   * The chat path decides which model runs by capability matching against
   * the curated dataset (LIST A ⊆ LIST B). This orchestrator still classifies
   * the task and sets risk level and verification depth, which govern the
   * request — it no longer narrows to an "evaluated top N", because the
   * offline evaluator that produced one has been removed.
   */
  let qualifiedModels: import("@/lib/models/intelligence").QualifiedModel[] | undefined;
  let rejectedModels: { modelId: string; name: string; reason: string }[] = [];
  try {
    const filtered = await modelIntelligence.qualified(requirementProfile);
    qualifiedModels = filtered.qualified;

    rejectedModels = filtered.rejected.map((r) => ({
      modelId: r.model.openrouterModelId, name: r.model.name, reason: r.reason,
    }));
    emit?.({
      type: "status",
      stage: "capability",
      label: `Capability filter: ${filtered.qualified.length} qualified, ${filtered.rejected.length} rejected`,
    });
  } catch {
    // The intelligence database must never be able to break routing.
    qualifiedModels = undefined;
  }

  // ---- LEVEL 3: Model Scoring Engine ------------------------------------
  // Observed reliability, where enough samples exist, is what makes the next
  // routing decision better than the last one.
  const options = modelScoringEngine.score({
    requirements,
    settings,
    reliability: input.reliability,
    previousModelId: input.previousModelId,
    highRisk,
    qualifiedModels,
  });

  // ---- EXECUTABILITY VALIDATION -----------------------------------------
  // Capability compatibility is not enough. Every candidate is verified as
  // actually runnable before it can be shown as a recommendation.
  const execModality: ExecModality =
    requirementProfile.requiredOutputModalities.includes("IMAGE") ? "IMAGE"
    : requirementProfile.requiredOutputModalities.includes("VIDEO") ? "VIDEO"
    : requirementProfile.requiredOutputModalities.includes("AUDIO") ? "AUDIO"
    : requirementProfile.requiredOutputModalities.includes("EMBEDDING") ? "EMBEDDING"
    : "TEXT";

  // Validate a bounded pool rather than only the top three, so the cheapest
  // executable model can be found without probing the entire catalog.
  const POOL = 8;
  const byCost = [...options.all].sort((a, b) => a.estimatedCost - b.estimatedCost);
  const { valid: verifiedPool, rejected: execRejected } =
    await modelExecution.filterExecutable(byCost, execModality, POOL);

  // RECOMMENDED is the lowest-cost verified model; BEST the strongest.
  const valid = verifiedPool.length
    ? dedupeOptions([
        [...verifiedPool].sort((a, b) => a.estimatedCost - b.estimatedCost)[0],
        pickBest(verifiedPool),
        ...verifiedPool,
      ]).slice(0, 3)
    : [];

  emit?.({
    type: "status",
    stage: "executability",
    label: `Execution check: ${valid.length} verified, ${execRejected.length} rejected`,
  });

  // Only verified candidates become options. If fewer than three are
  // executable, dotAI shows fewer rather than inventing choices.
  // Annotate each option with the evidence behind it so the UI can explain
  // the choice rather than just naming a model.
  const annotate = (
    o: (typeof valid)[number],
    role: "RECOMMENDED" | "BEST" | "ALTERNATIVE",
  ) => {
    const status = (o.validation?.status ?? "UNKNOWN") as ExecutionStatus;
    const verified = isVerified(status);
    const why = [
      role === "RECOMMENDED"
        ? `Lowest-cost model meeting every requirement for this ${requirementProfile.taskType.replace(/_/g, " ")} task`
        : role === "BEST"
          ? "Highest expected success among verified candidates"
          : "Viable third option with a different cost/capability balance",
      `${Math.round(o.expectedSuccess * 100)}% expected success`,
      `${execModality.toLowerCase()} output supported`,
      verified
        ? "execution proven by a previous successful call"
        : "execution compatible per catalog metadata, not yet proven",
    ].join("; ");

    return {
      ...o,
      role,
      executionStatus: status,
      executionVerified: verified,
      whyThisModel: `${why}.`,
    };
  };

  const verifiedOptions = valid.length
    ? {
        recommendable: annotate(valid[0], "RECOMMENDED"),
        // The three slots must offer three real choices. When the cheapest
        // model is also the strongest, BEST becomes the strongest *other*
        // candidate rather than repeating the same row back to the user.
        best: annotate(pickDistinctBest(valid), "BEST"),
        alternative: (() => {
          const shown = new Set([valid[0].modelId, pickDistinctBest(valid).modelId]);
          const alt = valid.find((v) => !shown.has(v.modelId));
          return alt ? annotate(alt, "ALTERNATIVE") : null;
        })(),
        all: valid.map((v, i) =>
          annotate(v, i === 0 ? "RECOMMENDED" : "ALTERNATIVE")),
      }
    : options;

  const executabilityNote = verifiedPool.length === 0
    ? "No model could be verified as executable for this task."
    : valid.length < 3
      ? `Only ${valid.length} verified compatible model${valid.length === 1 ? " is" : "s are"} currently available.`
      : undefined;

  emit?.({ type: "status", stage: "options", label: "Model options ready" });

  // An explicit user choice is searched across the whole scored catalog, not
  // just the three shown, and is then verified in its own right. Silently
  // dropping the user's selection would be worse than telling them it failed.
  // No pinned model. A user preference shapes how cost is weighed among the
  // eligible models; it never names one, because a named model may not be
  // able to perform the query.
  const forcedId: string | null = null;
  let forced = forcedId ? options.all.find((o) => o.modelId === forcedId) : undefined;
  if (forced) {
    const check = await modelExecution.validateModel(forced.modelId, execModality);
    if (!check.executable) forced = undefined;
  }

  const recommended = forced ?? verifiedOptions.recommendable;

  const verificationDepth: VerificationDepth =
    highRisk || requirements.riskLevel === "high" ? "deep"
    : requirements.riskLevel === "medium" ? "standard"
    : settings.verification === "STRICT" ? "deep"
    : settings.verification === "STANDARD" ? "standard"
    : "light";

  const candidates: ModelCandidate[] = verifiedOptions.all.map((o) => ({
    modelId: o.modelId,
    name: o.name,
    estimatedCost: o.estimatedCost,
    expectedSuccess: o.expectedSuccess,
    costPerSuccess: Math.round((o.estimatedCost / Math.max(o.expectedSuccess, 0.01)) * 1e6) / 1e6,
  }));

  return {
    routeSource,
    caiUsed,
    caiSkippedReason,
    taskType: requirements.taskType,
    complexity: requirements.complexity,
    riskLevel: requirements.riskLevel,
    verificationDepth,
    recommendedEffort: requirements.recommendedEffort,
    requiredCapabilities: requirements.requiredCapabilities,
    modalities: requirements.modalities,
    confidence: requirements.confidence,
    rationale: forced
      ? `Manual selection. dotAI would have recommended ${verifiedOptions.recommendable.name}.`
      : requirements.rationale,
    recommendedModel: recommended.modelId,
    bestModel: verifiedOptions.best.modelId,
    alternativeModel: verifiedOptions.alternative?.modelId ?? null,
    estimatedCost: recommended.estimatedCost,
    options: verifiedOptions,
    verifiedCount: verifiedPool.length,
    executabilityNote,
    executionRejected: execRejected.slice(0, 10).map((r) => ({
      modelId: r.modelId, reason: r.failureReason ?? "UNKNOWN_ERROR", message: r.message,
    })),
    candidates,
    routingCostUsd: caiCost || requirements.caiCostUsd,
    taskType_normalised: normalisedTask,
    candidatePoolSize: intelligencePool.length,
    intelligence: intelligencePool.slice(0, 5).map((c) => ({
      modelId: c.modelId, provider: c.provider,
      overall: Math.round(c.scores.overall * 1000) / 1000,
      confidence: c.confidence, executionStatus: c.executionStatus,
      reasons: c.reasons,
    })),
    caiSchemaValid,
    requirementProfile,
    qualifiedCount: qualifiedModels?.length ?? options.all.length,
    rejectedModels,
    fastRouter: {
      confidence: fast.confidence,
      reason: fast.reason,
      routeType: fast.routeType,
    },
  };
}

/**
 * Adapts CAI's seven-field profile to the internal shape the cost scorer
 * works in. This is a mechanical mapping, not a second classification: every
 * capability decision has already been made by CAI.
 */
function profileToRequirements(
  profile: import("@/lib/capability/taxonomy").TaskRequirementProfile,
  fast: FastRouteResult,
  historyChars: number,
  prompt: string,
  attachments: AttachmentRef[],
): TaskRequirements {
  const levelToComplexity = { LOW: 0.2, MEDIUM: 0.55, HIGH: 0.85 } as const;
  const complexity = levelToComplexity[profile.instructionComplexity];

  const caps: import("@/types").Capability[] = ["text"];
  if (profile.requiredInputModalities.includes("IMAGE")) caps.push("vision");
  if (profile.reasoning === "HIGH") caps.push("reasoning");
  if (profile.contextHandling === "HIGH") caps.push("long_context");

  const estimatedInputTokens =
    Math.ceil(prompt.length / 4) + Math.ceil(historyChars / 4) +
    attachments.reduce((n, a) => n + (a.type === "image" ? 800 : Math.ceil((a.extractedText?.length ?? 0) / 4)), 0);
  const expectedOutputSize = Math.round(120 + complexity * 900);

  return {
    taskType: profile.taskType as import("@/types").TaskType,
    complexity,
    requiredCapabilities: [...new Set(caps)],
    modalities: profile.requiredInputModalities.map((m) =>
      m === "IMAGE" ? "image" : m === "AUDIO" ? "audio" : m === "FILE" ? "document" : "text",
    ) as import("@/types").Modality[],
    reasoningRequirement:
      profile.reasoning === "HIGH" ? "heavy" : profile.reasoning === "MEDIUM" ? "moderate" : "light",
    contextRequirement: estimatedInputTokens + expectedOutputSize,
    expectedOutputSize,
    estimatedInputTokens,
    riskLevel:
      profile.reliability === "HIGH" ? (fast.riskLevel === "critical" ? "critical" : "high")
      : profile.reliability === "MEDIUM" ? "medium" : "low",
    recommendedEffort:
      profile.effort === "HIGH" ? "high" : profile.effort === "MEDIUM" ? "medium" : "low",
    confidence: profile.confidence,
    rationale: `Understood as a ${profile.taskType.replace(/_/g, " ")} task requiring ${profile.reasoning.toLowerCase()} reasoning.`,
    source: "llm",
    caiCostUsd: 0,
  };
}

/**
 * Strongest candidate that is not already the recommendation. Falls back to
 * the overall strongest when only one candidate exists.
 */
function pickDistinctBest<T extends { modelId: string; expectedSuccess: number }>(
  valid: T[],
): T {
  const cheapest = valid[0];
  const others = valid.filter((v) => v.modelId !== cheapest.modelId);
  if (others.length === 0) return cheapest;
  return [...others].sort((a, b) => b.expectedSuccess - a.expectedSuccess)[0];
}

/** Strongest verified candidate, by expected success then capability. */
function pickBest<T extends { expectedSuccess: number }>(valid: T[]): T {
  return [...valid].sort((a, b) => b.expectedSuccess - a.expectedSuccess)[0];
}

/** A third verified option, distinct from the other two where one exists. */
function dedupeOptions<T extends { modelId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of items) {
    if (seen.has(i.modelId)) continue;
    seen.add(i.modelId);
    out.push(i);
  }
  return out;
}

function label(t: string): string {
  const s = t.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
