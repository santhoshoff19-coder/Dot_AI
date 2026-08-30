// ---------------------------------------------------------------------------
// dotAI shared domain types. UI never imports provider-specific types.
// ---------------------------------------------------------------------------

export type TaskType =
  | "conversation" | "summarization" | "extraction" | "classification"
  | "translation" | "formatting" | "image_generation"
  | "writing" | "coding" | "reasoning" | "complex_reasoning"
  | "data_analysis" | "image_analysis" | "document_analysis" | "tool_execution";

export type Effort = "low" | "medium" | "high";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type VerificationDepth = "light" | "standard" | "deep";
export type LatencyClass = "fast" | "balanced" | "slow";
export type Modality = "text" | "image" | "audio" | "document";

export type Capability =
  | "text" | "vision" | "audio" | "long_context" | "reasoning" | "coding" | "tools";

export interface ModelSpec {
  id: string;
  provider: string;
  name: string;
  capabilities: Capability[];
  inputCost: number;        // USD per 1M input tokens
  outputCost: number;       // USD per 1M output tokens
  contextLimit: number;
  modalities: Modality[];
  reasoningSupport: boolean;
  relativeCapability: number;   // 0..1
  latencyClass: LatencyClass;
  enabled: boolean;
  skills: Partial<Record<TaskType, number>>;
}

// --- CAI -------------------------------------------------------------------
export interface ModelCandidate {
  modelId: string;
  name: string;
  estimatedCost: number;
  expectedSuccess: number;
  costPerSuccess: number;
}

export interface ModelRecommendation {
  taskType: TaskType;
  complexity: number;
  requiredCapabilities: Capability[];
  recommendedModel: string;
  bestModel: string;
  alternativeModel: string | null;
  recommendedEffort: Effort;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
  confidence: number;
  rationale: string;            // user-safe, never chain-of-thought
  riskLevel: RiskLevel;
  verificationDepth: VerificationDepth;
  candidates: ModelCandidate[];
  /** Which level of intelligence produced this route. */
  routeSource?: "DIRECT" | "CAI" | "HIGH_RISK_POLICY";
  caiUsed?: boolean;
  caiSkippedReason?: string;
  routingCostUsd?: number;
}

// --- Generation ------------------------------------------------------------
export interface AttachmentRef {
  /** How text extraction went for a document upload. */
  extractionStatus?: string;
  extractionDetail?: string;
  pageCount?: number;
  id: string;
  name: string;
  mimeType: string;
  size: number;
  type: AttachmentType;
  previewUrl?: string | null;
  storageRef?: string | null;
  extractedText?: string | null;
}

export type AttachmentType = "image" | "document" | "audio" | "other";
export type AttachmentStatus = "pending" | "uploading" | "ready" | "error";

