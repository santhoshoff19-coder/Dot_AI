import { beforeAll, describe, expect, it } from "vitest";
import { detectHeading, parseSections, policyIngestion } from "@/lib/policy/ingest";
import { policyRetrieval, queryAspects, statesARule } from "@/lib/policy/engine";

/**
 * Regression fixture for a demo failure: a contract-comparison question was
 * held because retrieval returned the uploaded policy's preamble instead of
 * its clauses, leaving every claim ungrounded.
 *
 * Three causes, each covered here:
 *  1. The section parser recognised only markdown and "Article/Section/Clause",
 *     so a numbered policy collapsed into one "Preamble" chunk.
 *  2. A preamble states scope, not a rule, yet was admitted as evidence.
 *  3. A multi-aspect question was embedded as one averaged vector, so one
 *     aspect filled every slot and the rest went unevidenced.
 */
const POLICY = `VENDOR CONTRACT RISK POLICY
This policy governs how vendor agreements are assessed for risk.

1. DATA OWNERSHIP AND USE
Customer data remains the property of the customer. A vendor licence to use customer data for model training is a material risk and must be escalated.

2. BREACH NOTIFICATION
Notification of a security breach within 24 hours is acceptable. Any window beyond 72 hours is a material risk.

3. SUBPROCESSORS
Engagement of subprocessors must require prior written approval. Unilateral appointment is a material risk.

4. DELETION AND RETENTION
Certified deletion within 30 days of termination is acceptable. Retention of backups beyond 90 days without certification is a material risk.

5. SECURITY AND AUDIT
An annual customer audit right is required. Absence of any audit right is a material risk.

6. LIABILITY
A liability cap below 12 months of fees, or exclusion of liability for loss of data, is a material risk.
`;

const QUERY = "Compare these two vendor contracts and explain which carries more "
  + "risk, focusing on data privacy, breach handling, vendor control over our "
  + "data, and liability.";

describe("policy documents are split into clauses", () => {
  it("recognises numbered, labelled and capitalised headings", () => {
    expect(detectHeading("1. DATA OWNERSHIP AND USE")).toContain("DATA OWNERSHIP");
    expect(detectHeading("4.2 Deletion and return")).toContain("Deletion");
    expect(detectHeading("Section 3 Subprocessors")).toContain("Subprocessors");
    expect(detectHeading("## Liability")).toBe("Liability");
    expect(detectHeading("DATA OWNERSHIP AND USE")).toBe("DATA OWNERSHIP AND USE");
  });

  it("does not split ordinary prose that begins with a number", () => {
    expect(detectHeading("30 days is the maximum retention period allowed here."))
      .toBeNull();
    expect(detectHeading("2. the vendor shall then notify the customer promptly, "
      + "including the categories of data affected.")).toBeNull();
  });

  it("splits a numbered policy into its clauses rather than one preamble", () => {
    const sections = parseSections(POLICY);
    // Previously this produced exactly one section, named "Preamble".
    expect(sections.length).toBeGreaterThanOrEqual(6);
    const names = sections.map((s) => s.section.toUpperCase()).join(" | ");
    for (const clause of ["DATA OWNERSHIP", "BREACH NOTIFICATION", "SUBPROCESSORS",
      "DELETION", "SECURITY AND AUDIT", "LIABILITY"]) {
      expect(names, clause).toContain(clause);
    }
  });
});

describe("only rule-bearing text counts as evidence", () => {
  it("accepts a clause that states a rule", () => {
    expect(statesARule("Subprocessors must require prior written approval.")).toBe(true);
    expect(statesARule("A cap below 12 months of fees is a material risk.")).toBe(true);
  });

  it("rejects a preamble that only describes scope", () => {
    expect(statesARule("This policy governs how vendor agreements are assessed for risk."))
      .toBe(false);
    expect(statesARule("VENDOR CONTRACT RISK POLICY")).toBe(false);
  });
});

describe("a multi-aspect question is searched per aspect", () => {
  it("splits the focus list into separate aspects", () => {
    const a = queryAspects(QUERY);
    expect(a).toContain(QUERY);          // the whole question is always kept
    const joined = a.join(" | ").toLowerCase();
    for (const aspect of ["data privacy", "breach handling", "liability"]) {
      expect(joined, aspect).toContain(aspect);
    }
  });

  it("leaves a single-subject question unchanged", () => {
    const a = queryAspects("What is our data retention period?");
    expect(a).toHaveLength(1);
  });
});

describe("retrieval for the contract comparison", () => {
  beforeAll(async () => {
    await policyIngestion.ensureSeeded();
    await policyIngestion.ingestRaw(POLICY, {
      name: "Vendor contract risk policy", jurisdiction: "IN" as never,
      regulation: "VENDOR-CONTRACT-RISK-TEST", version: "2026-01",
      isDemo: false, source: "UPLOAD",
    } as never);
  }, 300_000);

  const retrieve = () => policyRetrieval.retrieve({
    riskCategories: [], external: false,
    jurisdictions: ["EU", "IN", "US"], queryText: QUERY, topK: 8,
  } as never);

  it("returns clause-level evidence, not the document preamble", async () => {
    const r = await retrieve();
    expect(r.evidence.length).toBeGreaterThan(0);

    // The exact failure: the preamble ranked first and grounded nothing.
    for (const e of r.evidence) {
      expect(e.text.toLowerCase(), e.section)
        .not.toContain("this policy governs how vendor agreements");
      expect(e.section.toLowerCase()).not.toBe("preamble");
    }
  }, 300_000);

  it("covers several of the clauses the question asks about", async () => {
    const r = await retrieve();
    const sections = r.evidence.map((e) => e.section.toUpperCase()).join(" | ");
    const covered = ["DATA OWNERSHIP", "BREACH NOTIFICATION", "LIABILITY",
      "SECURITY AND AUDIT", "SUBPROCESSORS", "DELETION"]
      .filter((c) => sections.includes(c));
    // A single averaged query vector previously returned one aspect's clauses
    // and nothing for the others.
    expect(covered.length).toBeGreaterThanOrEqual(3);
  }, 300_000);

  it("carries a citable section and score on every piece of evidence", async () => {
    const r = await retrieve();
    for (const e of r.evidence) {
      expect(e.documentName).toBeTruthy();
      expect(e.section).toBeTruthy();
      expect(e.score).toBeGreaterThan(0);
      expect(e.score).toBeGreaterThanOrEqual(r.relevanceFloor ?? 0);
    }
  }, 300_000);

  it("still returns nothing for an unrelated question", async () => {
    const r = await policyRetrieval.retrieve({
      riskCategories: [], external: false, jurisdictions: ["EU", "IN", "US"],
      queryText: "What is the capital of Brazil?", topK: 8,
    } as never);
    const sections = r.evidence.map((e) => e.section.toUpperCase()).join(" | ");
    expect(sections).not.toContain("LIABILITY");
  }, 300_000);
});
