import { redact, scanPII, type PIIHit } from "@/lib/responsibility/service";
import type { UseCaseProfile } from "@/lib/governance/profiles";

/**
 * The pre-generation privacy firewall.
 *
 * Every existing control checks the model's *answer*. This one checks the
 * *request*, before it leaves the building: once a customer's card number has
 * been sent to a third-party provider, no downstream verdict can un-send it.
 *
 *   user input → PII detection → policy → ALLOW / REDACT / HOLD / BLOCK → model
 *
 * Detection is the existing `scanPII`; this module only decides what the
 * policy requires be done about what it found.
 */

export type FirewallDecision = "ALLOW" | "REDACT" | "HOLD" | "BLOCK";

/**
 * Sensitivity tiers.
 *
 * The distinction that matters is not "is this personal" but "what does
 * leaking it cost". A card number or government id enables fraud directly and
 * cannot be un-leaked; a name or phone number is personal but recoverable.
 */
/**
 * Mirrors the severities the scanner itself assigns, rather than a second
 * opinion about them. Everything `lib/responsibility/service.ts` marks
 * critical is critical here; an account number was omitted at first, and a
 * card leaving the system was merely masked - which still leaked its last
 * four digits because the overlapping pattern claimed the span first.
 */
export const CRITICAL_CLASSES = [
  "private_key", "api_key", "government_id", "credit_card", "account_number",
];
/** Personal, but recoverable if leaked. */
export const SENSITIVE_CLASSES = ["email"];

export interface FirewallResult {
  decision: FirewallDecision;
  /** What actually goes to the model. Redacted when the policy required it. */
  safePrompt: string;
  /** Classes found, deduplicated. Values are never included. */
  detected: { cls: string; count: number; critical: boolean }[];
  /** Classes that were masked before the request left. */
  redactedClasses: string[];
  /** 0-1. How confident the detection is, from pattern specificity. */
  confidence: number;
  reason: string;
  /** The policy rule that produced this decision, for the evidence panel. */
  policyBasis: string;
}

/**
 * Detection confidence.
 *
 * Structured identifiers with checksums or fixed shapes are near-certain; a
 * loose pattern like an address is a guess. Reporting one number for both
 * would make the figure meaningless.
 */
function confidenceFor(hits: PIIHit[]): number {
  if (hits.length === 0) return 1;
  // Keyed to the classes lib/responsibility/service.ts actually detects.
  const perClass: Record<string, number> = {
    private_key: 0.99, api_key: 0.93, government_id: 0.95,
    account_number: 0.85, credit_card: 0.8, email: 0.95,
  };
  const scores = hits.map((h) => perClass[h.cls] ?? 0.7);
  // The weakest signal governs: a decision is only as sound as its shakiest
  // piece of evidence.
  return Math.round(Math.min(...scores) * 100) / 100;
}

export interface FirewallInput {
  prompt: string;
  profile: UseCaseProfile;
  /** True when the answer is destined for somewhere outside the system. */
  destinationExternal: boolean;
  /** Attachment text is scanned too: a PDF can carry what the prompt does not. */
  attachmentText?: string;
}

/**
 * Applies the policy to whatever detection found.
 *
 * The ladder is deliberate:
 *
 *   BLOCK   the class is one the policy refuses outright, or it is critical
 *           and heading outside the system
 *   HOLD    a person should look before this leaves, but it is not forbidden
 *   REDACT  the request can proceed with the values masked
 *   ALLOW   nothing sensitive, or nothing the policy objects to
 *
 * Redaction is preferred over blocking wherever the policy permits it: a
 * masked request still answers the user's question, and a blocked one does
 * not.
 */
export function privacyFirewall(input: FirewallInput): FirewallResult {
  const haystack = input.attachmentText
    ? `${input.prompt}\n${input.attachmentText}`
    : input.prompt;

  const hits = scanPII(haystack);

  const byClass = new Map<string, number>();
  for (const h of hits) byClass.set(h.cls, (byClass.get(h.cls) ?? 0) + 1);

  const detected = [...byClass.entries()].map(([cls, count]) => ({
    cls, count, critical: CRITICAL_CLASSES.includes(cls),
  }));

  const confidence = confidenceFor(hits);

  if (hits.length === 0) {
    return {
      decision: "ALLOW", safePrompt: input.prompt, detected: [],
      redactedClasses: [], confidence: 1,
      reason: "No personal or sensitive data detected in the request.",
      policyBasis: `${input.profile.name}: requests without sensitive data proceed unmodified.`,
    };
  }

  const criticalFound = detected.filter((d) => d.critical).map((d) => d.cls);
  const blocksPrivacy =
    input.profile.escalationRules.alwaysBlockCategories.includes("PRIVACY")
    || input.profile.escalationRules.alwaysBlockCategories.includes("SENSITIVE_DATA");

  // Critical identifiers leaving the system is the case no policy caveats.
  if (criticalFound.length > 0 && input.destinationExternal && blocksPrivacy) {
    return {
      decision: "BLOCK", safePrompt: "", detected, redactedClasses: [], confidence,
      reason:
        `The request carries ${criticalFound.join(", ")} and is destined outside the system. `
        + "Sending it cannot be undone, so it was stopped before reaching the model.",
      policyBasis:
        `${input.profile.name}: blocks ${input.profile.escalationRules.alwaysBlockCategories.join(", ")} `
        + "for external destinations.",
    };
  }

  // A strict policy will not forward critical identifiers at all, even
  // internally - it holds for a person rather than deciding alone.
  if (criticalFound.length > 0 && input.profile.riskTolerance === "low") {
    return {
      decision: "HOLD", safePrompt: "", detected, redactedClasses: [], confidence,
      reason:
        `The request carries ${criticalFound.join(", ")}. Under a strict policy this `
        + "is held for a person rather than forwarded to a model.",
      policyBasis: `${input.profile.name}: risk tolerance is low; critical identifiers are held.`,
    };
  }

  // Otherwise mask what was found and let the request through. The user's
  // question is still answerable without the identifiers in it.
  const classes = detected.map((d) => d.cls);
  const safePrompt = redact(input.prompt, classes);

  return {
    decision: "REDACT",
    safePrompt,
    detected,
    redactedClasses: classes,
    confidence,
    reason:
      `Masked ${classes.join(", ")} before the request left the system. `
      + "The model receives the question without the identifiers.",
    policyBasis:
      `${input.profile.name}: sensitive values are redacted rather than blocked `
      + "where the request can still be answered without them.",
  };
}
