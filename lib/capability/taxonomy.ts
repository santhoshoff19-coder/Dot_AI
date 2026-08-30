import { z } from "zod";

/**
 * dotAI's controlled capability vocabulary.
 *
 * CAI may never invent values here. Every model capability profile and every
 * task requirement profile is expressed in exactly these terms, and everything
 * arriving from a model is validated against them before it is trusted.
 *
 * Expanding this taxonomy is a deliberate code + database migration, never a
 * runtime decision.
 */

// ---------------------------------------------------------------------------
// Ordered levels: LOW < MEDIUM < HIGH
// ---------------------------------------------------------------------------
export const LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type Level = (typeof LEVELS)[number];
export const LevelSchema = z.enum(LEVELS);

const LEVEL_RANK: Record<Level, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export const levelRank = (l: Level): number => LEVEL_RANK[l];

/** A model satisfies an ordered requirement when it meets or exceeds it. */
export const levelSatisfies = (capability: Level, requirement: Level): boolean =>
  LEVEL_RANK[capability] >= LEVEL_RANK[requirement];

// ---------------------------------------------------------------------------
// Tool capability: NONE < BASIC < ADVANCED
// ---------------------------------------------------------------------------
export const TOOL_CAPABILITIES = ["NONE", "BASIC", "ADVANCED"] as const;
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];
export const ToolCapabilitySchema = z.enum(TOOL_CAPABILITIES);

const TOOL_RANK: Record<ToolCapability, number> = { NONE: 0, BASIC: 1, ADVANCED: 2 };
export const toolRank = (t: ToolCapability): number => TOOL_RANK[t];

export const toolSatisfies = (capability: ToolCapability, requirement: ToolCapability): boolean =>
  TOOL_RANK[capability] >= TOOL_RANK[requirement];

// ---------------------------------------------------------------------------
// Output capability: categorical, NOT ordered. A hard constraint.
// ---------------------------------------------------------------------------
export const OUTPUT_CAPABILITIES = [
  "TEXT", "IMAGE", "AUDIO", "VIDEO", "EMBEDDING", "RERANK",
] as const;
export type OutputCapability = (typeof OUTPUT_CAPABILITIES)[number];
export const OutputCapabilitySchema = z.enum(OUTPUT_CAPABILITIES);

// ---------------------------------------------------------------------------
// Modalities and direction
// ---------------------------------------------------------------------------
export const MODALITIES = [
  "TEXT", "IMAGE", "AUDIO", "VIDEO", "FILE", "EMBEDDING", "RERANK",
] as const;
export type ModalityKind = (typeof MODALITIES)[number];
export const ModalitySchema = z.enum(MODALITIES);

export const MODALITY_DIRECTIONS = ["INPUT", "OUTPUT"] as const;
export type ModalityDirection = (typeof MODALITY_DIRECTIONS)[number];

// ---------------------------------------------------------------------------
// Model categories. A model may belong to several.
// ---------------------------------------------------------------------------
export const MODEL_CATEGORIES = [
  "TEXT", "IMAGE", "VIDEO", "SPEECH", "TRANSCRIPTION", "EMBEDDINGS", "RERANK", "AUDIO",
] as const;
export type ModelCategory = (typeof MODEL_CATEGORIES)[number];
export const ModelCategorySchema = z.enum(MODEL_CATEGORIES);

// ---------------------------------------------------------------------------
// Provenance of a capability profile
// ---------------------------------------------------------------------------
export const ASSESSMENT_SOURCES = ["INITIAL", "BENCHMARK", "MANUAL", "OBSERVED"] as const;

/**
 * Where a capability value came from, strongest evidence first. An INFERRED
 * value is never presented as authoritative.
 */
export const EVIDENCE_LEVELS = [
  "DIRECT_PROVIDER_DATA",
  "CONTROLLED_BENCHMARK",
  "OBSERVED_DOTAI_DATA",
  "MANUAL_ASSESSMENT",
  "INFERRED",
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
export const EvidenceLevelSchema = z.enum(EVIDENCE_LEVELS);

/** Confidence ceiling permitted for each evidence level. */
export const EVIDENCE_CONFIDENCE: Record<EvidenceLevel, number> = {
  DIRECT_PROVIDER_DATA: 0.95,
  CONTROLLED_BENCHMARK: 0.9,
  OBSERVED_DOTAI_DATA: 0.85,
  MANUAL_ASSESSMENT: 0.8,
  INFERRED: 0.55,
};
export type AssessmentSource = (typeof ASSESSMENT_SOURCES)[number];
export const AssessmentSourceSchema = z.enum(ASSESSMENT_SOURCES);

export const ASSESSMENT_STATUSES = ["ASSESSED", "UNASSESSED"] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Outcome categories. Never collapse a rejection into a boolean - we need to
// know *why* a model failed.
// ---------------------------------------------------------------------------
export const OUTCOME_CATEGORIES = [
  "SUCCESS",
  "PERFORMANCE_FAILURE",
  "CAPABILITY_MISMATCH",
  "RESPONSIBILITY_BLOCK",
  "COST_FAILURE",
  "TIMEOUT",
  "PROVIDER_FAILURE",
  "USER_REJECTED",
  "HUMAN_REJECTED",
  "REGENERATED",
] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];
export const OutcomeCategorySchema = z.enum(OUTCOME_CATEGORIES);

/** Which outcomes count as the model having done its job. */
export const SUCCESS_OUTCOMES: OutcomeCategory[] = ["SUCCESS"];

/**
 * Checker-versus-human disagreement. Both directions are recorded because both
 * are informative: one suggests the checker missed something, the other that it
 * was too strict.
 */
export const DISAGREEMENTS = ["NONE", "FALSE_NEGATIVE", "FALSE_POSITIVE"] as const;
export type Disagreement = (typeof DISAGREEMENTS)[number];

// ---------------------------------------------------------------------------
// The seven capability fields
// ---------------------------------------------------------------------------
export const CapabilityProfileSchema = z.object({
  effort: LevelSchema,
  reasoning: LevelSchema,
  contextHandling: LevelSchema,
  instructionComplexity: LevelSchema,
  reliability: LevelSchema,
  toolCapability: ToolCapabilitySchema,
  outputCapabilities: z.array(OutputCapabilitySchema).min(1),
});
export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

/**
 * What CAI must return. Strict: unknown values are rejected rather than
 * coerced, so a malformed classification can never widen the taxonomy.
 */
export const TaskRequirementProfileSchema = z.object({
  taskType: z.string().min(1).max(60),
  effort: LevelSchema,
  reasoning: LevelSchema,
  contextHandling: LevelSchema,
  instructionComplexity: LevelSchema,
  reliability: LevelSchema,
  toolCapability: ToolCapabilitySchema,
  requiredInputModalities: z.array(ModalitySchema).min(1),
  requiredOutputModalities: z.array(OutputCapabilitySchema).min(1),
  confidence: z.number().min(0).max(1),
});
export type TaskRequirementProfile = z.infer<typeof TaskRequirementProfileSchema>;

export const ORDERED_FIELDS = [
  "effort", "reasoning", "contextHandling", "instructionComplexity", "reliability",
] as const;
export type OrderedField = (typeof ORDERED_FIELDS)[number];

export const FIELD_LABELS: Record<OrderedField | "toolCapability" | "outputCapabilities", string> = {
  effort: "Effort capacity",
  reasoning: "Reasoning",
  contextHandling: "Context handling",
  instructionComplexity: "Instruction complexity",
  reliability: "Reliability",
  toolCapability: "Tool / agent capability",
  outputCapabilities: "Output capability",
};
