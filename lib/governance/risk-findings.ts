import type { PerformanceResult, ResponsibilityResult } from "@/types";
import type { RiskCategory, Severity } from "@/lib/governance/profiles";

/**
 * A single risk finding, carrying every label that applies to it.
 *
 * The brief's point is that risks overlap in practice: one fabricated detail
 * about a customer is a hallucination *and* a privacy problem. Duplicating it
 * into two findings would double-count it; forcing one label would lose the
 * overlap that should escalate it. So one finding, several labels.
 */
export interface RiskFinding {
  id: string;
  categories: RiskCategory[];
  severity: Severity;
  confidence: number;
  explanation: string;
  evidence?: string;
  /** Which detector produced this. */
  source: "deterministic" | "evidence" | "policy" | "semantic" | "action_gate";
  /** Where in the output it occurs, when the detector can say. */
  location?: { snippet: string; index?: number };
  deterministic: boolean;
  fixable?: boolean;
  redactClass?: string;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Whether a claim is *also* a privacy risk is decided by the privacy detector
 * actually finding personal data in the same response - not by the text
 * mentioning a person.
 *
 * Labelling every customer-related answer as a privacy risk would fire the
 * overlap rule constantly and produce precisely the alert fatigue that makes
 * operators start ignoring the checker.
 */

const PII_CATEGORY: Record<string, RiskCategory[]> = {
  account_number: ["PRIVACY", "SENSITIVE_DATA"],
  credit_card: ["PRIVACY", "SENSITIVE_DATA"],
  government_id: ["PRIVACY", "SENSITIVE_DATA"],
  api_key: ["SECURITY", "SENSITIVE_DATA"],
  private_key: ["SECURITY", "SENSITIVE_DATA"],
  email: ["PRIVACY"],
  phone: ["PRIVACY"],
};

/**
 * Converts the existing per-dimension results into multi-label findings.
 *
 * This deliberately reads the current checker output rather than replacing the
 * detectors: performance, cost and responsibility keep working exactly as they
 * do, and this layer only re-expresses what they found.
 */
export function toRiskFindings(
  performance: PerformanceResult,
  responsibility: ResponsibilityResult,
  opts: {
    answerText?: string;
    highConsequenceAction?: boolean;
    actionValueUsd?: number;
  } = {},
): RiskFinding[] {
  const findings: RiskFinding[] = [];

  // A genuine overlap: the privacy detector found personal data in this very
  // response, so an unsupported claim here is also a privacy exposure.
  const personal = responsibility.findings.some(
    (f) => f.category === "privacy" && f.severity !== "low");

  // ---- performance ------------------------------------------------------
  for (const v of performance.verdicts) {
    if (v.status === "CONTRADICTED") {
      const categories: RiskCategory[] = ["HALLUCINATION"];
      // The overlap the brief calls out: a fabricated detail about a person is
      // simultaneously an accuracy and a privacy failure.
      if (personal) categories.push("PRIVACY");
      if (opts.highConsequenceAction) categories.push("HIGH_CONSEQUENCE_ACTION");

      findings.push({
        id: uid(),
        categories,
        // Serious but fixable: a contradiction is a correctness failure that
        // regeneration can address. Reserving "critical" for unrecoverable
        // harms (data disclosure, unsafe content) keeps the ladder meaningful.
        severity: "high",
        confidence: v.evidence?.authoritative ? 0.95 : 0.7,
        explanation: `Claim conflicts with the source of record. ${v.detail}`,
        evidence: v.evidence?.text?.slice(0, 200),
        source: v.evidence ? "evidence" : "deterministic",
        location: { snippet: v.claim.slice(0, 160) },
        deterministic: Boolean(v.evidence?.authoritative),
        fixable: true,
      });
    } else if (v.status === "UNCERTAIN" || v.status === "UNVERIFIABLE") {
      const categories: RiskCategory[] = ["UNVERIFIABLE"];
      if (personal) categories.push("PRIVACY");
      if (opts.highConsequenceAction) categories.push("HIGH_CONSEQUENCE_ACTION");

      findings.push({
        id: uid(),
        categories,
        severity: opts.highConsequenceAction ? "high" : "low",
        confidence: 0.6,
        explanation: `Claim could not be grounded. ${v.detail}`,
        source: "evidence",
        location: { snippet: v.claim.slice(0, 160) },
        deterministic: false,
      });
    }
  }

  // ---- responsibility ---------------------------------------------------
  for (const f of responsibility.findings) {
    const categories = new Set<RiskCategory>();

    if (f.category === "privacy") {
      const cls = f.redactClass ?? "";
      for (const c of PII_CATEGORY[cls] ?? ["PRIVACY"]) categories.add(c);
    } else if (f.category === "safety") categories.add("SAFETY");
    else if (f.category === "fairness") categories.add("FAIRNESS");
    else if (f.category === "security") categories.add("SECURITY");
    else if (f.category === "policy") categories.add("POLICY_VIOLATION");

    // A policy breach and a privacy breach often describe the same act.
    if (f.message.toLowerCase().includes("policy")) categories.add("POLICY_VIOLATION");
    if (opts.highConsequenceAction) categories.add("HIGH_CONSEQUENCE_ACTION");

    findings.push({
      id: uid(),
      categories: [...categories],
      severity: f.severity,
      confidence: f.deterministic ? 0.98 : 0.75,
      explanation: f.message,
      evidence: f.evidence,
      source: f.deterministic ? "deterministic" : "semantic",
      deterministic: f.deterministic,
      fixable: Boolean(f.redactClass),
      redactClass: f.redactClass,
    });
  }

  // ---- consequential action ---------------------------------------------
  if (opts.highConsequenceAction && (opts.actionValueUsd ?? 0) > 0) {
    findings.push({
      id: uid(),
      categories: ["HIGH_CONSEQUENCE_ACTION"],
      severity: "high",
      confidence: 1,
      explanation: `Response drives an action worth $${(opts.actionValueUsd ?? 0).toLocaleString()}.`,
      source: "action_gate",
      deterministic: true,
    });
  }

  return findings;
}

/** Every distinct label present across a set of findings. */
export function allCategories(findings: RiskFinding[]): RiskCategory[] {
  const set = new Set<RiskCategory>();
  for (const f of findings) for (const c of f.categories) set.add(c);
  return [...set];
}
