/**
 * Explicit capability vocabulary.
 *
 * The rule this exists to enforce: a category is not a capability. A model in
 * the IMAGE category might only *read* images. Eligibility is decided by these
 * values, never by the category label.
 */
export const CAPABILITIES = [
  "TEXT_INPUT", "TEXT_OUTPUT",
  "IMAGE_INPUT", "IMAGE_OUTPUT", "IMAGE_UNDERSTANDING", "IMAGE_GENERATION", "IMAGE_EDITING",
  "DOCUMENT_INPUT", "DOCUMENT_OUTPUT",
  "AUDIO_INPUT", "AUDIO_OUTPUT",
  "VIDEO_INPUT", "VIDEO_OUTPUT",
  "SPEECH_TO_TEXT", "TEXT_TO_SPEECH", "TRANSCRIPTION",
  "EMBEDDING", "RERANK",
  "TOOL_USE", "FUNCTION_CALLING", "STRUCTURED_OUTPUT",
  "LONG_CONTEXT", "REASONING",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_STATUSES = [
  "UNKNOWN", "SUPPORTED", "VERIFIED", "UNSUPPORTED", "FAILED",
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** Statuses a model may be a candidate under. FAILED and UNSUPPORTED are out. */
export const ELIGIBLE_STATUSES: CapabilityStatus[] = ["SUPPORTED", "VERIFIED"];

/**
 * The routing task families.
 *
 * Broad on purpose. A model is good *for a task*, so each of these needs its
 * own matrix and its own scores - which is exactly why the list must not grow
 * into dozens of narrow variants. Narrower intents (JSON, email, OCR,
 * creative writing) are capability tags and sub-intents, not routing tasks.
 */
export const TASK_TYPES = [
  // --- text and reasoning ---
  "GENERAL_CHAT", "REASONING", "CODING", "CODE_REVIEW",
  "LONG_CONTEXT_ANALYSIS", "SUMMARIZATION", "WRITING_EDITING",
  "RESEARCH_SYNTHESIS", "DATA_ANALYSIS", "STRUCTURED_EXTRACTION",
  "DOCUMENT_ANALYSIS", "FINANCE_ANALYSIS", "LEGAL_POLICY_ANALYSIS",
  "TRANSLATION", "CUSTOMER_SUPPORT", "AGENT_TOOL_USE",
  // --- multimodal ---
  "IMAGE_UNDERSTANDING", "IMAGE_GENERATION", "IMAGE_EDITING",
  "TRANSCRIPTION", "TEXT_TO_SPEECH",
  "VIDEO_UNDERSTANDING", "VIDEO_GENERATION",
  // --- retained sub-intents and infrastructure tasks -------------------
  // Not primary routing families. Kept because existing routing, CAI and
  // stored history reference them; excluded from the Model Intelligence
  // task picker via PRIMARY_TASKS below.
  "QUESTION_ANSWERING", "CLASSIFICATION", "EXTRACTION", "DOCUMENT_GENERATION",
  "AUDIO_GENERATION", "AUDIO_UNDERSTANDING", "EMBEDDING", "RERANK",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * The 23 families the Model Intelligence UI presents. The remainder stay
 * routable but are not offered as a matrix to browse, so the picker does not
 * ask a user to choose between "extraction" and "structured extraction".
 */
export const PRIMARY_TASKS: TaskType[] = [
  "GENERAL_CHAT", "REASONING", "CODING", "CODE_REVIEW",
  "LONG_CONTEXT_ANALYSIS", "SUMMARIZATION", "WRITING_EDITING",
  "RESEARCH_SYNTHESIS", "DATA_ANALYSIS", "STRUCTURED_EXTRACTION",
  "DOCUMENT_ANALYSIS", "FINANCE_ANALYSIS", "LEGAL_POLICY_ANALYSIS",
  "TRANSLATION", "CUSTOMER_SUPPORT", "AGENT_TOOL_USE",
  "IMAGE_UNDERSTANDING", "IMAGE_GENERATION", "IMAGE_EDITING",
  "TRANSCRIPTION", "TEXT_TO_SPEECH",
  "VIDEO_UNDERSTANDING", "VIDEO_GENERATION",
];

export const TASK_LABEL: Record<string, string> = {
  GENERAL_CHAT: "General Chat",
  REASONING: "Reasoning",
  CODING: "Coding",
  CODE_REVIEW: "Debugging & Code Review",
  LONG_CONTEXT_ANALYSIS: "Long-Context Analysis",
  SUMMARIZATION: "Summarization",
  WRITING_EDITING: "Writing & Editing",
  RESEARCH_SYNTHESIS: "Research & Synthesis",
  DATA_ANALYSIS: "Data Analysis",
  STRUCTURED_EXTRACTION: "Structured Extraction",
  DOCUMENT_ANALYSIS: "Document Analysis",
  FINANCE_ANALYSIS: "Finance Analysis",
  LEGAL_POLICY_ANALYSIS: "Legal & Policy Analysis",
  TRANSLATION: "Translation",
  CUSTOMER_SUPPORT: "Customer Support",
  AGENT_TOOL_USE: "Agent & Tool Use",
  IMAGE_UNDERSTANDING: "Image Understanding",
  IMAGE_GENERATION: "Image Generation",
  IMAGE_EDITING: "Image Editing",
  TRANSCRIPTION: "Speech-to-Text",
  TEXT_TO_SPEECH: "Text-to-Speech",
  VIDEO_UNDERSTANDING: "Video Understanding",
  VIDEO_GENERATION: "Video Generation",
};

export function taskLabel(task: string): string {
  return TASK_LABEL[task]
    ?? task.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/**
 * The hard requirements for each task. A model must hold every capability
 * listed here before any scoring happens.
 */
export const TASK_REQUIREMENTS: Record<TaskType, Capability[]> = {
  GENERAL_CHAT: ["TEXT_INPUT", "TEXT_OUTPUT"],
  QUESTION_ANSWERING: ["TEXT_INPUT", "TEXT_OUTPUT"],
  SUMMARIZATION: ["TEXT_INPUT", "TEXT_OUTPUT"],
  CLASSIFICATION: ["TEXT_INPUT", "TEXT_OUTPUT"],
  EXTRACTION: ["TEXT_INPUT", "TEXT_OUTPUT"],
  TRANSLATION: ["TEXT_INPUT", "TEXT_OUTPUT"],
  CODING: ["TEXT_INPUT", "TEXT_OUTPUT"],
  CODE_REVIEW: ["TEXT_INPUT", "TEXT_OUTPUT"],
  WRITING_EDITING: ["TEXT_INPUT", "TEXT_OUTPUT"],
  RESEARCH_SYNTHESIS: ["TEXT_INPUT", "TEXT_OUTPUT"],
  DATA_ANALYSIS: ["TEXT_INPUT", "TEXT_OUTPUT"],
  FINANCE_ANALYSIS: ["TEXT_INPUT", "TEXT_OUTPUT"],
  LEGAL_POLICY_ANALYSIS: ["TEXT_INPUT", "TEXT_OUTPUT"],
  CUSTOMER_SUPPORT: ["TEXT_INPUT", "TEXT_OUTPUT"],
  // Returning a required shape is the task, so structured output is a hard
  // requirement rather than a preference that can be scored away.
  STRUCTURED_EXTRACTION: ["TEXT_INPUT", "TEXT_OUTPUT", "STRUCTURED_OUTPUT"],
  // Calling a tool is the task; a model without tool parameters cannot do it.
  AGENT_TOOL_USE: ["TEXT_INPUT", "TEXT_OUTPUT", "TOOL_USE"],
  // Reasoning is a text task, not a parameter. Requiring the REASONING
  // capability as a hard gate contradicted the derivation below, which
  // explicitly records "absence of a reasoning control is not evidence of no
  // reasoning" and therefore stores UNKNOWN - a status that is not eligible.
  // The result was an empty candidate pool and a Reasoning task that could
  // never be evaluated. How well a model reasons is what the evaluator
  // scores; whether it can attempt the task is decided here.
  REASONING: ["TEXT_INPUT", "TEXT_OUTPUT"],
  LONG_CONTEXT_ANALYSIS: ["TEXT_INPUT", "TEXT_OUTPUT", "LONG_CONTEXT"],
  DOCUMENT_ANALYSIS: ["TEXT_INPUT", "TEXT_OUTPUT"],
  // A document is rendered from governed text, so this needs a text model.
  DOCUMENT_GENERATION: ["TEXT_INPUT", "TEXT_OUTPUT"],
  IMAGE_GENERATION: ["TEXT_INPUT", "IMAGE_OUTPUT", "IMAGE_GENERATION"],
  IMAGE_EDITING: ["IMAGE_INPUT", "IMAGE_OUTPUT", "IMAGE_EDITING"],
  IMAGE_UNDERSTANDING: ["IMAGE_INPUT", "TEXT_OUTPUT", "IMAGE_UNDERSTANDING"],
  VIDEO_GENERATION: ["TEXT_INPUT", "VIDEO_OUTPUT"],
  VIDEO_UNDERSTANDING: ["VIDEO_INPUT", "TEXT_OUTPUT"],
  AUDIO_GENERATION: ["TEXT_INPUT", "AUDIO_OUTPUT"],
  AUDIO_UNDERSTANDING: ["AUDIO_INPUT", "TEXT_OUTPUT"],
  TRANSCRIPTION: ["AUDIO_INPUT", "TEXT_OUTPUT", "TRANSCRIPTION"],
  TEXT_TO_SPEECH: ["TEXT_INPUT", "AUDIO_OUTPUT", "TEXT_TO_SPEECH"],
  EMBEDDING: ["TEXT_INPUT", "EMBEDDING"],
  RERANK: ["TEXT_INPUT", "RERANK"],
};

/** Tasks dotAI can actually execute today. Others are catalogued only. */
export const EXECUTABLE_TASKS: TaskType[] = [
  "GENERAL_CHAT", "QUESTION_ANSWERING", "SUMMARIZATION", "CLASSIFICATION",
  "EXTRACTION", "TRANSLATION", "CODING", "CODE_REVIEW", "REASONING",
  "LONG_CONTEXT_ANALYSIS", "DOCUMENT_ANALYSIS", "DOCUMENT_GENERATION",
  "IMAGE_GENERATION", "IMAGE_UNDERSTANDING",
  "WRITING_EDITING", "RESEARCH_SYNTHESIS", "DATA_ANALYSIS",
  "STRUCTURED_EXTRACTION", "FINANCE_ANALYSIS", "LEGAL_POLICY_ANALYSIS",
  "CUSTOMER_SUPPORT", "AGENT_TOOL_USE",
];

export const CHAMPION_TYPES = [
  "QUALITY", "VALUE", "SPEED", "RELIABILITY", "DEFAULT",
] as const;
export type ChampionType = (typeof CHAMPION_TYPES)[number];

export const CONFIDENCE_THRESHOLDS = {
  medium: Number(process.env.CONFIDENCE_MEDIUM_SAMPLES ?? 5),
  high: Number(process.env.CONFIDENCE_HIGH_SAMPLES ?? 20),
};

export type Confidence = "LOW" | "MEDIUM" | "HIGH";

export function confidenceFor(sampleCount: number): Confidence {
  if (sampleCount >= CONFIDENCE_THRESHOLDS.high) return "HIGH";
  if (sampleCount >= CONFIDENCE_THRESHOLDS.medium) return "MEDIUM";
  return "LOW";
}

/**
 * Derives capabilities from provider metadata.
 *
 * Only what the metadata actually supports is claimed. Everything else stays
 * UNKNOWN rather than being guessed - and UNKNOWN on one capability never
 * affects another.
 */
export function deriveCapabilities(input: {
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  contextLength: number;
}): { capability: Capability; status: CapabilityStatus; detail: string }[] {
  const inputs = input.inputModalities.map((m) => m.toUpperCase());
  const outputs = input.outputModalities.map((m) => m.toUpperCase());
  const params = input.supportedParameters.map((p) => p.toLowerCase());
  const out: { capability: Capability; status: CapabilityStatus; detail: string }[] = [];

  const add = (capability: Capability, status: CapabilityStatus, detail: string) =>
    out.push({ capability, status, detail });

  // --- modality facts, straight from the provider ------------------------
  if (inputs.includes("TEXT")) add("TEXT_INPUT", "SUPPORTED", "Provider lists text input.");
  if (outputs.includes("TEXT")) add("TEXT_OUTPUT", "SUPPORTED", "Provider lists text output.");
  if (inputs.includes("IMAGE")) add("IMAGE_INPUT", "SUPPORTED", "Provider lists image input.");
  if (outputs.includes("IMAGE")) add("IMAGE_OUTPUT", "SUPPORTED", "Provider lists image output.");
  if (inputs.includes("AUDIO")) add("AUDIO_INPUT", "SUPPORTED", "Provider lists audio input.");
  if (outputs.includes("AUDIO")) add("AUDIO_OUTPUT", "SUPPORTED", "Provider lists audio output.");
  if (inputs.includes("VIDEO")) add("VIDEO_INPUT", "SUPPORTED", "Provider lists video input.");
  if (outputs.includes("VIDEO")) add("VIDEO_OUTPUT", "SUPPORTED", "Provider lists video output.");
  if (inputs.includes("FILE")) add("DOCUMENT_INPUT", "SUPPORTED", "Provider accepts files.");
  if (outputs.includes("EMBEDDING")) add("EMBEDDING", "SUPPORTED", "Embedding model.");
  if (outputs.includes("RERANK")) add("RERANK", "SUPPORTED", "Rerank model.");

  // --- derived operations, from the modality PAIR ------------------------
  // This is the distinction the old category check collapsed: emitting an
  // image is generation; reading one and answering is understanding.
  if (inputs.includes("TEXT") && outputs.includes("IMAGE")) {
    add("IMAGE_GENERATION", "SUPPORTED", "Text in, image out.");
  }
  if (inputs.includes("IMAGE") && outputs.includes("IMAGE")) {
    add("IMAGE_EDITING", "SUPPORTED", "Image in, image out.");
  }
  if (inputs.includes("IMAGE") && outputs.includes("TEXT")) {
    add("IMAGE_UNDERSTANDING", "SUPPORTED", "Image in, text out.");
  }
  if (inputs.includes("AUDIO") && outputs.includes("TEXT")) {
    add("SPEECH_TO_TEXT", "SUPPORTED", "Audio in, text out.");
    add("TRANSCRIPTION", "SUPPORTED", "Audio in, text out.");
  }
  if (inputs.includes("TEXT") && outputs.includes("AUDIO")) {
    add("TEXT_TO_SPEECH", "SUPPORTED", "Text in, audio out.");
  }
  // Any text model can produce the text a document is rendered from.
  if (inputs.includes("TEXT") && outputs.includes("TEXT")) {
    add("DOCUMENT_OUTPUT", "SUPPORTED", "Text output can be rendered to a document.");
  }

  // --- parameter-derived capabilities ------------------------------------
  if (params.includes("tools") || params.includes("tool_choice")) {
    add("TOOL_USE", "SUPPORTED", "Provider exposes tool parameters.");
    add("FUNCTION_CALLING", "SUPPORTED", "Provider exposes tool parameters.");
  }
  if (params.includes("response_format") || params.includes("structured_outputs")) {
    add("STRUCTURED_OUTPUT", "SUPPORTED", "Provider exposes structured output.");
  }
  if (params.includes("reasoning") || params.includes("include_reasoning") ||
      params.includes("reasoning_effort")) {
    add("REASONING", "SUPPORTED", "Provider exposes reasoning controls.");
  } else if (outputs.includes("TEXT")) {
    // Absence of a reasoning control is not evidence of no reasoning.
    add("REASONING", "UNKNOWN", "No reasoning controls reported; ability unknown.");
  }

  if (input.contextLength >= 100_000) {
    add("LONG_CONTEXT", "SUPPORTED", `${input.contextLength} token window.`);
  } else if (input.contextLength > 0) {
    add("LONG_CONTEXT", "UNSUPPORTED", `${input.contextLength} token window is short.`);
  } else {
    // Missing context metadata is unknown, not a failure - and it must not
    // disqualify an image model that has no context window to report.
    add("LONG_CONTEXT", "UNKNOWN", "Provider reports no context length.");
  }

  return out;
}

/** Maps the router's internal task names onto the normalised taxonomy. */
export function normaliseTaskType(raw: string): TaskType {
  const map: Record<string, TaskType> = {
    conversation: "GENERAL_CHAT",
    summarization: "SUMMARIZATION",
    extraction: "EXTRACTION",
    classification: "CLASSIFICATION",
    translation: "TRANSLATION",
    formatting: "GENERAL_CHAT",
    coding: "CODING",
    reasoning: "REASONING",
    complex_reasoning: "REASONING",
    data_analysis: "DATA_ANALYSIS",
    writing: "WRITING_EDITING",
    research: "RESEARCH_SYNTHESIS",
    finance: "FINANCE_ANALYSIS",
    legal: "LEGAL_POLICY_ANALYSIS",
    support: "CUSTOMER_SUPPORT",
    image_analysis: "IMAGE_UNDERSTANDING",
    document_analysis: "DOCUMENT_ANALYSIS",
    image_generation: "IMAGE_GENERATION",
    image_editing: "IMAGE_EDITING",
    tool_execution: "AGENT_TOOL_USE",
  };
  const key = raw.toLowerCase();
  if (map[key]) return map[key];
  const upper = raw.toUpperCase() as TaskType;
  return TASK_TYPES.includes(upper) ? upper : "GENERAL_CHAT";
}
