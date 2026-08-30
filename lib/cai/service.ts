import { modelRegistry } from "@/lib/models/registry";
import { getProvider, isMockMode } from "@/lib/providers";
import { routingConfig } from "@/lib/routing/routing-config";
import { detectOutputIntent } from "@/lib/routing/modality-intent";
import {
  TaskRequirementProfileSchema, type Level, type ModalityKind,
  type OutputCapability, type TaskRequirementProfile, type ToolCapability,
} from "@/lib/capability/taxonomy";
import type { AttachmentRef, RiskLevel, TaskType, UserSettings } from "@/types";

export interface CAIRequest {
  prompt: string;
  attachments?: AttachmentRef[];
  historyChars?: number;
  settings?: Partial<UserSettings>;
  hint?: {
    taskType?: TaskType;
    complexity?: number;
    riskLevel?: RiskLevel;
  };
}

export interface CAIResult {
  profile: TaskRequirementProfile;
  source: "heuristic" | "llm";
  model?: string;
  costUsd: number;
  latencyMs: number;
  attempts: number;
  schemaValid: boolean;
  /** Set when the model produced something the schema rejected. */
  validationError?: string;
}

const TASK_TYPES = [
  "conversation", "summarization", "extraction", "classification", "translation",
  "formatting", "writing", "coding", "reasoning", "complex_reasoning",
  "data_analysis", "image_analysis", "document_analysis", "image_generation",
  "tool_execution",
] as const;

/**
 * The contract given to the CAI model. It classifies only: it must never
 * answer the user, and it must never return prose or reasoning.
 */
export const CAI_SYSTEM_PROMPT = `You classify a user request for a model-routing system.
You never answer the request. You never explain your reasoning.

Reply with ONLY a JSON object. No markdown fences, no commentary.

{
  "taskType": one of [${TASK_TYPES.join(", ")}],
  "effort": "LOW" | "MEDIUM" | "HIGH",
  "reasoning": "LOW" | "MEDIUM" | "HIGH",
  "contextHandling": "LOW" | "MEDIUM" | "HIGH",
  "instructionComplexity": "LOW" | "MEDIUM" | "HIGH",
  "reliability": "LOW" | "MEDIUM" | "HIGH",
  "toolCapability": "NONE" | "BASIC" | "ADVANCED",
  "requiredInputModalities": array of ["TEXT","IMAGE","AUDIO","VIDEO","FILE"],
  "requiredOutputModalities": array of ["TEXT","IMAGE","AUDIO","VIDEO","EMBEDDING","RERANK"],
  "confidence": number between 0 and 1
}

Rules:
- Use ONLY the values listed. Never invent values such as VERY_HIGH, EXTREME, MODERATE or MEDIUM_HIGH.
- requiredOutputModalities is what the user wants BACK. A request to create a picture is ["IMAGE"]. A question about an attached picture is ["TEXT"].
- reliability is how costly a wrong answer would be, not how confident you are.`;

const HIGH_RISK = ["refund", "payment", "transfer", "approve", "delete", "wire",
  "medical", "diagnosis", "legal", "hire", "fire", "loan", "credit", "acquisition"];
const FACTUAL = ["balance", "how many", "what is the", "when did", "who is",
  "price", "total", "amount", "according to", "account", "financial"];

/**
 * Task-type detection. CAI's deterministic path must be able to classify on
 * its own: it is the fallback whenever the model path fails, and relying on a
 * Fast Router hint that may not be present collapsed every simple task to
 * "conversation".
 */
const TASK_PATTERNS: [TaskType, RegExp][] = [
  ["coding", /\b(?:code|function|refactor|bug|typescript|python|sql|compile)\b/i],
  ["summarization", /\b(?:summari[sz]e|summary|tl;?dr|condense|key points)\b/i],
  ["translation", /\btranslat(?:e|ion)\b/i],
  ["extraction", /\b(?:extract|pull out|parse)\b|\blist the\b/i],
  ["classification", /\b(?:classify|categori[sz]e|sentiment)\b|\blabel this\b/i],
  ["formatting", /\b(?:reformat|proofread)\b|\bconvert (?:this )?(?:list )?to (?:json|csv|markdown|a table)\b|\bfix the (?:formatting|indentation)\b/i],
  ["writing", /\b(?:write|draft|compose)\b/i],
];

