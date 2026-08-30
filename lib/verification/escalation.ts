import type { UseCaseProfile } from "@/lib/governance/profiles";
import type { AnomalyBand } from "@/lib/verification/anomaly";
import type { PerformanceStatus, VerificationDepth } from "@/types";

export interface EscalationInput {
  profile: UseCaseProfile;
  depth: VerificationDepth;
  /** Where the deterministic rungs left things. */
  deterministicStatus: PerformanceStatus;
  /** True when a calculator or database settled it outright. */
  settledDeterministically: boolean;
  anomalyBand: AnomalyBand;
  checkableClaims: number;
  /** Milliseconds of checking already spent this turn. */
  elapsedMs: number;
}

export interface EscalationDecision {
  runAnomaly: boolean;
  runVerifier: boolean;
  reason: string;
}

/**
 * Escalation policy — the answer to "when is the expensive check worth it".
 *
 * The rule is deterministic-first: if a calculator or the source of record has
 * already settled the question, nothing is gained by asking a model about it.
 * The verifier is reserved for genuine uncertainty on work that matters.
 */
export function decideEscalation(input: EscalationInput): EscalationDecision {
  const {
    profile, depth, deterministicStatus, settledDeterministically,
    anomalyBand, checkableClaims, elapsedMs,
  } = input;

  // 1. Nothing to check.
  if (checkableClaims === 0) {
    return {
      runAnomaly: false, runVerifier: false,
      reason: "No checkable claims were made.",
    };
  }

  // 2. Already settled deterministically. A model opinion cannot improve on a
  // calculator, and would only add cost and latency.
  if (settledDeterministically) {
    return {
      runAnomaly: false, runVerifier: false,
      reason: "A deterministic check already settled this; a verifier adds cost without adding certainty.",
    };
  }

  // 3. The light path exists to stay fast. Anomaly scoring is cheap enough to
  // run, but a verifier call is not.
  if (depth === "light") {
    return {
      runAnomaly: true, runVerifier: false,
      reason: "Light verification path: anomaly scoring only, to protect the latency budget.",
    };
  }

  // 4. Latency budget already spent.
  // The checker gets a fraction of the use case's overall latency SLO; the
  // rest belongs to generation.
  const budget = Math.round(profile.latencySLOms * 0.6);
  if (elapsedMs > budget) {
    return {
      runAnomaly: true, runVerifier: false,
      reason: `Checking has already used ${elapsedMs}ms of the ${budget}ms budget for ${profile.name}, so no verifier call was made.`,
    };
  }

  const uncertain =
    deterministicStatus === "UNCERTAIN" || deterministicStatus === "UNVERIFIABLE";
  const unusual = anomalyBand !== "NORMAL";

  // 5. Deep path always verifies remaining uncertainty.
  if (depth === "deep" && (uncertain || unusual)) {
    return {
      runAnomaly: true, runVerifier: true,
      reason: `Deep verification for ${profile.name} with unresolved uncertainty.`,
    };
  }

  // 6. Standard path verifies when the response is both unresolved and unlike
  // normal traffic. Either signal alone is not worth the spend.
  if (depth === "standard" && uncertain && unusual) {
    return {
      runAnomaly: true, runVerifier: true,
      reason: "Claims are ungrounded and the response is unlike previous answers for this task.",
    };
  }

  if (depth === "standard" && uncertain) {
    return {
      runAnomaly: true, runVerifier: false,
      reason: "Claims are ungrounded but the response looks typical, so it is annotated rather than escalated to a verifier.",
    };
  }

  return {
    runAnomaly: true, runVerifier: false,
    reason: "Deterministic and evidence checks resolved the response.",
  };
}
