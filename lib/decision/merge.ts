import type { Decision } from "@/types";

export const DECISION_ORDER: Decision[] = [
  "ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK",
];

export type ControlSource =
  | "PERFORMANCE" | "RESPONSIBILITY" | "POLICY" | "GOVERNANCE"
  | "SESSION_RISK" | "ACTION_GATE" | "BASELINE";

export interface ControlSignal {
  source: ControlSource;
  decision: Decision;
  reason: string;
  /** Present when a signal was evaluated but had nothing to say. */
  skipped?: boolean;
}

export interface MergedDecision {
  decision: Decision;
  reason: string;
  /** Which control produced the binding verdict. */
  decidedBy: ControlSource;
  /** Every signal considered, in strictness order. Auditable. */
  contributions: ControlSignal[];
  /** Sources that also demanded this level, if more than one did. */
  concurring: ControlSource[];
  explanation: string;
}

export function rank(d: Decision): number {
  const i = DECISION_ORDER.indexOf(d);
  return i === -1 ? 0 : i;
}

export function strictest(a: Decision, b: Decision): Decision {
  return rank(a) >= rank(b) ? a : b;
}

export function recommendedActionFor(
  d: Decision,
): "deliver" | "deliver_with_note" | "retry" | "human_review" | "block" {
  switch (d) {
    case "ALLOW": return "deliver";
    case "ANNOTATE": return "deliver_with_note";
    case "REGENERATE": return "retry";
    case "HOLD": return "human_review";
    case "BLOCK": return "block";
  }
}

/**
 * Merges every control signal into one verdict.
 *
 * The rule is simply: the strictest applicable control wins. It is written
 * once, here, so a new control is added by contributing a signal rather than
 * by editing decision logic — and so no control can be recorded for audit
 * while quietly failing to affect what the user actually receives.
 *
 * Ties resolve to the earliest source in the supplied order, which is why
 * callers pass the most specific control first.
 */
export function mergeControlDecisions(signals: ControlSignal[]): MergedDecision {
  const active = signals.filter((s) => !s.skipped);

  if (active.length === 0) {
    return {
      decision: "ALLOW",
      reason: "No control raised an objection.",
      decidedBy: "BASELINE",
      contributions: signals,
      concurring: [],
      explanation: "No control was applicable to this response.",
    };
  }

  let binding = active[0];
  for (const s of active) {
    if (rank(s.decision) > rank(binding.decision)) binding = s;
  }

  const concurring = active
    .filter((s) => s !== binding && s.decision === binding.decision)
    .map((s) => s.source);

  const ordered = [...active].sort((a, b) => rank(b.decision) - rank(a.decision));

  const explanation = binding.decision === "ALLOW"
    ? "Every control permitted this response."
    : `${label(binding.source)} required ${binding.decision}` +
      (concurring.length
        ? `, and ${concurring.map(label).join(" and ")} independently agreed.`
        : ". This was the strictest control that applied.");

  return {
    decision: binding.decision,
    reason: binding.reason,
    decidedBy: binding.source,
    contributions: ordered,
    concurring,
    explanation,
  };
}

function label(s: ControlSource): string {
  return {
    PERFORMANCE: "The performance checker",
    RESPONSIBILITY: "The responsibility checker",
    POLICY: "The policy engine",
    GOVERNANCE: "The use-case governance layer",
    SESSION_RISK: "Accumulated conversation risk",
    ACTION_GATE: "The action gate",
    BASELINE: "The baseline decision engine",
  }[s];
}

/** Maps a policy verdict onto the control ladder. */
export function policyToDecision(verdict: string): Decision {
  switch (verdict) {
    case "BLOCK": return "BLOCK";
    case "HOLD": return "HOLD";
    // Unproven permission is not permission: an unverifiable policy position
    // becomes a human decision rather than a quiet approval.
    case "UNVERIFIABLE": return "HOLD";
    case "ANNOTATE": return "ANNOTATE";
    default: return "ALLOW";
  }
}
