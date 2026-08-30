import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getProfile } from "@/lib/governance/profiles";
import {
  chunkText, parseSections, policyIngestion, DEMO_POLICY_PACKS,
} from "@/lib/policy/ingest";
import { lexicalVector, embeddingService } from "@/lib/policy/embeddings";
import { cosine, vectorStore } from "@/lib/policy/vector-store";
import {
  buildPolicyQuery, detectConflict, policyDecisionEngine, policyRetrieval,
  type PolicyEvidence,
} from "@/lib/policy/engine";
import { policyCategoriesFor, normaliseJurisdiction } from "@/lib/policy/taxonomy";

beforeAll(async () => { await policyIngestion.ensureSeeded(); }, 60_000);

const ev = (o: Partial<PolicyEvidence>): PolicyEvidence => ({
  chunkId: "c", documentName: "d", regulation: "GDPR", version: "demo-1.0",
  jurisdiction: "EU", section: "s", category: "DATA_TRANSFER", text: "t",
  score: 0.5, isDemo: true, retrievedAt: new Date().toISOString(), ...o,
});

describe("1-3. ingestion, chunking, embedding", () => {
  it("ingests demo packs and records them as demo, not law", async () => {
    const docs = await policyIngestion.listDocuments();
    expect(docs.length).toBeGreaterThanOrEqual(3);
    // Shipped demo packs must be marked demo. Documents a user uploads are
    // real policy and are deliberately NOT flagged demo, so only the seeded
    // packs are checked here.
    // The shipped packs are identifiable by their demo version stamp.
    const seeded = docs.filter((d) => d.version === "demo-1.0");
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    expect(seeded.every((d) => d.isDemo)).toBe(true);
  }, 30_000);

  it("splits long text into quotable chunks", () => {
    const long = "This is a sentence about policy. ".repeat(60);
    const chunks = chunkText(long, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
  });

  it("keeps a short section as a single chunk", () => {
    expect(chunkText("Short rule.")).toHaveLength(1);
  });

  it("parses markdown headings into sections", () => {
    const parsed = parseSections("# Transfers\nData must not leave.\n# Consent\nAsk first.");
    expect(parsed.map((p) => p.section)).toContain("Transfers");
    expect(parsed.map((p) => p.section)).toContain("Consent");
  });

  it("generates a vector per chunk", async () => {
    const r = await embeddingService.embed(["personal data transfer", "safety"]);
    expect(r.vectors).toHaveLength(2);
    expect(r.vectors[0].length).toBeGreaterThan(0);
  }, 30_000);

  it("marks retrieval mode honestly when no embedding provider exists", async () => {
    const r = await embeddingService.embed(["x"]);
    // Three honest modes: provider semantic, local semantic, or lexical.
    // The mode must always match the model that actually produced the vector.
    expect(["SEMANTIC", "SEMANTIC_LOCAL", "LEXICAL_FALLBACK"]).toContain(r.mode);
    if (r.model === "lexical-fallback") expect(r.mode).toBe("LEXICAL_FALLBACK");
    if (r.mode === "SEMANTIC_LOCAL") expect(r.model).toContain("MiniLM");
  }, 30_000);

  it("produces stable vectors for identical text", () => {
    expect(lexicalVector("data transfer")).toEqual(lexicalVector("data transfer"));
  });
});

describe("4. vector search", () => {
  it("scores similar text above unrelated text", () => {
    const q = lexicalVector("personal data transferred to an external recipient");
    const near = lexicalVector("personal data must not be sent to an external recipient");
    const far = lexicalVector("invoice totals arithmetic rounding");
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });

  it("returns nothing for an empty vector", async () => {
    expect(await vectorStore.search([], {}, 3)).toHaveLength(0);
  }, 30_000);
});

describe("5-7. filtering and top-K", () => {
  it("filters by jurisdiction so foreign rules are not scored", async () => {
    const r = await policyRetrieval.retrieve({
      riskCategories: ["PRIVACY", "SENSITIVE_DATA"], external: true, jurisdictions: ["IN"],
    });
    for (const e of r.evidence) {
      expect(["IN", "GLOBAL"]).toContain(e.jurisdiction);
    }
  }, 30_000);

  it("maps a risk onto only the policy categories that could govern it", () => {
    const cats = policyCategoriesFor(["SENSITIVE_DATA"]);
    expect(cats).toContain("SENSITIVE_DATA");
    expect(cats).not.toContain("SAFETY");
  });

  it("honours a configurable top-K", async () => {
    const r = await policyRetrieval.retrieve({
      riskCategories: ["PRIVACY"], external: true, jurisdictions: ["EU"], topK: 1,
    });
    expect(r.evidence.length).toBeLessThanOrEqual(1);
  }, 30_000);

  it("builds a small query from the situation, not the conversation", () => {
    const q = buildPolicyQuery({
      riskCategories: ["SENSITIVE_DATA"], dataTypes: ["medical"],
      actionName: "send_email", external: true,
    });
    expect(q).toContain("sensitive data");
    expect(q).toContain("external");
    expect(q.length).toBeLessThan(300);
  });

  it("normalises jurisdiction codes from the profile", () => {
    expect(normaliseJurisdiction("GDPR")).toBe("EU");
    expect(normaliseJurisdiction("DPDP")).toBe("IN");
    expect(normaliseJurisdiction("unknown")).toBe("GLOBAL");
  });
});

describe("8-9. evidence and policy decisions", () => {
  it("cites real retrieved sections, never invented ones", async () => {
    const r = await policyRetrieval.retrieve({
      riskCategories: ["SENSITIVE_DATA", "PRIVACY"], external: true, jurisdictions: ["EU"],
    });
    const d = policyDecisionEngine.decide({
      profile: getProfile("BASELINE"), jurisdictions: ["EU"],
      riskCategories: ["SENSITIVE_DATA", "PRIVACY"], dataTypes: [], external: true,
      evidence: r.evidence, retrievalMode: r.mode,
    });
    expect(d.citedEvidence.length).toBeGreaterThan(0);
    for (const c of d.citedEvidence) {
      expect(r.evidence.some((e) => e.chunkId === c.chunkId)).toBe(true);
    }
  }, 30_000);

  it("escalates sensitive data leaving the organisation", async () => {
    const r = await policyRetrieval.retrieve({
      riskCategories: ["SENSITIVE_DATA"], external: true, jurisdictions: ["EU"],
    });
    const d = policyDecisionEngine.decide({
      profile: getProfile("BASELINE"), jurisdictions: ["EU"],
      riskCategories: ["SENSITIVE_DATA"], dataTypes: [], external: true,
      evidence: r.evidence, retrievalMode: r.mode,
    });
    expect(["HOLD", "BLOCK"]).toContain(d.decision);
    expect(d.appliedRule).toBe("SENSITIVE_EXTERNAL_TRANSFER");
  }, 30_000);

  it("never claims legal compliance", async () => {
    const d = policyDecisionEngine.decide({
      profile: getProfile("BASELINE"), jurisdictions: ["EU"],
      riskCategories: [], dataTypes: [], external: false,
      evidence: [], retrievalMode: "SEMANTIC",
    });
    expect(d.caveat).toContain("not a legal determination");
    expect(d.caveat.toLowerCase()).not.toContain("compliant");
  });
});

describe("10-11. conflict and UNVERIFIABLE", () => {
  it("detects conflicting evidence across regulations", () => {
    const conflict = detectConflict([
      ev({ regulation: "GDPR", text: "Personal data must not be disclosed externally." }),
      ev({ regulation: "INTERNAL", text: "Account identifiers may be shown to staff." }),
    ]);
    expect(conflict).toBe(true);
  });

  it("does not call one regulation a conflict with itself", () => {
    expect(detectConflict([
      ev({ regulation: "GDPR", text: "must not be disclosed" }),
      ev({ regulation: "GDPR", text: "may be shown to staff" }),
    ])).toBe(false);
  });

  it("escalates a conflict instead of silently picking a side", () => {
    const d = policyDecisionEngine.decide({
      profile: getProfile("BASELINE"), jurisdictions: ["EU"],
      riskCategories: ["PRIVACY"], dataTypes: [], external: false,
      evidence: [
        ev({ regulation: "GDPR", text: "Personal data must not be disclosed externally." }),
        ev({ regulation: "INTERNAL", text: "Identifiers may be shown to staff." }),
      ],
      retrievalMode: "SEMANTIC",
    });
    expect(d.conflict).toBe(true);
    expect(d.appliedRule).toBe("POLICY_CONFLICT");
    expect(d.citedEvidence.length).toBeGreaterThan(1);
  });

  it("returns UNVERIFIABLE when a risk has no governing policy", () => {
    const d = policyDecisionEngine.decide({
      profile: getProfile("BASELINE"), jurisdictions: ["EU"],
      riskCategories: ["SECURITY"], dataTypes: [], external: false,
      evidence: [], retrievalMode: "SEMANTIC",
    });
    expect(d.decision).toBe("UNVERIFIABLE");
    expect(d.appliedRule).toBe("NO_APPLICABLE_POLICY");
  });

  it("treats silence as unverified, never as permission", () => {
    const d = policyDecisionEngine.decide({
      profile: getProfile("BASELINE"), jurisdictions: ["EU"],
      riskCategories: ["PRIVACY"], dataTypes: [], external: false,
      evidence: [], retrievalMode: "SEMANTIC",
    });
    expect(d.decision).not.toBe("ALLOW");
  });
});

describe("12. policy versioning", () => {
  it("supersedes an old version instead of destroying it", async () => {
    await policyIngestion.ingest({
      name: "Versioning probe v1", jurisdiction: "GLOBAL", regulation: "PROBE",
      version: "1.0", sections: [{ section: "S1", category: "PRIVACY", text: "Rule one." }],
    });
    await policyIngestion.ingest({
      name: "Versioning probe v2", jurisdiction: "GLOBAL", regulation: "PROBE",
      version: "2.0", sections: [{ section: "S1", category: "PRIVACY", text: "Rule two." }],
    });

    const all = await prisma.policyDocument.findMany({ where: { regulation: "PROBE" } });
    expect(all).toHaveLength(2);
    const v1 = all.find((d) => d.version === "1.0");
    const v2 = all.find((d) => d.version === "2.0");
    expect(v1?.status).toBe("SUPERSEDED");
    expect(v2?.status).toBe("ACTIVE");

    // The old text survives, so an old decision stays explainable.
    const oldChunks = await prisma.policyChunk.count({ where: { documentId: v1!.id } });
    expect(oldChunks).toBeGreaterThan(0);
  }, 60_000);

  it("is idempotent for the same version", async () => {
    const first = await policyIngestion.ingest(DEMO_POLICY_PACKS[0]);
    expect(first.embeddingModel).toBe("unchanged");
  }, 30_000);
});
