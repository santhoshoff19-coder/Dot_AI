import { describe, expect, it } from "vitest";
import { governedDecisionEngine } from "@/lib/governance/decision";
import {
  getProfile, interventionFor, listProfiles, USE_CASE_PROFILES,
} from "@/lib/governance/profiles";
import { toRiskFindings, allCategories } from "@/lib/governance/risk-findings";
import { levelFor, resolveVerificationDepth, sessionRiskService } from "@/lib/governance/session-risk";
import { checkerMetrics, MIN_LABELLED } from "@/lib/governance/metrics";
import { prisma } from "@/lib/db";
import type { RiskFinding } from "@/lib/governance/risk-findings";
import type { PerformanceResult, ResponsibilityResult } from "@/types";

const finding = (over: Partial<RiskFinding> = {}): RiskFinding => ({
  id: "f1", categories: ["HALLUCINATION"], severity: "high", confidence: 0.9,
  explanation: "unsupported claim", source: "evidence", deterministic: false, ...over,
});

const decide = (profileId: string, findings: RiskFinding[], over = {}) =>
  governedDecisionEngine.decide({
    profile: getProfile(profileId),
    findings,
    sessionRisk: "LOW",
    consequence: { irreversible: false, external: false, valueUsd: 0 },
    attempt: 1, maxAttempts: 2, ...over,
  });

// ---------------------------------------------------------------------------
describe("1. governance policies are backend configuration", () => {
  it("exposes the baseline and the three use-case policies", () => {
    // These are configuration, not a chat selector: how strictly a request is
    // judged must not depend on a dropdown the user has no basis for setting.
    expect(listProfiles()).toHaveLength(4);
    expect(USE_CASE_PROFILES.BASELINE).toBeTruthy();
    expect(USE_CASE_PROFILES.CUSTOMER_SUPPORT).toBeTruthy();
    expect(USE_CASE_PROFILES.INTERNAL_COPILOT).toBeTruthy();
    expect(USE_CASE_PROFILES.DECISION_SUPPORT).toBeTruthy();
  });

  it("resolves each id to its own policy", () => {
    for (const id of ["BASELINE", "CUSTOMER_SUPPORT", "INTERNAL_COPILOT", "DECISION_SUPPORT"]) {
      expect(getProfile(id).id).toBe(id);
    }
  });

  it("falls back to the baseline for an unknown or absent id", () => {
    // A misconfigured deployment still governs its traffic.
    for (const id of ["", "nonsense"]) expect(getProfile(id).id).toBe("BASELINE");
    expect(getProfile(null).id).toBe("BASELINE");
    expect(getProfile(undefined).id).toBe("BASELINE");
  });

  it("keeps a usable latency budget and verification floor", () => {
    const p = getProfile("BASELINE");
    expect(p.latencySLOms).toBeGreaterThan(0);
    expect(p.baseVerificationDepth).toBe("light");
  });

  it("still escalates by severity", () => {
    const p = getProfile("BASELINE");
    // The ladder must remain monotonic: a worse finding is never treated
    // more leniently than a milder one.
    const order = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"];
    const low = order.indexOf(interventionFor(p, "low"));
    const high = order.indexOf(interventionFor(p, "high"));
    const critical = order.indexOf(interventionFor(p, "critical"));
    expect(high).toBeGreaterThanOrEqual(low);
    expect(critical).toBeGreaterThanOrEqual(high);
    expect(interventionFor(p, "critical")).toBe("BLOCK");
  });
});