const estTokens = (chars: number) => Math.max(1, Math.ceil(chars / 4));
const band = (n: number): Level => (n >= 0.7 ? "HIGH" : n >= 0.35 ? "MEDIUM" : "LOW");

/**
 * CAIService — Level 2 intelligence.
 *
 * Produces the seven controlled fields directly. It does not rank models, does
 * not choose one, and does not write the answer.
 */
export class CAIService {
  /**
   * Deterministic classification. Free, always valid by construction, and the
   * fallback whenever the model path cannot be trusted.
   */
  classify(input: CAIRequest): TaskRequirementProfile {
    const { prompt, attachments = [], historyChars = 0, hint } = input;
    const text = prompt.toLowerCase();
    const words = prompt.trim().split(/\s+/).filter(Boolean).length;

    const hasImage = attachments.some((a) => a.type === "image");
    const hasDoc = attachments.some((a) => a.type === "document");
    const hasAudio = attachments.some((a) => a.type === "audio");

    // Same detector the router uses, so classification cannot diverge.
    const outputIntent = detectOutputIntent(prompt, {
      hasImageInput: hasImage, hasDocumentInput: hasDoc,
    });
    const wantsImage = outputIntent.output === "IMAGE";

    // Judgement language outranks a surface keyword: "summarize this and then
    // decide whether we should proceed" is reasoning work, not summarisation.
    const needsJudgement =
      /\b(?:analy[sz]e|assess|evaluate|inconsisten|second-order)\b/.test(text) ||
      /\b(?:should we|whether to|recommend whether|decide whether)\b/.test(text) ||
      /\bcompare\b[^.?!]{0,60}\b(?:assumption|option|scenario|proposal|statement)/.test(text) ||
      /\b(?:approve|authori[sz]e)\b[^.?!]{0,40}\b(?:payment|transfer|refund)\b/.test(text);

    let taskType: TaskType = "conversation";
    if (wantsImage) taskType = "image_generation";
    else if (needsJudgement) taskType = "complex_reasoning";
    else if (hasImage) taskType = "image_analysis";
    else {
      for (const [candidate, re] of TASK_PATTERNS) {
        if (re.test(prompt)) { taskType = candidate; break; }
      }
      if (taskType === "conversation" && hasDoc) taskType = "document_analysis";
      if (taskType === "conversation" && hint?.taskType) taskType = hint.taskType;
    }

    let complexity = Math.max(hint?.complexity ?? 0, Math.min(1, words / 200));
    if (taskType === "complex_reasoning") complexity = Math.max(complexity, 0.7);
    if (attachments.length > 1) complexity = Math.min(1, complexity + 0.1);
    if (hasDoc) complexity = Math.min(1, complexity + 0.1);
    if (wantsImage) complexity = Math.min(complexity, 0.4);

    const isFactual = FACTUAL.some((k) => text.includes(k)) || hasDoc;
    const isHighRisk = HIGH_RISK.some((k) => text.includes(k));
    const bigMoney = /\$\s?\d{1,3}(,\d{3})+|\$\s?\d{4,}/.test(prompt);

    let riskLevel: RiskLevel = hint?.riskLevel ?? "low";
    if (isHighRisk && bigMoney) riskLevel = "critical";
    else if (isHighRisk) riskLevel = maxRisk(riskLevel, "high");
    else if (isFactual) riskLevel = maxRisk(riskLevel, "medium");

    const contextTokens =
      estTokens(prompt.length) + estTokens(historyChars) +
      estTokens(attachments.reduce((n, a) => n + (a.extractedText?.length ?? 0), 0)) +
      (hasImage ? 800 : 0);

    const inputModalities: ModalityKind[] = ["TEXT"];
    if (hasImage) inputModalities.push("IMAGE");
    if (hasDoc) inputModalities.push("FILE");
    if (hasAudio) inputModalities.push("AUDIO");

    const outputModalities: OutputCapability[] = wantsImage ? ["IMAGE"] : ["TEXT"];

    const toolCapability: ToolCapability = taskType === "tool_execution" ? "BASIC" : "NONE";

    return {
      taskType,
      effort: complexity < 0.3 ? "LOW" : complexity > 0.7 || riskLevel === "critical" ? "HIGH" : "MEDIUM",
      reasoning: band(complexity),
      contextHandling: contextTokens > 60_000 ? "HIGH" : contextTokens > 8_000 ? "MEDIUM" : "LOW",
      instructionComplexity: band(complexity),
      reliability:
        riskLevel === "critical" || riskLevel === "high" ? "HIGH"
        : riskLevel === "medium" ? "MEDIUM" : "LOW",
      toolCapability,
      requiredInputModalities: [...new Set(inputModalities)],
      requiredOutputModalities: outputModalities,
      confidence: 0.82,
    };
  }

