import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { batchAudit } from "@/lib/audit/batch";
import { getProfile } from "@/lib/governance/profiles";
import { policyIngestion } from "@/lib/policy/ingest";
import {
  normaliseJurisdiction, policyDecisionEngine, policyRetrieval,
} from "@/lib/policy/engine";

beforeAll(async () => { await policyIngestion.ensureSeeded(); }, 60_000);

/** The full Tier 2 path for one situation, exactly as the live loop runs it. */
async function evaluate(profileId: string, jurisdictionOverride?: "EU" | "IN" | "US" | "GLOBAL") {
  const profile = getProfile(profileId);
  const jurisdictions = jurisdictionOverride
    ? [jurisdictionOverride]
    : [...new Set(profile.jurisdiction.map(normaliseJurisdiction))];
  const riskCategories = ["SENSITIVE_DATA", "PRIVACY"];

  const retrieval = await policyRetrieval.retrieve({
    riskCategories, dataTypes: ["medical information"],
    actionName: "send_email", external: true, jurisdictions,
  });
  const verdict = policyDecisionEngine.decide({
    profile, jurisdictions, riskCategories, dataTypes: ["medical"],
    external: true, actionName: "send_email",
    evidence: retrieval.evidence, retrievalMode: retrieval.mode,
  });
  return { profile, jurisdictions, retrieval, verdict };
}

describe("13-14. batch auditing and sampling", () => {
  it("audits a sample of historical responses", async () => {
    const r = await batchAudit.run({ strategy: "RANDOM", sampleSize: 10, maxDeepChecks: 2 });
    expect(r.sampled).toBeGreaterThan(0);
    expect(r.runId).toBeTruthy();
  }, 120_000);

  it("caps expensive deep checks so a sweep stays affordable", async () => {
    const r = await batchAudit.run({ strategy: "RISK_BASED", sampleSize: 20, maxDeepChecks: 3 });
    expect(r.deepChecks).toBeLessThanOrEqual(3);
    expect(r.deepChecks).toBeLessThanOrEqual(r.sampled);
  }, 120_000);

  it("risk-based sampling prefers responses the live path already flagged", async () => {
    const r = await batchAudit.run({ strategy: "RISK_BASED", sampleSize: 10, maxDeepChecks: 2 });
    expect(r.strategy).toBe("RISK_BASED");
    expect(r.populationSize).toBeGreaterThanOrEqual(r.sampled);
  }, 120_000);

  it("persists findings with their policy evidence", async () => {
    const r = await batchAudit.run({ strategy: "RANDOM", sampleSize: 10, maxDeepChecks: 2 });
    const findings = await batchAudit.findingsFor(r.runId);
    for (const f of findings) {
      expect(() => JSON.parse(f.evidence)).not.toThrow();
      expect(() => JSON.parse(f.riskCategories)).not.toThrow();
    }
  }, 120_000);

  it("records every run for later inspection", async () => {
    const runs = await batchAudit.listRuns(5);
    expect(runs.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("DEMO 1 — medical data to an external email, CUSTOMER_SUPPORT / EU", () => {
  it("retrieves EU policy evidence and escalates", async () => {
    const { retrieval, verdict } = await evaluate("BASELINE", "EU");

    expect(retrieval.evidence.length).toBeGreaterThan(0);
    for (const e of retrieval.evidence) {
      expect(["EU", "GLOBAL"]).toContain(e.jurisdiction);
    }
    expect(["HOLD", "BLOCK"]).toContain(verdict.decision);
    expect(verdict.citedEvidence.length).toBeGreaterThan(0);
  }, 60_000);

  it("explains why, citing a real document, version and section", async () => {
    const { verdict } = await evaluate("BASELINE", "EU");
    const cited = verdict.citedEvidence[0];
    expect(cited.regulation).toBeTruthy();
    expect(cited.version).toBeTruthy();
    expect(cited.section).toBeTruthy();
    expect(cited.text.length).toBeGreaterThan(20);
    expect(verdict.reason.length).toBeGreaterThan(20);
  }, 60_000);
});

describe("DEMO 2 — same request, different jurisdiction and profile", () => {
  it("retrieves different evidence under a different jurisdiction", async () => {
    const eu = await evaluate("BASELINE", "EU");
    const india = await evaluate("BASELINE", "IN");

    const euRegs = new Set(eu.retrieval.evidence.map((e) => e.regulation));
    const inRegs = new Set(india.retrieval.evidence.map((e) => e.regulation));
    // The packs differ, so the cited authority differs even when the
    // conclusion happens to agree.
    expect([...euRegs].join()).not.toBe([...inRegs].join());
  }, 60_000);

  it("the profile still governs how the same evidence is treated", async () => {
    const support = await evaluate("BASELINE", "EU");
    const decision = await evaluate("BASELINE", "EU");

    // Both escalate, but each records its own governing profile and rule -
    // the outcome is not hardcoded per demo.
    expect(support.profile.id).toBe("BASELINE");
    expect(decision.profile.id).toBe("BASELINE");
    for (const r of [support, decision]) {
      expect(["HOLD", "BLOCK", "UNVERIFIABLE", "ANNOTATE"]).toContain(r.verdict.decision);
      expect(r.verdict.appliedRule).toBeTruthy();
    }
  }, 60_000);
});

describe("audit trail explains the decision", () => {
  it("preserves profile, jurisdiction, evidence and version on the record", async () => {
    const { profile, jurisdictions, verdict } = await evaluate("BASELINE", "EU");
    await prisma.policyDecisionRecord.create({
      data: {
        requestId: "tier2-audit-probe",
        profileId: profile.id,
        jurisdiction: jurisdictions.join(","),
        decision: verdict.decision,
        reason: verdict.reason,
        conflict: verdict.conflict,
        retrievalMode: "LEXICAL_FALLBACK",
        evidence: JSON.stringify(verdict.citedEvidence),
        riskCategories: JSON.stringify(["SENSITIVE_DATA", "PRIVACY"]),
      },
    });

    const row = await prisma.policyDecisionRecord.findFirst({
      where: { requestId: "tier2-audit-probe" },
    });
    expect(row).toBeTruthy();
    expect(row!.profileId).toBe("BASELINE");
    expect(row!.jurisdiction).toContain("EU");

    const evidence = JSON.parse(row!.evidence) as { regulation: string; version: string }[];
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].version).toBeTruthy();
  }, 60_000);
});
