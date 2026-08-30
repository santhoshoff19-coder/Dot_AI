import type { RoutingDecision } from "@/lib/intelligence/curated-routing";
import type {
  Capability, Effort, Modality, RiskLevel, TaskType, VerificationDepth,
} from "@/types";
import type {
  ModelOption, ModelOptions, RoutingResult,
} from "@/lib/routing/route-types";

/**
 * The routing result, derived from CAI alone.
 *
 * There is one classifier. The fast router and the CAI-plus-catalog
 * orchestrator both used to classify queries and pick models, and their
 * answers disagreed: the router bucketed almost every text prompt as
 * "conversation" while CAI correctly identified Coding, Reasoning & Analysis
 * and the rest. Two classifiers meant two answers, and whichever the UI read
 * was the one the user saw.
 *
 * This module builds the same `RoutingResult` shape every downstream consumer
 * already expects, populated entirely from CAI's analysis and the curated
 * dataset. Nothing here re-classifies; it translates.
 */

/**
 * Risk, derived from what the query actually asks for.
 *
 * Previously taken from the fast router's own reading of the prompt. Reusing
 * CAI's requirement bar keeps a single source: a query demanding high
 * capability is a query where being wrong costs more.
 */
export function riskFromAnalysis(decision: RoutingDecision): RiskLevel {
  const bar = decision.analysis.requiredIntelligence;
  const output = decision.analysis.output.toUpperCase();

  // Producing an artefact - an image, a document - is consequential in a way
  // that answering in prose is not: it leaves something behind.
  if (output === "IMAGE" || output === "DOCUMENT") {
    return bar >= 75 ? "high" : "medium";
  }
  if (bar >= 80) return "high";
  if (bar >= 60) return "medium";
  return "low";
}

/**
 * Verification depth, from the same signal.
 *
 * A trivial request has nothing to verify, and running the deep path on it
 * spends latency and tokens for no gain. The governance profile raises this
 * floor separately; it is never lowered here.
 */
export function depthFromAnalysis(decision: RoutingDecision): VerificationDepth {
  const bar = decision.analysis.requiredIntelligence;
  if (bar >= 78) return "deep";
  if (bar >= 55) return "standard";
  return "light";
}

/** Effort, on the same scale. */
export function effortFromAnalysis(decision: RoutingDecision): Effort {
  const bar = decision.analysis.requiredIntelligence;
  return bar >= 78 ? "high" : bar >= 55 ? "medium" : "low";
}

/** CAI's forms in the generation router's vocabulary. */
type GenModality = "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "EMBEDDING" | "RERANK";

function toGenModality(v: string): GenModality {
  const key = v.trim().toUpperCase().replace(/\s+/g, "_");
  if (key === "IMAGE") return "IMAGE";
  if (key === "VECTOR") return "EMBEDDING";
  // Documents and structured data are produced from text and rendered by
  // dotAI, so the model's own output form is text.
  return "TEXT";
}

export function inputModality(decision: RoutingDecision): GenModality {
  return toGenModality(decision.analysis.input);
}

export function outputModality(decision: RoutingDecision): GenModality {
  return toGenModality(decision.analysis.output);
}

/** Modalities CAI determined, in the vocabulary the routing types use. */
function modalitiesOf(decision: RoutingDecision): Modality[] {
  const map: Record<string, Modality> = {
    TEXT: "text", IMAGE: "image", DOCUMENT: "document",
    STRUCTURED_DATA: "text", VECTOR: "text",
  };
  const norm = (v: string): Modality =>
    map[v.trim().toUpperCase().replace(/\s+/g, "_")] ?? "text";
  return [...new Set([norm(decision.analysis.input), norm(decision.analysis.output)])];
}

/**
 * The three cards.
 *
 * Names and ids come from the curated dataset, so the model a user reads is
 * the model that runs. The trade-off wording is descriptive only - it never
 * identifies a particular model.
 */
export function optionsFromDecision(decision: RoutingDecision): ModelOptions {
  const toOption = (
    m: NonNullable<RoutingDecision["recommended"]>,
    role: "RECOMMENDED" | "BEST" | "ALTERNATIVE",
    rationale: string,
  ): ModelOption => ({
    modelId: m.openrouterId,
    name: m.name,
    provider: m.company,
    estimatedCost: m.blendedCost,
    expectedSuccess: Math.max(0, Math.min(1, m.intelligence / 100)),
    latencyClass: "balanced",
    score: m.intelligence / 100,
    fit: m.intelligence >= 85 ? "high" : m.intelligence >= 65 ? "medium" : "low",
    rationale,
    role,
    capabilityChecks: decision.analysis.listA.map((id, i) => ({
      label: decision.analysis.listANames[i] ?? id,
      required: "verified capability",
      actual: m.listB.includes(id) ? "verified" : "missing",
      passed: m.listB.includes(id),
    })),
  });

  const n = decision.analysis.listA.length;

  const recommended = decision.recommended
    ? toOption(decision.recommended, "RECOMMENDED",
        `Lowest-cost model verified for all ${n} capability/capabilities this query needs.`)
    : null;

  const alternative = decision.alternative
    ? toOption(decision.alternative, "ALTERNATIVE",
        `More capable than the recommended model (${decision.alternative.intelligence} vs `
        + `${decision.recommended?.intelligence}), and still verified for all ${n}.`)
    : null;

  const best = decision.best
    ? toOption(decision.best, "BEST",
        `The strongest step up again (${decision.best.intelligence}), verified for all ${n}.`)
    : null;

  // Only tiers that a model actually fills. A duplicated or invented card
  // would say more than the data supports.
  const all = [recommended, alternative, best]
    .filter((o): o is ModelOption => o !== null)
    .filter((o, i, a) => a.findIndex((x) => x.modelId === o.modelId) === i);

  const primary = recommended ?? all[0] ?? null;

  return {
    recommendable: primary as ModelOption,
    best: (best ?? alternative ?? primary) as ModelOption,
    alternative,
    all,
  };
}