  /**
   * Legacy-shaped classification used by the DIRECT and HIGH_RISK_POLICY
   * paths, which never call a model. Returns the internal requirements shape
   * the cost scorer consumes.
   */
  classifyLegacy(input: CAIRequest): import("@/lib/routing/route-types").TaskRequirements {
    const p = this.classify(input);
    const levelToComplexity = { LOW: 0.2, MEDIUM: 0.55, HIGH: 0.85 } as const;
    const complexity = levelToComplexity[p.instructionComplexity];
    const caps: import("@/types").Capability[] = ["text"];
    if (p.requiredInputModalities.includes("IMAGE")) caps.push("vision");
    if (p.reasoning === "HIGH") caps.push("reasoning");
    if (p.contextHandling === "HIGH") caps.push("long_context");

    const estimatedInputTokens =
      estTokens(input.prompt.length) + estTokens(input.historyChars ?? 0) +
      (input.attachments ?? []).reduce(
        (n, a) => n + (a.type === "image" ? 800 : estTokens(a.extractedText?.length ?? 0)), 0);
    const expectedOutputSize = Math.round(120 + complexity * 900);

    return {
      taskType: p.taskType as import("@/types").TaskType,
      complexity,
      requiredCapabilities: [...new Set(caps)],
      modalities: p.requiredInputModalities.map((m) =>
        m === "IMAGE" ? "image" : m === "AUDIO" ? "audio" : m === "FILE" ? "document" : "text",
      ) as import("@/types").Modality[],
      reasoningRequirement:
        p.reasoning === "HIGH" ? "heavy" : p.reasoning === "MEDIUM" ? "moderate" : "light",
      contextRequirement: estimatedInputTokens + expectedOutputSize,
      expectedOutputSize,
      estimatedInputTokens,
      riskLevel:
        p.reliability === "HIGH" ? "high" : p.reliability === "MEDIUM" ? "medium" : "low",
      recommendedEffort:
        p.effort === "HIGH" ? "high" : p.effort === "MEDIUM" ? "medium" : "low",
      confidence: p.confidence,
      rationale: `Understood as a ${p.taskType.replace(/_/g, " ")} task.`,
      source: "heuristic",
      caiCostUsd: 0,
    };
  }

