import {
  interventionFor, raise, RISK_INTERSECTIONS, strictest,
  type RiskCategory, type UseCaseProfile,
} from "@/lib/governance/profiles";
import { allCategories, type RiskFinding } from "@/lib/governance/risk-findings";
import type { SessionRiskLevel } from "@/lib/governance/session-risk";
import type { Decision } from "@/types";

export interface GovernedDecisionInput {
  profile: UseCaseProfile;
  findings: RiskFinding[];
  sessionRisk: SessionRiskLevel;
  consequence: { irreversible: boolean; external: boolean; valueUsd: number; actionName?: string };
  attempt: number;
  maxAttempts: number;
}

export interface DecisionReason {
  rule: string;
  detail: string;
  raisedTo: Decision;
}

export interface GovernedDecision {
  decision: Decision;
  reason: string;
  /** Every rule that fired, in order, so the verdict is fully explainable. */
  trace: DecisionReason[];
  annotations: string[];
  categories: RiskCategory[];
  requiresHuman: boolean;
  intersectionsApplied: string[];
}

/**
 * The decision engine.
 *
 * It receives the AI output's findings, the active UseCaseProfile and the
 * session risk, and returns exactly one intervention. Every escalation is
 * recorded in a trace, so the system can always answer "why this verdict, in
 * this use case" without anyone reading the code.
 */
export class GovernedDecisionEngine {
  decide(input: GovernedDecisionInput): GovernedDecision {
    const { profile, findings, sessionRisk, consequence } = input;
    const trace: DecisionReason[] = [];
    const annotations: string[] = [];
    const intersectionsApplied: string[] = [];

    let decision: Decision = "ALLOW";
    const categories = allCategories(findings);

    // ---- 1. Per-finding intervention, from the profile's thresholds ------
    for (const f of findings) {
      const proposed = interventionFor(profile, f.severity);
      if (proposed === "ANNOTATE") annotations.push(f.explanation);
      if (proposed !== "ALLOW" && rank(proposed) > rank(decision)) {
        trace.push({
          rule: "severity_threshold",
          detail: `${f.categories.join(" + ")} at ${f.severity} severity meets the ${profile.name} threshold.`,
          raisedTo: proposed,
        });
      }
      decision = strictest(decision, proposed);
    }

    // ---- 2. Categories the profile always escalates or blocks ------------
    for (const c of categories) {
      if (profile.escalationRules.alwaysBlockCategories.includes(c)) {
        if (rank("BLOCK") > rank(decision)) {
          trace.push({
            rule: "category_block",
            detail: `${profile.name} blocks any ${c} finding outright.`,
            raisedTo: "BLOCK",
          });
        }
        decision = strictest(decision, "BLOCK");
      } else if (profile.escalationRules.alwaysEscalateCategories.includes(c)) {
        if (rank("HOLD") > rank(decision)) {
          trace.push({
            rule: "category_escalate",
            detail: `${profile.name} sends any ${c} finding to a human.`,
            raisedTo: "HOLD",
          });
        }
        decision = strictest(decision, "HOLD");
      }
    }

    // ---- 3. Overlapping risks --------------------------------------------
    // Two independent risk categories on the same response mean more together
    // than either does alone, because the failure modes compound.
    if (profile.intersectionAware) {
      for (const inter of RISK_INTERSECTIONS) {
        const [a, b] = inter.categories;
        const coOccurs = findings.some(
          (f) => f.categories.includes(a) && f.categories.includes(b))
          || (categories.includes(a) && categories.includes(b));
        if (!coOccurs) continue;

        const before = decision;
        // Overlapping risk escalates *to a human*, and stops there. Compounding
        // uncertainty is a reason to get a person involved, not a reason to
        // block outright - blocking would remove the reviewer from exactly the
        // cases that most need judgement. Only an explicit block rule or a
        // proven critical violation reaches BLOCK.
        const raised = raise(decision, inter.escalate);
        const capped = rank(raised) > rank("HOLD") ? "HOLD" : raised;
        decision = strictest(decision, capped);
        if (decision !== before) {
          intersectionsApplied.push(`${a} + ${b}`);
          trace.push({
            rule: "risk_intersection",
            detail: `${inter.explanation} (${a} + ${b})`,
            raisedTo: decision,
          });
        }
      }
    }

    // ---- 4. Consequential actions ----------------------------------------
    const limit = profile.escalationRules.humanApprovalAboveUsd;
    if (consequence.valueUsd > 0 && consequence.valueUsd >= limit) {
      if (rank("HOLD") > rank(decision)) {
        trace.push({
          rule: "action_value",
          detail: `$${consequence.valueUsd.toLocaleString()} is at or above the $${limit.toLocaleString()} human-approval threshold for ${profile.name}.`,
          raisedTo: "HOLD",
        });
      }
      decision = strictest(decision, "HOLD");
    }

    if (consequence.actionName && profile.blockedActions.includes(consequence.actionName)) {
      if (rank("BLOCK") > rank(decision)) {
        trace.push({
          rule: "blocked_action",
          detail: `${profile.name} does not permit '${consequence.actionName}'.`,
          raisedTo: "BLOCK",
        });
      }
      decision = strictest(decision, "BLOCK");
    }

    // ---- 5. Accumulated session risk -------------------------------------
    const escalateAt = profile.escalationRules.escalateAtSessionRisk;
    const sessionTriggers =
      (escalateAt === "MEDIUM" && (sessionRisk === "MEDIUM" || sessionRisk === "HIGH")) ||
      (escalateAt === "HIGH" && sessionRisk === "HIGH");

    if (sessionTriggers && decision !== "ALLOW") {
      // Session risk sharpens an existing concern; it does not manufacture one
      // out of a clean response.
      if (rank("HOLD") > rank(decision)) {
        trace.push({
          rule: "session_risk",
          detail: `Risk has accumulated to ${sessionRisk} across this conversation, and ${profile.name} escalates at ${escalateAt}.`,
          raisedTo: "HOLD",
        });
      }
      decision = strictest(decision, "HOLD");
    }

    // ---- 6. Retry exhaustion ---------------------------------------------
    if (decision === "REGENERATE" && input.attempt > input.maxAttempts) {
      const fallback: Decision =
        profile.riskTolerance === "high" ? "ANNOTATE" : "HOLD";
      trace.push({
        rule: "retry_exhausted",
        detail: `Still unresolved after ${input.attempt - 1} attempt(s); ${profile.name} falls back to ${fallback}.`,
        raisedTo: fallback,
      });
      decision = fallback;
    }

    const reason = trace.length
      ? trace[trace.length - 1].detail
      : findings.length
        ? "Findings are below every intervention threshold for this use case."
        : "No material findings.";

    return {
      decision,
      reason,
      trace,
      annotations: [...new Set(annotations)],
      categories,
      requiresHuman: decision === "HOLD",
      intersectionsApplied,
    };
  }
}

function rank(d: Decision): number {
  return ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"].indexOf(d);
}

export const governedDecisionEngine = new GovernedDecisionEngine();
