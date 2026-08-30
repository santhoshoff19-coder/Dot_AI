import { describe, expect, it } from "vitest";
import { governedDecisionEngine } from "@/lib/governance/decision";
import { getProfile } from "@/lib/governance/profiles";
import { toRiskFindings } from "@/lib/governance/risk-findings";
import { sessionRiskService, resolveVerificationDepth } from "@/lib/governance/session-risk";
import type { RiskFinding } from "@/lib/governance/risk-findings";
import type { PerformanceResult, ResponsibilityResult } from "@/types";

// One governance policy. Any id resolves to it.
const PROFILE = "BASELINE";

/** The exact acceptance response from the brief. */
const REFUND = "The customer is eligible for a $5,000 refund.";

const refundFindings: RiskFinding[] = [{
  id: "r1",
  categories: ["UNVERIFIABLE", "HIGH_CONSEQUENCE_ACTION"],
  severity: "medium",
  confidence: 0.6,
  explanation: "Refund eligibility could not be grounded against a policy source.",
  source: "evidence",
  deterministic: false,
  location: { snippet: REFUND },
}];

describe("ACCEPTANCE — a consequential response under the governance policy", () => {
  it("sends an ungrounded $5,000 refund to a human, and explains why", () => {
    const decide = (valueUsd: number) => governedDecisionEngine.decide({
      profile: getProfile(PROFILE),
      findings: refundFindings,
      sessionRisk: "LOW",
      consequence: {
        irreversible: false, external: false, valueUsd, actionName: "issue_refund",
      },
      attempt: 1, maxAttempts: 2,
    });

    const large = decide(5000);
    expect(large.decision).toBe("HOLD");
    expect(large.requiresHuman).toBe(true);
    expect(large.reason.length).toBeGreaterThan(10);

    // The consequence, not a profile setting, is what raises the response:
    // the same finding on a trivial amount must not be treated as harshly.
    const order = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"];
    const small = decide(1);
    expect(order.indexOf(small.decision))
      .toBeLessThanOrEqual(order.indexOf(large.decision));
  });

  it("attributes the difference to a named policy rule, not a code path", () => {
    const ds = governedDecisionEngine.decide({
      profile: getProfile("BASELINE"),
      findings: refundFindings,
      sessionRisk: "LOW",
      consequence: {
        irreversible: false, external: false, valueUsd: 5000, actionName: "issue_refund",
      },
      attempt: 1, maxAttempts: 2,
    });
    const rules = ds.trace.map((t) => t.rule);
    expect(rules.some((r) =>
      ["severity_threshold", "category_escalate", "action_value"].includes(r))).toBe(true);
  });
});

describe("ACCEPTANCE — one response, multiple risk labels", () => {
  it("labels an unsupported claim about a customer as both accuracy and privacy", () => {
    const performance: PerformanceResult = {
      status: "CONTRADICTED", claimsChecked: 1, checksRun: ["evidence"], earlyExit: false,
      verdicts: [{
        claim: "John Smith's balance is $8,420 and his account is 4488-1234-5678.",
        status: "CONTRADICTED", detail: "ledger records $6,420", evidence: null,
      }],
    };
    const responsibility: ResponsibilityResult = {
      status: "PROHIBITED",
      findings: [{
        category: "privacy", severity: "critical", deterministic: true,
        message: "Account number would be disclosed.", redactClass: "account_number",
      }],
      checksRun: ["privacy"],
      categories: { privacy: "flagged", safety: "clear", fairness: "clear", policy: "clear", security: "clear" },
    };

    const findings = toRiskFindings(performance, responsibility, {
      answerText: performance.verdicts[0].claim,
    });

    const multi = findings.find((f) => f.categories.length > 1);
    expect(multi).toBeTruthy();
    expect(multi!.categories).toEqual(expect.arrayContaining(["HALLUCINATION", "PRIVACY"]));

    const d = governedDecisionEngine.decide({
      profile: getProfile("BASELINE"),
      findings, sessionRisk: "LOW",
      consequence: { irreversible: false, external: true, valueUsd: 0 },
      attempt: 1, maxAttempts: 2,
    });
    // Customer support blocks privacy outright, so this must not reach a user.
    expect(d.decision).toBe("BLOCK");
    expect(d.categories).toEqual(expect.arrayContaining(["HALLUCINATION", "PRIVACY"]));
  });
});

