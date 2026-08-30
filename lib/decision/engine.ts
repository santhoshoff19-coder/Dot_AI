import type {
  ControlDecision, CostResult, Decision, PerformanceResult, ResponsibilityFinding,
  ResponsibilityResult, RiskLevel,
} from "@/types";

const ORDER: Decision[] = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"];
const strictest = (a: Decision, b: Decision) =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

export interface DecisionInput {
  performance: PerformanceResult;
  cost: CostResult;
  responsibility: ResponsibilityResult;
  riskLevel: RiskLevel;
  consequence: { irreversible: boolean; external: boolean; valueUsd: number };
  attempt: number;
  maxAttempts: number;
}


/**
 * Turns risk + evidence + consequence into ONE action.
 * Detection is separate from decision: the same finding yields a different
 * outcome depending on consequence.
 */
export class DecisionEngine {
  decide(input: DecisionInput): ControlDecision {
    const { performance, responsibility, riskLevel, consequence, attempt, maxAttempts } = input;
    const reasons: string[] = [];
    const annotations: string[] = [];
    let decision: Decision = "ALLOW";

    const highConsequence =
      riskLevel === "high" || riskLevel === "critical" ||
      consequence.irreversible || consequence.external;

    // --- responsibility ----------------------------------------------------
    for (const f of responsibility.findings) {
      let d: Decision = "ALLOW";
      if (f.severity === "critical") d = f.deterministic ? "BLOCK" : "HOLD";
      else if (f.severity === "high") d = highConsequence ? "HOLD" : "REGENERATE";
      else if (f.severity === "medium") d = highConsequence ? "HOLD" : "ANNOTATE";
      else d = "ANNOTATE";

      if (d === "ANNOTATE") annotations.push(f.message);
      if (ORDER.indexOf(d) > ORDER.indexOf(decision)) reasons.unshift(f.message);
      decision = strictest(decision, d);
    }

    // --- performance -------------------------------------------------------
    if (performance.status === "CONTRADICTED") {
      // A contradicted claim is never quietly delivered. If regeneration did
      // not fix it, a human decides - only genuinely low-risk chat degrades
      // to an annotation.
      const exhausted: Decision =
        highConsequence || riskLevel !== "low" ? "HOLD" : "ANNOTATE";
      const d: Decision = attempt <= maxAttempts ? "REGENERATE" : exhausted;
      if (ORDER.indexOf(d) > ORDER.indexOf(decision)) {
        reasons.unshift("The answer conflicts with the retrieved source of record.");
      }
      decision = strictest(decision, d);
    } else if (performance.status === "UNCERTAIN") {
      const d: Decision = highConsequence ? "HOLD" : "ANNOTATE";
      if (d === "ANNOTATE") {
        annotations.push("Some claims could not be grounded against a source.");
      } else {
        reasons.unshift("Unresolved doubt on a high-consequence request.");
      }
      decision = strictest(decision, d);
    } else if (performance.status === "UNVERIFIABLE" && highConsequence) {
      annotations.push("Claims in this answer were not verified against a source.");
      decision = strictest(decision, "ANNOTATE");
    }

    // --- consequence -------------------------------------------------------
    if (riskLevel === "critical" && decision !== "BLOCK") {
      reasons.unshift("High-risk financial action requires human approval.");
      decision = strictest(decision, "HOLD");
    }

    // Cost never gates the answer; it is reported, not enforced.
    if (input.cost.status === "OVER BUDGET") {
      annotations.push(`Cost check: ${input.cost.status.toLowerCase()}.`);
    }

    // A regeneration that keeps failing becomes a human decision, not a loop.
    if (decision === "REGENERATE" && attempt > maxAttempts) {
      decision = highConsequence || riskLevel !== "low" ? "HOLD" : "ANNOTATE";
      reasons.unshift(`Still unresolved after ${attempt - 1} regeneration attempt(s).`);
    }

    const recommendedAction =
      decision === "ALLOW" ? "deliver"
      : decision === "ANNOTATE" ? "deliver_with_note"
      : decision === "REGENERATE" ? "retry"
      : decision === "HOLD" ? "human_review"
      : "block";

    return {
      decision,
      reason: reasons[0] ?? (annotations[0] ?? "No material findings."),
      recommendedAction,
      annotations: [...new Set(annotations)],
    };
  }
}

export const decisionEngine = new DecisionEngine();
