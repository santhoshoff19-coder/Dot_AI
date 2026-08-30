import { routingConfig } from "@/lib/routing/routing-config";
import { detectOutputIntent } from "@/lib/routing/modality-intent";
import type { FastRouteResult } from "@/lib/routing/route-types";
import type { AttachmentRef, Capability, Modality, RiskLevel, TaskType } from "@/types";

export interface FastRouterInput {
  prompt: string;
  attachments?: AttachmentRef[];
  historyChars?: number;
}

/**
 * Patterns for tasks that are unambiguous on sight. Each carries the
 * confidence we are willing to claim for a bare pattern match.
 */
const OBVIOUS: {
  taskType: TaskType;
  patterns: RegExp[];
  confidence: number;
  capabilities: Capability[];
  modelClass: "small" | "mid" | "large";
}[] = [
  {
    taskType: "translation",
    patterns: [
      /\btranslate\b/i,
      /\bin (?:french|spanish|german|hindi|tamil|japanese|chinese|arabic|portuguese|italian)\b.*\bplease\b/i,
      /\btranslation of\b/i,
    ],
    confidence: 0.96,
    capabilities: ["text"],
    modelClass: "small",
  },
  {
    taskType: "summarization",
    patterns: [/\bsummar(?:ise|ize|y)\b/i, /\btl;?dr\b/i, /\bkey points\b/i, /\bcondense\b/i],
    confidence: 0.94,
    capabilities: ["text"],
    modelClass: "small",
  },
  {
    taskType: "extraction",
    patterns: [/\bextract\b/i, /\bpull out\b/i, /\blist the (?:fields|names|dates|items)\b/i],
    confidence: 0.92,
    capabilities: ["text"],
    modelClass: "small",
  },
  {
    taskType: "classification",
    patterns: [/\bclassify\b/i, /\bcategori[sz]e\b/i, /\blabel this\b/i, /\bsentiment\b/i],
    confidence: 0.93,
    capabilities: ["text"],
    modelClass: "small",
  },
  {
    taskType: "formatting",
    patterns: [
      /\b(?:reformat|format) (?:this|it|the)\b/i,
      /\bconvert (?:this )?to (?:json|csv|markdown|a table)\b/i,
      /\bfix the (?:formatting|indentation)\b/i,
      /\bproofread\b/i,
    ],
    confidence: 0.93,
    capabilities: ["text"],
    modelClass: "small",
  },
];