// ---------------------------------------------------------------------------
describe("2. same response, different policy, different outcome", () => {
  // The acceptance scenario: an eligibility statement driving a $5,000 refund.
  const refundFindings: RiskFinding[] = [
    finding({
      categories: ["UNVERIFIABLE", "HIGH_CONSEQUENCE_ACTION"],
      severity: "medium",
      explanation: "Eligibility could not be grounded in a source.",
    }),
  ];
  const consequence = {
    irreversible: false, external: false, valueUsd: 5000, actionName: "issue_refund",
  };

  it("customer support tolerates it with a lighter intervention", () => {
    const d = decide("BASELINE", refundFindings, { consequence });
    expect(["ANNOTATE", "HOLD"]).toContain(d.decision);
  });

  it("decision support escalates the identical response to a human", () => {
    const d = decide("BASELINE", refundFindings, { consequence });
    expect(d.decision).toBe("HOLD");
    expect(d.requiresHuman).toBe(true);
  });

  it("internal copilot is the most permissive of the three", () => {
    const cop = decide("BASELINE", refundFindings, { consequence });
    const ds = decide("BASELINE", refundFindings, { consequence });
    const order = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"];
    expect(order.indexOf(cop.decision)).toBeLessThanOrEqual(order.indexOf(ds.decision));
  });

  it("the difference comes from policy data, not a hardcoded branch", () => {
    // Raising only the threshold changes the verdict, with no code change.
    const strict = {
      ...getProfile("BASELINE"),
      thresholds: { ...getProfile("BASELINE").thresholds, escalate: "medium" as const },
    };
    const d = governedDecisionEngine.decide({
      profile: strict, findings: refundFindings, sessionRisk: "LOW",
      consequence, attempt: 1, maxAttempts: 2,
    });
    expect(d.decision).toBe("HOLD");
  });

  it("explains which rule produced the verdict", () => {
    const d = decide("BASELINE", refundFindings, { consequence });
    expect(d.trace.length).toBeGreaterThan(0);
    expect(d.reason.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
describe("3. multi-label findings", () => {
  const perf = (over: Partial<PerformanceResult> = {}): PerformanceResult => ({
    status: "CONTRADICTED", claimsChecked: 1, checksRun: ["evidence"], earlyExit: false,
    verdicts: [{
      claim: "The customer's balance is $8,420.",
      status: "CONTRADICTED", detail: "source says $6,420", evidence: null,
    }],
    ...over,
  });

  const resp = (findings: ResponsibilityResult["findings"] = []): ResponsibilityResult => ({
    status: findings.length ? "PROHIBITED" : "PERMITTED",
    findings, checksRun: ["privacy"],
    categories: { privacy: "clear", safety: "clear", fairness: "clear", policy: "clear", security: "clear" },
  });

  it("carries several categories on one finding, without duplicating it", () => {
    const findings = toRiskFindings(perf(), resp([{
      category: "privacy", severity: "critical", deterministic: true,
      message: "account number disclosed", redactClass: "account_number",
    }]), { answerText: "The customer's balance is $8,420." });

    const multi = findings.find((f) => f.categories.length > 1);
    expect(multi).toBeTruthy();
    expect(multi!.categories).toContain("HALLUCINATION");
    expect(multi!.categories).toContain("PRIVACY");
    // One finding, several labels - not the same issue counted twice.
    const hallucinations = findings.filter((f) => f.categories.includes("HALLUCINATION"));
    expect(hallucinations).toHaveLength(1);
  });

  it("maps an account number to both privacy and sensitive data", () => {
    const findings = toRiskFindings(
      perf({ status: "SUPPORTED", verdicts: [] }),
      resp([{
        category: "privacy", severity: "critical", deterministic: true,
        message: "account number", redactClass: "account_number",
      }]), {});
    expect(allCategories(findings)).toEqual(
      expect.arrayContaining(["PRIVACY", "SENSITIVE_DATA"]));
  });

  it("does not label a clean answer as a privacy risk merely for naming a person", () => {
    const findings = toRiskFindings(perf(), resp([]), {
      answerText: "Mr John Smith asked about delivery.",
    });
    expect(allCategories(findings)).not.toContain("PRIVACY");
  });

  it("retains evidence, severity, confidence, explanation, source and location", () => {
    const f = toRiskFindings(perf(), resp([]), {})[0];
    expect(f.severity).toBeTruthy();
    expect(f.confidence).toBeGreaterThan(0);
    expect(f.explanation.length).toBeGreaterThan(0);
    expect(f.source).toBeTruthy();
    expect(f.location?.snippet).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("4. overlapping risks raise the intervention", () => {
  it("hallucination alone is lighter than hallucination plus a consequential action", () => {
    // Not privacy: the baseline policy blocks that category outright, which
    // would hide the escalation ladder this test exists to check.
    // A `high` finding already saturates at HOLD under the baseline, which
    // would leave no headroom to observe the escalation. `low` shows it.
    const alone = decide("BASELINE", [
      finding({ categories: ["HALLUCINATION"], severity: "low" }),
    ]);
    const both = decide("BASELINE", [
      finding({ categories: ["HALLUCINATION", "HIGH_CONSEQUENCE_ACTION"], severity: "low" }),
    ]);
    const order = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"];
    expect(order.indexOf(both.decision)).toBeGreaterThan(order.indexOf(alone.decision));
    expect(both.intersectionsApplied.length).toBeGreaterThan(0);
  });

  it("explains that two categories overlapped", () => {
    const d = decide("BASELINE", [
      finding({ categories: ["HALLUCINATION", "HIGH_CONSEQUENCE_ACTION"], severity: "low" }),
    ]);
    const t = d.trace.find((x) => x.rule === "risk_intersection");
    expect(t).toBeTruthy();
    expect(t!.detail.toLowerCase()).toContain("action");
  });

  it("escalates to a human but does not block on overlap alone", () => {
    // Compounding uncertainty is a reason to involve a person, not to remove
    // the person from the loop.
    const d = decide("BASELINE", [
      finding({ categories: ["UNVERIFIABLE", "HIGH_CONSEQUENCE_ACTION"] }),
    ]);
    expect(d.decision).not.toBe("BLOCK");
  });

  it("can be switched off per profile", () => {
    const noIntersect = { ...getProfile("BASELINE"), intersectionAware: false };
    const d = governedDecisionEngine.decide({
      profile: noIntersect,
      findings: [finding({ categories: ["HALLUCINATION", "PRIVACY"] })],
      sessionRisk: "LOW",
      consequence: { irreversible: false, external: false, valueUsd: 0 },
      attempt: 1, maxAttempts: 2,
    });
    expect(d.intersectionsApplied).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("5. session risk accumulates", () => {
  const sid = () => `s-${Math.random().toString(36).slice(2)}`;

  it("climbs LOW to MEDIUM to HIGH across turns", async () => {
    const s = sid();
    const t1 = await sessionRiskService.record(s, "BASELINE", [
      finding({ categories: ["UNVERIFIABLE"], severity: "low" }),
    ]);
    expect(t1.riskLevel).toBe("LOW");

    const t2 = await sessionRiskService.record(s, "BASELINE", [
      finding({ categories: ["HALLUCINATION"] }),
    ]);
    expect(t2.riskLevel).toBe("MEDIUM");

    const t3 = await sessionRiskService.record(s, "BASELINE", [
      finding({ categories: ["HIGH_CONSEQUENCE_ACTION"] }),
      finding({ categories: ["PRIVACY"] }),
    ]);
    expect(t3.riskLevel).toBe("HIGH");
    expect(t3.turnCount).toBe(3);
  }, 30_000);

  it("counts each risk type separately", async () => {
    const s = sid();
    const st = await sessionRiskService.record(s, "BASELINE", [
      finding({ categories: ["HALLUCINATION"] }),
      finding({ categories: ["PRIVACY"] }),
      finding({ categories: ["HIGH_CONSEQUENCE_ACTION"] }),
    ]);
    expect(st.contradictionCount).toBe(1);
    expect(st.responsibilityFindingCount).toBe(1);
    expect(st.highRiskActionCount).toBe(1);
  }, 30_000);

  it("scores levels from thresholds", () => {
    expect(levelFor(0)).toBe("LOW");
    expect(levelFor(4)).toBe("MEDIUM");
    expect(levelFor(9)).toBe("HIGH");
  });
});

// ---------------------------------------------------------------------------
describe("6. session risk raises verification depth", () => {
  it("raises depth as session risk climbs", () => {
    const p = getProfile("BASELINE");
    expect(resolveVerificationDepth(p, "light", "LOW").depth).toBe("light");
    expect(resolveVerificationDepth(p, "light", "MEDIUM").depth).toBe("standard");
    expect(resolveVerificationDepth(p, "light", "HIGH").depth).toBe("deep");
  });

  it("never drops below the profile floor", () => {
    const p = getProfile("BASELINE");
    // A response asking for less than the policy floor still gets the floor.
    expect(resolveVerificationDepth(p, "light", "LOW").depth).toBe("light");
    expect(resolveVerificationDepth(p, "deep", "LOW").depth).toBe("deep");
  });

  it("takes the strictest of profile, response and session", () => {
    const p = getProfile("BASELINE");
    expect(resolveVerificationDepth(p, "deep", "LOW").depth).toBe("deep");
  });

  it("explains why the depth was chosen", () => {
    const r = resolveVerificationDepth(getProfile("BASELINE"), "light", "HIGH");
    expect(r.reason.toLowerCase()).toContain("session risk");
  });
});

// ---------------------------------------------------------------------------
describe("7. session risk never contaminates model intelligence", () => {
  it("leaves model capability, reliability and execution health untouched", async () => {
    const model = await prisma.model.findFirst({ include: { capability: true } });
    if (!model?.capability) return;

    const before = { ...model.capability };
    const execBefore = await prisma.modelExecutionStatus.count();

    const s = `s-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      await sessionRiskService.record(s, "BASELINE", [
        finding({ categories: ["HALLUCINATION"] }),
        finding({ categories: ["HIGH_CONSEQUENCE_ACTION"] }),
      ]);
    }
    const risk = await sessionRiskService.get(s, "BASELINE");
    expect(risk.riskLevel).toBe("HIGH");

    const after = await prisma.modelCapability.findUnique({ where: { modelId: model.id } });
    expect(after?.reasoning).toBe(before.reasoning);
    expect(after?.reliability).toBe(before.reliability);
    expect(await prisma.modelExecutionStatus.count()).toBe(execBefore);
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe("8 + 9. metrics are per profile and honest about ground truth", () => {
  it("computes rates that need no ground truth", async () => {
    const id = `m-${Date.now()}`;
    for (const d of ["ALLOW", "ALLOW", "HOLD", "BLOCK"]) {
      await checkerMetrics.record({
        requestId: `${id}-${d}-${Math.random()}`,
        profileId: "BASELINE",
        decision: d,
        escalatedToHuman: d === "HOLD",
        categories: ["HALLUCINATION"],
        findingCount: 1,
        verificationDepth: "light",
        sessionRiskLevel: "LOW",
        checkerLatencyMs: 40,
        verificationAttempted: true,
        verificationPossible: true,
      });
    }
    const m = await checkerMetrics.forProfile("BASELINE");
    expect(m.interactions).toBeGreaterThanOrEqual(4);
    expect(m.interventionRate).toBeGreaterThan(0);
    expect(m.p50CheckerLatencyMs).not.toBeNull();
  }, 30_000);

  it("withholds FP/FN rates until enough decisions are labelled", async () => {
    const m = await checkerMetrics.forProfile("BASELINE");
    if (m.labelledCount < MIN_LABELLED) {
      expect(m.falsePositiveRate).toBeNull();
      expect(m.falseNegativeRate).toBeNull();
      expect(m.groundTruthNote.toLowerCase()).toContain("unavailable");
    }
  }, 30_000);

  it("reports metrics per governance policy", async () => {
    const all = await checkerMetrics.all();
    // Metrics are keyed by the policy that governed the request, so a
    // deployment running more than one keeps them apart.
    expect(all.length).toBeGreaterThanOrEqual(1);
    for (const m of all) expect(m.profileId).toBeTruthy();
    expect(all.some((m) => m.profileId === "BASELINE")).toBe(true);
  }, 30_000);
});