  /**
   * Full understanding. Asks the configured CAI model in real mode, validating
   * strictly. One controlled retry, then the deterministic fallback — a
   * malformed classification never reaches model selection.
   */
  async understand(input: CAIRequest): Promise<CAIResult> {
    const started = Date.now();
    const fallback = this.classify(input);

    if (isMockMode()) {
      return {
        profile: fallback, source: "heuristic", costUsd: 0,
        latencyMs: Date.now() - started, attempts: 0, schemaValid: true,
      };
    }

    const modelId = routingConfig.CAI_MODEL;
    if (!modelRegistry.get(modelId)) {
      return {
        profile: fallback, source: "heuristic", costUsd: 0,
        latencyMs: Date.now() - started, attempts: 0, schemaValid: true,
      };
    }

    let cost = 0;
    let lastError = "";

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const provider = getProvider();
        const result = await provider.generate({
          prompt: this.buildPrompt(input, attempt === 2 ? lastError : undefined),
          modelId,
          effort: "low",
          attachments: [],
          history: [],
        });
        cost += result.cost;

        if (cost > routingConfig.CAI_MAX_COST_USD) {
          return {
            profile: fallback, source: "heuristic", model: modelId, costUsd: cost,
            latencyMs: Date.now() - started, attempts: attempt, schemaValid: false,
            validationError: "CAI cost budget exceeded.",
          };
        }

        const parsed = this.validate(result.text);
        if (parsed.ok) {
          return {
            profile: this.reconcile(parsed.value, fallback),
            source: "llm", model: modelId, costUsd: cost,
            latencyMs: Date.now() - started, attempts: attempt, schemaValid: true,
          };
        }
        lastError = parsed.error;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      profile: fallback, source: "heuristic", model: modelId, costUsd: cost,
      latencyMs: Date.now() - started, attempts: 2, schemaValid: false,
      validationError: lastError,
    };
  }

  private buildPrompt(input: CAIRequest, previousError?: string): string {
    const attachmentNote = (input.attachments ?? []).length
      ? `\n\nAttachments present: ${(input.attachments ?? [])
          .map((a) => a.type).join(", ")}`
      : "";
    const correction = previousError
      ? `\n\nYour previous reply was rejected: ${previousError}. Reply with valid JSON using only the permitted values.`
      : "";
    return `${CAI_SYSTEM_PROMPT}${correction}\n\nRequest to classify:\n"""${input.prompt.slice(0, 4000)}"""${attachmentNote}`;
  }

  /** Strict validation. Unknown values are rejected, never coerced. */
  validate(raw: string): { ok: true; value: TaskRequirementProfile } | { ok: false; error: string } {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return { ok: false, error: "No JSON object found in the reply." };
    }

    let json: unknown;
    try {
      json = JSON.parse(cleaned.slice(start, end + 1));
    } catch (err) {
      return { ok: false, error: `Malformed JSON: ${err instanceof Error ? err.message : "parse failed"}` };
    }

    const parsed = TaskRequirementProfileSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error: `Field '${issue?.path.join(".") ?? "?"}' is invalid: ${issue?.message ?? "unknown"}`,
      };
    }
    if (!TASK_TYPES.includes(parsed.data.taskType as (typeof TASK_TYPES)[number])) {
      return { ok: false, error: `Unknown taskType '${parsed.data.taskType}'.` };
    }
    return { ok: true, value: parsed.data };
  }

  /**
   * The model informs the profile but may never weaken a control: risk-derived
   * reliability can only be raised, never lowered, by a cheap classifier.
   */
  private reconcile(
    fromModel: TaskRequirementProfile,
    deterministic: TaskRequirementProfile,
  ): TaskRequirementProfile {
    const order: Level[] = ["LOW", "MEDIUM", "HIGH"];
    const strongest = (a: Level, b: Level) =>
      order.indexOf(a) >= order.indexOf(b) ? a : b;

    return {
      ...fromModel,
      reliability: strongest(fromModel.reliability, deterministic.reliability),
      // A deterministic image-generation detection is authoritative: getting
      // the output modality wrong sends the request down the wrong pipeline.
      requiredOutputModalities:
        deterministic.requiredOutputModalities.includes("IMAGE")
          ? deterministic.requiredOutputModalities
          : fromModel.requiredOutputModalities,
      requiredInputModalities: [
        ...new Set([...deterministic.requiredInputModalities, ...fromModel.requiredInputModalities]),
      ],
    };
  }
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ["low", "medium", "high", "critical"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

export const caiService = new CAIService();
