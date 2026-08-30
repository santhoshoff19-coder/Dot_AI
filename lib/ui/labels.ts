/**
 * User-facing vocabulary.
 *
 * One concept, one word, everywhere. Backend identifiers are unchanged - these
 * are display labels only, and every lookup falls back to the raw value so a
 * new enum member shows something rather than nothing.
 *
 * Anything a user reads in the primary UI should come from here. If a term is
 * missing, add it here rather than writing a literal in a component: the
 * duplication is how "Regulation", "Policy type" and "regulation" ended up on
 * three different screens meaning the same thing.
 */

// ---- policy ---------------------------------------------------------------

export const POLICY_TYPE_LABEL: Record<string, string> = {
  INTERNAL: "Company Policy",
  GDPR: "Privacy / Data Protection",
  DPDP: "Privacy / Data Protection",
  HIPAA: "Healthcare",
  SOX: "Financial Compliance",
  OTHER: "Other Compliance",
};

export const APPLIES_TO_LABEL: Record<string, string> = {
  GLOBAL: "Global",
  EU: "European Union",
  IN: "India",
  US: "United States",
};

export const policyTypeLabel = (v: string) => POLICY_TYPE_LABEL[v] ?? v;
export const appliesToLabel = (v: string) => APPLIES_TO_LABEL[v] ?? v;

/** Field names, so every screen calls the same field the same thing. */
export const FIELD = {
  policyType: "Policy type",
  appliesTo: "Applies to",
  policyVersion: "Policy version",
  indexedSections: "Indexed sections",
  uploadAndIndex: "Upload & Index",
} as const;

// ---- decisions ------------------------------------------------------------

/**
 * What a decision means to the person reading it, rather than the enum name.
 * The enum is still available in the detail view for anyone who wants it.
 */
export const DECISION_LABEL: Record<string, string> = {
  ALLOW: "Verified",
  ANNOTATE: "Verified with notes",
  REGENERATE: "Regenerated",
  HOLD: "Needs review",
  BLOCK: "Blocked",
};

export const decisionLabel = (v: string) => DECISION_LABEL[v] ?? v;

/**
 * The single status line shown under an answer.
 *
 * "Verified" is reserved for a response whose claims were actually checked
 * against evidence. An allowed response with nothing to check is Unverified,
 * not Verified - claiming otherwise would be the most damaging kind of
 * inaccuracy this product can produce.
 */
export type AnswerStatus = "VERIFIED" | "UNVERIFIED" | "REVIEW" | "BLOCKED";

export const ANSWER_STATUS_LABEL: Record<AnswerStatus, string> = {
  VERIFIED: "Verified",
  UNVERIFIED: "Unverified",
  REVIEW: "Needs review",
  BLOCKED: "Blocked",
};

export function answerStatus(input: {
  decision: string;
  verificationStatus: string;
  claimsChecked: number;
}): AnswerStatus {
  if (input.decision === "BLOCK") return "BLOCKED";
  if (input.decision === "HOLD") return "REVIEW";
  if (input.verificationStatus === "CONTRADICTED") return "REVIEW";
  if (input.verificationStatus === "SUPPORTED" && input.claimsChecked > 0) return "VERIFIED";
  return "UNVERIFIED";
}

/** One line explaining the status, in the reader's terms. */
export function answerStatusDetail(status: AnswerStatus, claimsChecked: number): string {
  switch (status) {
    case "VERIFIED":
      return `${claimsChecked} claim${claimsChecked === 1 ? "" : "s"} checked against a source.`;
    case "REVIEW":
      return "A control needs a person to look at this before it is used.";
    case "BLOCKED":
      return "This response was not delivered.";
    default:
      return claimsChecked > 0
        ? "Claims could not be grounded in an available source."
        : "Nothing in this response could be checked against a source.";
  }
}

// ---- retrieval ------------------------------------------------------------

/**
 * How retrieval behaved, in four words or fewer. Mirrors the labels the
 * retrieval service already produces, but phrased for a reader who does not
 * know what a retrieval mode is.
 */
export function ragLabel(rag?: {
  mode: string; label: string; triggered: boolean; retrievalType: string;
}): string {
  if (!rag) return "RAG not used";
  if (rag.mode === "OFF") return "RAG off";
  if (!rag.triggered) return "RAG not used";

  const kind = rag.retrievalType === "BOTH" ? "Evidence + Policy"
    : rag.retrievalType === "POLICY" ? "Policy"
    : rag.retrievalType === "EVIDENCE" ? "Evidence"
    : null;

  const used = rag.mode === "ON" ? "RAG forced" : "RAG used";
  return kind ? `${used} · ${kind}` : used;
}

/** The three retrieval modes, with the one-line explanation each needs. */
export const RAG_MODES = [
  { value: "AUTO", label: "Auto", hint: "Use retrieval when relevant." },
  { value: "ON", label: "On", hint: "Always use retrieval." },
  { value: "OFF", label: "Off", hint: "Do not use retrieval." },
] as const;

export type RagModeValue = (typeof RAG_MODES)[number]["value"];

// ---- model options --------------------------------------------------------

export const MODEL_ROLE_LABEL: Record<string, string> = {
  RECOMMENDED: "Recommended",
  BEST: "Best",
  ALTERNATIVE: "Alternative",
};

/** Execution status, said plainly. */
export const EXECUTION_LABEL: Record<string, string> = {
  EXECUTION_VERIFIED: "Proven to run",
  METADATA_COMPATIBLE: "Not yet proven",
  TEMPORARILY_UNAVAILABLE: "Temporarily unavailable",
  UNAVAILABLE: "Unavailable",
  UNSUPPORTED: "Not supported",
  FAILED: "Failed",
  UNKNOWN: "Unchecked",
};

export const executionLabel = (v: string) => EXECUTION_LABEL[v] ?? v;

/** Task types, title-cased for display. */
export function taskLabel(taskType: string): string {
  const s = taskType.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
