/**
 * Controlled policy vocabulary. Categories are a closed set so retrieval
 * filters stay meaningful; adding one is a deliberate change, not a runtime
 * accident.
 */
export const POLICY_CATEGORIES = [
  "PRIVACY",
  "PERSONAL_DATA",
  "SENSITIVE_DATA",
  "DATA_TRANSFER",
  "CONSENT",
  "RETENTION",
  "SECURITY",
  "AUTOMATED_DECISION",
  "SAFETY",
  "ACCESS_CONTROL",
  "OTHER",
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export const JURISDICTIONS = ["EU", "IN", "US", "GLOBAL"] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

/** Outcomes the Policy Decision Engine may return. */
export const POLICY_DECISIONS = [
  "ALLOW", "ANNOTATE", "HOLD", "BLOCK", "UNVERIFIABLE",
] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

/**
 * Maps a detected risk category onto the policy categories worth retrieving.
 * This is what keeps the RAG query small: we look up the rules that could
 * plausibly govern the risk actually found, not the whole conversation.
 */
export const RISK_TO_POLICY: Record<string, PolicyCategory[]> = {
  PRIVACY: ["PRIVACY", "PERSONAL_DATA", "DATA_TRANSFER"],
  SENSITIVE_DATA: ["SENSITIVE_DATA", "PERSONAL_DATA", "CONSENT"],
  SECURITY: ["SECURITY", "ACCESS_CONTROL"],
  SAFETY: ["SAFETY"],
  FAIRNESS: ["AUTOMATED_DECISION"],
  POLICY_VIOLATION: ["PRIVACY", "DATA_TRANSFER", "ACCESS_CONTROL"],
  HALLUCINATION: ["AUTOMATED_DECISION"],
  UNVERIFIABLE: ["AUTOMATED_DECISION"],
  HIGH_CONSEQUENCE_ACTION: ["AUTOMATED_DECISION", "ACCESS_CONTROL"],
  COST: [],
};

export function policyCategoriesFor(riskCategories: string[]): PolicyCategory[] {
  const out = new Set<PolicyCategory>();
  for (const r of riskCategories) {
    for (const c of RISK_TO_POLICY[r] ?? []) out.add(c);
  }
  return [...out];
}

/** Normalises the profile's jurisdiction codes onto the policy vocabulary. */
export function normaliseJurisdiction(raw: string): Jurisdiction {
  const j = raw.toUpperCase();
  if (j === "EU" || j === "GDPR" || j === "EU_AI_ACT") return "EU";
  if (j === "IN" || j === "INDIA" || j === "DPDP") return "IN";
  if (j === "US" || j === "USA" || j === "SOX") return "US";
  return "GLOBAL";
}