/**
 * Builds the routing result for a request from CAI's decision.
 *
 * `taskType` keeps a coarse value because governance code switches on it, but
 * it is derived from CAI's sub-task rather than from a second classifier, and
 * `subTaskLabel` carries the classification the user is shown.
 */
export function routingFromDecision(
  decision: RoutingDecision, caiCostUsd: number,
): RoutingResult {
  const options = optionsFromDecision(decision);
  const recommendedModel = decision.recommended?.openrouterId ?? "";

  // A coarse bucket for the governance code that switches on it. Derived from
  // CAI's sub-task, never re-classified.
  const sub = decision.analysis.subTaskId;
  const taskType: TaskType = ((): TaskType => {
    const map: Record<string, TaskType> = {
      ST01: "conversation", ST02: "complex_reasoning", ST03: "coding",
      ST04: "summarization", ST05: "image_generation", ST06: "image_analysis",
      ST07: "image_generation", ST08: "document_analysis", ST09: "summarization",
      ST10: "document_analysis", ST11: "data_analysis", ST12: "data_analysis",
      ST13: "data_analysis", ST14: "extraction", ST15: "extraction",
      ST16: "extraction",
    };
    // Only ever a fallback for an unmapped sub-task id, never the normal
    // result: `subTaskLabel` below carries CAI's actual classification.
    return map[sub] ?? "conversation";
  })();

  // The coarse capability vocabulary the routing types use. The precise
  // requirement is LIST A, which the options above check model by model.
  const requiredCapabilities: Capability[] = (() => {
    const out: Capability[] = ["text"];
    const io = `${decision.analysis.input} ${decision.analysis.output}`.toUpperCase();
    if (io.includes("IMAGE")) out.push("vision");
    if (decision.analysis.subTaskName.toLowerCase().includes("coding")) out.push("coding");
    if (decision.analysis.requiredIntelligence >= 75) out.push("reasoning");
    return out;
  })();

  return {
    // One classifier, and it names itself.
    routeSource: "CAI",
    caiUsed: decision.analysis.source === "CAI",
    caiSkippedReason: decision.analysis.source === "CAI"
      ? undefined
      : "CAI was unreachable; the query was matched against the taxonomy by wording.",
    taskType,
    subTaskLabel: decision.analysis.subTaskName,
    complexity: decision.analysis.requiredIntelligence / 100,
    riskLevel: riskFromAnalysis(decision),
    verificationDepth: depthFromAnalysis(decision),
    recommendedEffort: effortFromAnalysis(decision),
    requiredCapabilities,
    modalities: modalitiesOf(decision),
    confidence: decision.analysis.source === "CAI" ? 0.9 : 0.5,
    rationale: decision.analysis.reason,
    recommendedModel,
    bestModel: decision.best?.openrouterId ?? recommendedModel,
    alternativeModel: decision.alternative?.openrouterId ?? null,
    estimatedCost: decision.recommended?.blendedCost ?? 0,
    options,
    candidates: [],
    routingCostUsd: caiCostUsd,
    // The generation router reads this to decide which method runs, so it
    // must reflect CAI's output form. Dropping it sent every image request
    // down the text path.
    requirementProfile: {
      taskType: decision.analysis.subTaskId,
      requiredInputModalities: [inputModality(decision)],
      requiredOutputModalities: [outputModality(decision)],
      requiredCapabilities,
      minContextTokens: 0,
    } as unknown as RoutingResult["requirementProfile"],
    qualifiedCount: decision.eligible.length,
    caiSchemaValid: decision.analysis.source === "CAI",
    candidatePoolSize: decision.eligible.length + decision.rejected.length,
    rejectedModels: decision.rejected.slice(0, 20).map((r) => ({
      modelId: r.modelId, name: r.name,
      reason: `Missing: ${r.missing.join(", ")}`,
    })),
    // Retained for shape compatibility. No fast router runs.
    fastRouter: {
      confidence: 0,
      reason: "Not used: CAI is the only classifier.",
      routeType: "CAI",
    },
  } as RoutingResult;
}