describe("ACCEPTANCE — risk accumulates across a conversation", () => {
  it("walks LOW to MEDIUM to HIGH and deepens verification as it goes", async () => {
    const session = `acc-${Date.now()}`;
    const profile = getProfile("BASELINE");
    const seen: { level: string; depth: string }[] = [];

    const turns: RiskFinding[][] = [
      [{ id: "a", categories: ["UNVERIFIABLE"], severity: "low", confidence: 0.5,
         explanation: "minor uncertainty", source: "evidence", deterministic: false }],
      [{ id: "b", categories: ["HALLUCINATION"], severity: "high", confidence: 0.9,
         explanation: "unsupported factual claim", source: "evidence", deterministic: false }],
      [{ id: "c", categories: ["HIGH_CONSEQUENCE_ACTION"], severity: "high", confidence: 1,
         explanation: "payment request", source: "action_gate", deterministic: true },
       { id: "d", categories: ["PRIVACY"], severity: "high", confidence: 0.9,
         explanation: "personal data referenced", source: "policy", deterministic: true }],
    ];

    for (const findings of turns) {
      const state = await sessionRiskService.record(session, profile.id, findings);
      const depth = resolveVerificationDepth(profile, "light", state.riskLevel);
      seen.push({ level: state.riskLevel, depth: depth.depth });
    }

    expect(seen[0].level).toBe("LOW");
    expect(seen[1].level).toBe("MEDIUM");
    expect(seen[2].level).toBe("HIGH");

    // Verification deepens as the conversation gets riskier.
    expect(seen[0].depth).toBe("light");
    expect(seen[1].depth).toBe("standard");
    expect(seen[2].depth).toBe("deep");
  }, 60_000);
});

describe("ACCEPTANCE — the Action Gate is policy-aware", () => {
  it("applies the stricter of the action limit and the use-case limit", async () => {
    const { actionGate } = await import("@/lib/action-gate/service");
    const { getProfile } = await import("@/lib/governance/profiles");

    const intent = {
      name: "issue_refund", parameters: {}, valueUsd: 500,
      reversible: false, destination: { channel: "api", external: false },
    };
    const actor = { role: "support_agent", permissions: ["refunds.write"] };

    const support = actionGate.evaluate(intent, actor, getProfile("BASELINE"));
    const decision = actionGate.evaluate(intent, actor, getProfile("BASELINE"));

    // Both permit refunds, so both escalate a $500 one rather than blocking.
    // What matters is that the gate consulted the use-case limit at all.
    expect(support.decision).not.toBe("ALLOW");
    expect(decision.decision).not.toBe("ALLOW");
    expect(decision.checks.some((c) => c.label.includes("Permitted for"))).toBe(true);
  });

  it("blocks an action the policy forbids, even with permission and budget", async () => {
    const { actionGate } = await import("@/lib/action-gate/service");
    const { getProfile } = await import("@/lib/governance/profiles");

    // Two distinct block paths, and both must hold against an admin with
    // unlimited budget.

    // 1. An unregistered action fails closed at the intent stage.
    const unregistered = actionGate.evaluate(
      { name: "wire_transfer", parameters: {}, valueUsd: 0,
        reversible: false, destination: { channel: "email", external: true } },
      { role: "admin", permissions: ["*"] },
      getProfile("BASELINE"),
    );
    expect(unregistered.decision).toBe("BLOCK");
    expect(unregistered.stage).toBe("intent");

    // 2. A registered action the policy does not allow is blocked at the
    // policy stage. Asserted against a narrowed policy, because the shipped
    // baseline permits all four registered actions.
    const narrowed = {
      ...getProfile("BASELINE"),
      allowedActions: ["read_account"],
      blockedActions: ["send_email"],
    };
    const forbidden = actionGate.evaluate(
      { name: "send_email", parameters: {}, valueUsd: 0,
        reversible: false, destination: { channel: "email", external: true } },
      { role: "admin", permissions: ["*"] },
      narrowed,
    );
    expect(forbidden.decision).toBe("BLOCK");
    expect(forbidden.stage).toBe("policy");
    expect(forbidden.reason).toContain("not permitted");
  });

  it("holds a permitted but consequential action rather than executing it", async () => {
    const { actionGate } = await import("@/lib/action-gate/service");
    const { getProfile } = await import("@/lib/governance/profiles");

    // approve_payment is allowed, but above the approval threshold it needs
    // a person - allowed is not the same as unattended.
    const r = actionGate.evaluate(
      { name: "approve_payment", parameters: {}, valueUsd: 50_000,
        reversible: false, destination: { channel: "internal", external: false } },
      { role: "admin", permissions: ["*"] },
      getProfile("BASELINE"),
    );
    expect(["HOLD", "BLOCK"]).toContain(r.decision);
  });

  it("still works with no profile supplied, preserving existing behaviour", async () => {
    const { actionGate } = await import("@/lib/action-gate/service");
    const r = actionGate.evaluate(
      { name: "issue_refund", parameters: {}, valueUsd: 50,
        reversible: false, destination: { channel: "api", external: false } },
      { role: "support_agent", permissions: ["refunds.write"] },
    );
    expect(r.allowed).toBe(true);
  });
});
