import type {
  Capability, Effort, Modality, ModelCandidate, RiskLevel, TaskType,
  VerificationDepth,
} from "@/types";

export type RouteSource = "DIRECT" | "CAI" | "HIGH_RISK_POLICY";
export type RouteType = "DIRECT" | "CAI";

/** What the Fast Router concluded without spending anything. */
export interface FastRouteResult {
  routeType: RouteType;
  taskType: TaskType;
  modality: Modality[];
  complexity: number;
  riskLevel: RiskLevel;
  confidence: number;
  reason: string;
  highRisk: boolean;
  directRoute?: {
    taskType: TaskType;
    requiredCapabilities: Capability[];
    recommendedModelClass: "small" | "mid" | "large";
    recommendedEffort: Effort;
  };
}

/**
 * What CAI returns. CAI understands the task; it does NOT select the model.
 * Selection belongs to the ModelScoringEngine.
 */
export interface TaskRequirements {
  taskType: TaskType;
  complexity: number;
  requiredCapabilities: Capability[];
  modalities: Modality[];
  reasoningRequirement: "none" | "light" | "moderate" | "heavy";
  contextRequirement: number;
  expectedOutputSize: number;
  estimatedInputTokens: number;
  riskLevel: RiskLevel;
  recommendedEffort: Effort;
  confidence: number;
  rationale: string;
  source: "heuristic" | "llm";
  caiModel?: string;
  caiCostUsd: number;
}

/** One of the three options offered to the user. */
export interface ModelOption {
  modelId: string;
  name: string;
  provider: string;
  estimatedCost: number;
  expectedSuccess: number;
  latencyClass: string;
  score: number;
  fit: "high" | "medium" | "low";
  rationale: string;
  /** Why this model qualified, field by field. Safe to show the user. */
  capabilityChecks?: {
    label: string; required: string; actual: string; passed: boolean;
  }[];
  /** Which of the three slots this option fills. */
  role?: "RECOMMENDED" | "BEST" | "ALTERNATIVE";
  /** Execution status for the requested modality at recommendation time. */
  executionStatus?: string;
  /** True only when a real provider call has already succeeded. */
  executionVerified?: boolean;
  /** One line the UI can show verbatim explaining the match. */
  whyThisModel?: string;
}

export interface ModelOptions {
  recommendable: ModelOption;
  best: ModelOption;
  alternative: ModelOption | null;
  all: ModelOption[];
}

/** The single object the UI consumes. */
export interface RoutingResult {
  routeSource: RouteSource;
  caiUsed: boolean;
  caiSkippedReason?: string;
  taskType: TaskType;
  complexity: number;
  riskLevel: RiskLevel;
  verificationDepth: VerificationDepth;
  recommendedEffort: Effort;
  requiredCapabilities: Capability[];
  modalities: Modality[];
  confidence: number;
  rationale: string;
  recommendedModel: string;
  bestModel: string;
  alternativeModel: string | null;
  estimatedCost: number;
  options: ModelOptions;
  candidates: ModelCandidate[];
  routingCostUsd: number;
  /** The task expressed in dotAI's controlled capability vocabulary. */
  requirementProfile?: import("@/lib/capability/taxonomy").TaskRequirementProfile;
  qualifiedCount?: number;
  caiSchemaValid?: boolean;
  /** Normalised task type used for pool lookup and scoring. */
  taskType_normalised?: string;
  candidatePoolSize?: number;
  /**
   * CAI's sub-task, as resolved against the curated taxonomy.
   *
   * `taskType` is the fast router's coarse routing bucket and stays that way,
   * because risk level and verification depth are derived from it. This is
   * the classification a user is shown: the router labels most text prompts
   * "conversation", which made a coding question and a greeting look
   * identical on screen.
   */
  subTaskLabel?: string;
  /**
   * How many evaluated Top-N candidates the offline evaluator supplied for
   * this task. Zero means routing fell back to the full capability-filtered
   * pool, which is a useful thing to see in the audit trail.
   */
  intelligenceTopN?: number;
  intelligence?: {
    modelId: string; provider: string; overall: number;
    confidence: string; executionStatus: string; reasons: string[];
  }[];
  /** How many candidates passed execution validation. */
  verifiedCount?: number;
  /** Set when fewer than three executable models exist. */
  executabilityNote?: string;
  executionRejected?: { modelId: string; reason: string; message: string }[];
  rejectedModels?: { modelId: string; name: string; reason: string }[];
  fastRouter: {
    confidence: number;
    reason: string;
    routeType: RouteType;
  };
}