/** Straightforward "what is in this picture" requests. */
const SIMPLE_IMAGE = [
  /\b(?:describe|what(?:'s| is) in|caption|identify)\b.*\b(?:image|picture|photo|screenshot)\b/i,
  /\bdescribe this\b/i,
  /\bwhat does this show\b/i,
];

/** Obvious high-risk work. Recognising this needs no LLM. */
const HIGH_RISK: { patterns: RegExp[]; taskType: TaskType }[] = [
  {
    taskType: "tool_execution",
    patterns: [
      /\b(?:approve|authori[sz]e|release|process)\b[^.?!]{0,40}\b(?:payment|transfer|invoice|wire|disbursement)\b/i,
      /\b(?:issue|process)\b[^.?!]{0,20}\brefund\b/i,
      /\bwire\b[^.?!]{0,20}\b(?:funds|money)\b/i,
      /\bsend\b[^.?!]{0,40}\b(?:account number|statement|ssn|credentials)\b/i,
      /\b(?:delete|terminate|revoke)\b[^.?!]{0,25}\b(?:account|access|records?)\b/i,
    ],
  },
];

/** Signals that the request is genuinely ambiguous and needs CAI. */
const AMBIGUITY_SIGNALS: { re: RegExp; label: string }[] = [
  { re: /\band then\b|\bafter that\b/i, label: "chained instructions" },
  { re: /\b(?:analy[sz]e|assess|evaluate|review)\b[^.?!]{0,60}\b(?:and|then)\b[^.?!]{0,60}\b(?:recommend|decide|advise|propose|conclude)\b/i, label: "analysis plus recommendation" },
  { re: /\bcompare\b[^.?!]{0,60}\b(?:assumptions?|scenarios?|options?|proposals?)\b/i, label: "comparative analysis" },
  { re: /\bwhy\b[^.?!]{0,40}\b(?:caused|happened|failed|defect)\b/i, label: "causal diagnosis" },
  { re: /\bstrateg(?:y|ic)\b/i, label: "strategic judgement" },
  { re: /\bshould we\b|\bwhether to\b/i, label: "decision support" },
  { re: /\btrade[- ]off\b/i, label: "trade-off reasoning" },
];

const FACTUAL = ["balance", "how many", "what is the", "when did", "who is",
  "price", "total", "amount", "according to", "account"];

const estTokens = (chars: number) => Math.max(1, Math.ceil(chars / 4));

function detectModalities(attachments: AttachmentRef[]): Modality[] {
  const mods = new Set<Modality>(["text"]);
  for (const a of attachments) {
    if (a.type === "image") mods.add("image");
    else if (a.type === "audio") mods.add("audio");
    else if (a.type === "document") mods.add("document");
  }
  return [...mods];
}

/**
 * FastRouter — Level 1 intelligence.
 *
 * Deterministic and free. It answers one question: do we already know enough
 * to route this, or must we pay CAI to understand it?
 */
export class FastRouter {
  route(input: FastRouterInput): FastRouteResult {
    const { prompt, attachments = [], historyChars = 0 } = input;
    const text = prompt.trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    const modality = detectModalities(attachments);

    const hasImage = modality.includes("image");
    const hasDoc = modality.includes("document");
    const hasAudio = modality.includes("audio");

    // ---- 1. Obvious high-risk work --------------------------------------
    for (const group of HIGH_RISK) {
      if (group.patterns.some((p) => p.test(text))) {
        const money = text.match(/\$\s?([\d,]+(?:\.\d+)?)/);
        const valueUsd = money ? Number(money[1].replace(/,/g, "")) : 0;
        const riskLevel: RiskLevel = valueUsd >= 1000 || /account number|ssn|credentials/i.test(text)
          ? "critical" : "high";

        return {
          routeType: "DIRECT",
          taskType: group.taskType,
          modality,
          complexity: Math.min(1, 0.5 + words / 400),
          riskLevel,
          confidence: 0.95,
          reason: "Recognised as a consequential action from explicit intent and value.",
          highRisk: true,
          directRoute: {
            taskType: group.taskType,
            requiredCapabilities: ["text", "reasoning"],
            recommendedModelClass: "large",
            recommendedEffort: "high",
          },
        };
      }
    }

    // ---- 2. Ambiguity signals -> CAI ------------------------------------
    const ambiguities = AMBIGUITY_SIGNALS.filter((s) => s.re.test(text)).map((s) => s.label);
    const multiModal = modality.length > 2 || (hasImage && hasDoc) || hasAudio;
    const manyAttachments = attachments.length > 1;
    const longPrompt = words > 120;

    // ---- 3. Image generation (output modality differs from every other
    //         task, so it must be recognised before anything else) ---------
    const outputIntent = detectOutputIntent(text, {
      hasImageInput: hasImage, hasDocumentInput: hasDoc,
    });
    if (outputIntent.output === "IMAGE") {
      return {
        routeType: "DIRECT",
        taskType: "image_generation",
        modality,
        complexity: 0.3,
        riskLevel: "low",
        confidence: 0.93,
        reason: `Recognised as an image request: ${outputIntent.reason}`,
        highRisk: false,
        directRoute: {
          taskType: "image_generation",
          requiredCapabilities: ["text"],
          recommendedModelClass: "mid",
          recommendedEffort: "medium",
        },
      };
    }

    // ---- 3b. Obvious simple tasks ---------------------------------------
    let matched: (typeof OBVIOUS)[number] | null = null;
    for (const o of OBVIOUS) {
      if (o.patterns.some((p) => p.test(text))) { matched = o; break; }
    }

    const simpleImage = hasImage && !hasDoc && SIMPLE_IMAGE.some((p) => p.test(text));

    if (simpleImage && ambiguities.length === 0 && !manyAttachments) {
      return {
        routeType: "DIRECT",
        taskType: "image_analysis",
        modality,
        complexity: 0.3,
        riskLevel: "low",
        confidence: 0.9,
        reason: "Straightforward image description with a single attachment.",
        highRisk: false,
        directRoute: {
          taskType: "image_analysis",
          requiredCapabilities: ["text", "vision"],
          recommendedModelClass: "small",
          recommendedEffort: "low",
        },
      };
    }

    if (matched) {
      // Start from the pattern's confidence, then discount for every signal
      // that the request is not as simple as the keyword suggests.
      let confidence = matched.confidence;
      const penalties: string[] = [];

      if (ambiguities.length) {
        confidence -= 0.2 * ambiguities.length;
        penalties.push(ambiguities.join(", "));
      }
      if (longPrompt) { confidence -= 0.12; penalties.push("long instruction"); }
      if (manyAttachments) { confidence -= 0.12; penalties.push("multiple attachments"); }
      if (multiModal) { confidence -= 0.15; penalties.push("multiple modalities"); }
      if (hasImage && !matched.capabilities.includes("vision")) {
        confidence -= 0.1; penalties.push("image with a text-shaped task");
      }

      confidence = Math.max(0, Math.min(0.99, confidence));

      const isFactual = FACTUAL.some((k) => text.toLowerCase().includes(k)) || hasDoc;
      const riskLevel: RiskLevel = isFactual ? "medium" : "low";
      const complexity = Math.min(1, words / 220 + (hasDoc ? 0.1 : 0));

      if (confidence >= routingConfig.FAST_ROUTE_MIN_CONFIDENCE) {
        const capabilities: Capability[] = [...matched.capabilities];
        if (hasImage) capabilities.push("vision");
        if (hasDoc) capabilities.push("long_context");

        return {
          routeType: "DIRECT",
          taskType: matched.taskType,
          modality,
          complexity,
          riskLevel,
          confidence,
          reason: `Recognised as ${matched.taskType.replace(/_/g, " ")} from an unambiguous instruction.`,
          highRisk: false,
          directRoute: {
            taskType: matched.taskType,
            requiredCapabilities: capabilities,
            recommendedModelClass: hasDoc || complexity > 0.5 ? "mid" : matched.modelClass,
            recommendedEffort: complexity > 0.5 ? "medium" : "low",
          },
        };
      }

      return {
        routeType: "CAI",
        taskType: matched.taskType,
        modality,
        complexity,
        riskLevel,
        confidence,
        reason: `Looks like ${matched.taskType.replace(/_/g, " ")} but ${penalties.join(", ")} makes direct routing unreliable.`,
        highRisk: false,
      };
    }

    // ---- 4. Nothing obvious matched -------------------------------------
    const reasons: string[] = [];
    if (ambiguities.length) reasons.push(ambiguities.join(", "));
    if (multiModal) reasons.push("multiple modalities");
    if (manyAttachments) reasons.push("multiple attachments");
    if (longPrompt) reasons.push("long instruction");

    // Very short conversational turns are safe to route directly.
    const conversational = words <= 12 && attachments.length === 0 &&
      ambiguities.length === 0 &&
      !FACTUAL.some((k) => text.toLowerCase().includes(k));

    if (conversational) {
      return {
        routeType: "DIRECT",
        taskType: "conversation",
        modality,
        complexity: Math.min(1, words / 220),
        riskLevel: "low",
        confidence: 0.92,
        reason: "Short conversational turn with no attachments or factual claims.",
        highRisk: false,
        directRoute: {
          taskType: "conversation",
          requiredCapabilities: ["text"],
          recommendedModelClass: "small",
          recommendedEffort: "low",
        },
      };
    }

    const complexity = Math.min(
      1,
      words / 220 + ambiguities.length * 0.2 + (multiModal ? 0.2 : 0) + (hasDoc ? 0.1 : 0),
    );
    const isFactual = FACTUAL.some((k) => text.toLowerCase().includes(k)) || hasDoc;

    // Confidence falls as the number of unresolved signals rises.
    const confidence = Math.max(
      0.25,
      0.72 - ambiguities.length * 0.12 - (multiModal ? 0.1 : 0) - (longPrompt ? 0.08 : 0),
    );

    return {
      routeType: "CAI",
      taskType: complexity > 0.55 ? "complex_reasoning" : "conversation",
      modality,
      complexity,
      riskLevel: isFactual ? "medium" : "low",
      confidence,
      reason: reasons.length
        ? `Request needs deeper understanding: ${reasons.join(", ")}.`
        : "No unambiguous task pattern matched.",
      highRisk: false,
    };
  }

  /** Rough input-token estimate, used before any model is chosen. */
  estimateInputTokens(input: FastRouterInput): number {
    const attachmentChars = (input.attachments ?? []).reduce(
      (n, a) => n + (a.extractedText?.length ?? 0), 0);
    const images = (input.attachments ?? []).filter((a) => a.type === "image").length;
    return estTokens(input.prompt.length) + estTokens(input.historyChars ?? 0) +
      estTokens(attachmentChars) + images * 800;
  }
}

export const fastRouter = new FastRouter();