export interface GenerationRequest {
  prompt: string;
  modelId: string;
  effort: Effort;
  attachments: AttachmentRef[];
  history: { role: "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
}

export interface GenerationResult {
  text: string;
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cost: number;
  latencyMs: number;
  cancelled?: boolean;
}

// --- ControlPlane checker --------------------------------------------------
export type PerformanceStatus = "SUPPORTED" | "CONTRADICTED" | "UNCERTAIN" | "UNVERIFIABLE";
export type CostStatus = "WITHIN TARGET" | "ABOVE TARGET" | "OVER BUDGET";
export type ResponsibilityStatus = "PERMITTED" | "RESTRICTED" | "PROHIBITED";

export interface Claim {
  text: string;
  values: string[];
  checkable: boolean;
}

export interface EvidencePassage {
  id: string;
  source: string;
  text: string;
  score: number;
  authoritative: boolean;
}

export interface ClaimVerdict {
  claim: string;
  status: PerformanceStatus;
  detail: string;
  evidence: EvidencePassage | null;
}

export interface PerformanceResult {
  status: PerformanceStatus;
  claimsChecked: number;
  verdicts: ClaimVerdict[];
  checksRun: string[];
  earlyExit: boolean;
  /** Set when the anomaly rung ran. A signal to look harder, never proof. */
  anomaly?: import("@/lib/verification/anomaly").AnomalyResult;
  /** Set when the AI verifier rung ran. */
  verification?: import("@/lib/verification/judge").VerifierResult;
  checkerLatencyMs?: number;
  note?: string;
}

export interface CostResult {
  status: CostStatus;
  estimatedCost: number;
  actualCost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  attempts: number;
  verificationCost: number;
  totalCost: number;
  costPerSuccessfulTask: number;
  notes: string[];
}

export type ResponsibilityCategory =
  | "privacy" | "safety" | "fairness" | "policy" | "security";

export interface ResponsibilityFinding {
  /** Primary category, retained so existing consumers keep working. */
  category: ResponsibilityCategory;
  /**
   * All risk labels that apply. Risks genuinely overlap - a fabricated detail
   * about a named customer is a hallucination and a privacy issue at once -
   * and the decision engine reasons over the combination.
   */
  categories?: import("@/lib/governance/profiles").RiskCategory[];
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  /** Why this was flagged, in user-safe terms. */
  explanation?: string;
  evidence?: string;
  /** Where in the output it occurred, when known. */
  location?: { start: number; end: number } | null;
  confidence?: number;
  source?: string;
  deterministic: boolean;
  redactClass?: string;
}

export interface ResponsibilityResult {
  status: ResponsibilityStatus;
  findings: ResponsibilityFinding[];
  checksRun: string[];
  categories: Record<ResponsibilityCategory, "clear" | "flagged" | "not_run">;
}

// --- Decision --------------------------------------------------------------
export type Decision = "ALLOW" | "ANNOTATE" | "REGENERATE" | "HOLD" | "BLOCK";

export interface ControlDecision {
  decision: Decision;
  reason: string;
  recommendedAction: "deliver" | "deliver_with_note" | "retry" | "human_review" | "block";
  annotations: string[];
}

// --- Action gate -----------------------------------------------------------
export interface ActionIntent {
  name: string;
  parameters: Record<string, string | number | boolean>;
  valueUsd: number;
  reversible: boolean;
  destination: { channel: string; external: boolean; address?: string };
}

export type GateStage = "intent" | "permission" | "risk" | "policy" | "parameters" | "execute";

export interface ActionGateResult {
  allowed: boolean;
  decision: "ALLOW" | "HOLD" | "BLOCK";
  stage: GateStage;
  reason: string;
  checks: { stage: GateStage; label: string; passed: boolean; detail: string }[];
  executed: boolean;
  result?: string;
}

// --- Aggregate control event ----------------------------------------------
export interface ControlEventData {
  requestId: string;
  /** Which use-case policy governed this decision. */
  profileId?: string;
  profileName?: string;
  /** Multi-label findings: one risk can carry several categories. */
  riskFindings?: import("@/lib/governance/risk-findings").RiskFinding[];
  riskCategories?: string[];
  /** Every rule that fired, so the verdict is explainable end to end. */
  decisionTrace?: { rule: string; detail: string; raisedTo: string }[];
  intersectionsApplied?: string[];
  /** Accumulated risk across the conversation, never a model property. */
  sessionRisk?: {
    level: string; score: number; unverifiedClaims: number; contradictions: number;
    responsibilityFindings: number; highRiskActions: number; turns: number;
  };
  verificationDepthReason?: string;
  checkerLatencyMs?: number;
  taskClassification: TaskType;
  /**
   * CAI's sub-task for this request, from the curated taxonomy.
   *
   * Recorded alongside the routing bucket so the audit trail says the same
   * thing the user was shown.
   */
  subTaskLabel?: string;
  complexity: number;
  recommendedModel: string;
  selectedModel: string;
  provider: string;
  effort: Effort;
  estimatedCost: number;
  actualCost: number;
  verification: PerformanceResult;
  cost: CostResult;
  responsibility: ResponsibilityResult;
  riskLevel: RiskLevel;
  verificationDepth: VerificationDepth;
  /** How the final decision was reached, and which control bound it. */
  decisionMerge?: {
    decidedBy: string;
    concurring: string[];
    explanation: string;
    contributions: { source: string; decision: string; reason: string }[];
  };
  /** Full cost accounting, including what ControlPlane itself added. */
  costBreakdown?: {
    generation: number;
    routing: number;
    verification: number;
    rag: number;
    retry: number;
    controlPlaneOverhead: number;
    total: number;
  };
  /**
   * The capability-routing decision: CAI's analysis, LIST A, the eligible
   * set and the three choices. Present on every turn that routed through the
   * curated dataset, and the record of why this model was executed.
   */
  capability?: import("@/lib/intelligence/curated-routing").RoutingDecision;

  /**
   * The governance workflow that actually ran for this request.
   *
   * Recorded so the difference between profiles is visible rather than
   * implied: two profiles running the same stages would be the same product
   * with different thresholds.
   */
  workflow?: {
    profileId: string;
    profileName: string;
    stages: string[];
    summary: string;
    retrieval: string;
    requireCitations: boolean;
    boundedVerification: boolean;
    treatUncertaintyAsBlocking: boolean;
  };

  /** What the pre-generation privacy firewall found and decided. */
  firewall?: import("@/lib/governance/privacy-firewall").FirewallResult;

  /** Retrieval mode and what it actually did. */
  rag?: {
    mode: string; label: string; triggered: boolean; retrievalType: string;
    reason: string; chunksRetrieved: number; embeddingCostUsd: number;
    retrievalLatencyMs: number;
    /**
     * Sections supplied to the model before it generated. Present only when
     * retrieval actually ran and returned something above the relevance
     * floor, so an empty list means the corpus had nothing to offer.
     */
    evidence?: import("@/lib/policy/engine").PolicyEvidence[];
    /** True when those sections were injected into the generation prompt. */
    groundedGeneration?: boolean;
  };
  /** Policy-layer evidence and verdict, preserved for audit. */
  policy?: {
    jurisdictions: string[];
    decision: string;
    reason: string;
    appliedRule: string;
    conflict: boolean;
    caveat: string;
    retrievalMode: string;
    evidence: import("@/lib/policy/engine").PolicyEvidence[];
  };
  decision: ControlDecision;
  actionGate: ActionGateResult | null;
  latencyMs: number;
  attempts: number;
  rationale: string;
  /** Which level of intelligence routed this request. */
  routeSource?: "DIRECT" | "CAI" | "HIGH_RISK_POLICY";
  caiUsed?: boolean;
  caiSkippedReason?: string;
  routingCostUsd?: number;
  fastRouterConfidence?: number;
  requirementProfile?: import("@/lib/capability/taxonomy").TaskRequirementProfile;
  qualifiedCount?: number;
  providerFailure?: boolean;
  executionFailureReason?: string;
  /** What the user asked for versus what actually ran. */
  requestedModel?: string;
  executedModel?: string;
  fallbackReason?: string;
  modelOptions?: import("@/lib/routing/route-types").ModelOptions;
  mock: boolean;
}

// --- Chat ------------------------------------------------------------------
export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus =
  | "pending" | "streaming" | "complete" | "error" | "cancelled" | "blocked" | "held";

export interface GeneratedImageRef {
  url: string;
  mimeType: string;
  simulated: boolean;
}

export interface GeneratedDocumentAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  simulated: boolean;
}

export interface ChatMessage {
  id: string;
  image?: GeneratedImageRef | null;
  document?: GeneratedDocumentAttachment | null;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: string;
  attachments: AttachmentRef[];
  controlEvent?: ControlEventData | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

// --- Settings --------------------------------------------------------------
export interface UserSettings {
  /** When true, dotAI runs the recommendable model without asking. */
  autoMode: boolean;
  /**
   * How to weigh cost against capability when choosing among the models that
   * can actually perform the query.
   *
   * This replaced `modelPreference`, which pinned every request to one model
   * id. Pinning a model defeats capability matching: the pinned model may not
   * be able to do what the query needs, and the user has no way to know that.
   * A preference shapes the choice; it does not make it.
   */
  costPreference: "LOWEST" | "BALANCED" | "BEST_QUALITY";
  effort: "AUTO" | Effort;
  verification: "AUTO" | "STANDARD" | "STRICT";
}

export const DEFAULT_SETTINGS: UserSettings = {
  autoMode: true,
  costPreference: "BALANCED",
  effort: "AUTO",
  verification: "AUTO",
};

// --- Stream protocol (server -> client) ------------------------------------
export type StreamEvent =
  | { type: "status"; stage: string; label: string }
  | { type: "image"; url: string; mimeType: string; simulated: boolean }
  | { type: "document"; fileName: string; mimeType: string; size: number; url: string; simulated: boolean }
  | { type: "routing"; routing: import("@/lib/routing/route-types").RoutingResult }
  | { type: "cai"; recommendation: ModelRecommendation }
  | { type: "capability"; capability: import("@/lib/intelligence/curated-routing").RoutingDecision }
  | { type: "firewall"; firewall: import("@/lib/governance/privacy-firewall").FirewallResult }
  | { type: "token"; text: string }
  | { type: "control"; event: ControlEventData }
  | { type: "message"; message: ChatMessage }
  | { type: "conversation"; id: string; title: string }
  | { type: "error"; message: string }
  | { type: "done" };
