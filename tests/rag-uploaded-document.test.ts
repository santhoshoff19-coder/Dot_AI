import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { policyIngestion } from "@/lib/policy/ingest";
import { policyRetrieval } from "@/lib/policy/engine";
import { retrievalDecision } from "@/lib/rag/decision";
import { getProfile } from "@/lib/governance/profiles";
import { normaliseJurisdiction } from "@/lib/policy/taxonomy";

/**
 * Regression fixture for a live-demo failure: an uploaded profile document was
 * indexed successfully, yet asking about its contents produced "I don't have
 * the document".
 *
 * Two independent root causes, both covered here:
 *
 *  1. The AUTO retrieval gate had no signal for a direct reference to a
 *     document, so a question naming "the document" never triggered retrieval.
 *  2. Query and chunk were embedded with different models when credentials
 *     changed between indexing and querying. Cosine similarity across spaces of
 *     different dimensions is zero, so retrieval silently found nothing.
 */
const DOC = `PERSONAL PROFILE — DEMONSTRATION DOCUMENT
Reference: DEMO-PROFILE-REGRESSION

Name: Arun Demo
Role: Final-year Engineering Student
Location: Chennai, India

Preferred programming languages: Python and JavaScript
Preferred code editor: Neovim
Dissertation topic: Capability-based routing for enterprise language models
`;

const jurisdictions = () =>
  [...new Set(getProfile("BASELINE").jurisdiction.map(normaliseJurisdiction))];

const retrieve = (queryText: string) => policyRetrieval.retrieve({
  riskCategories: [], external: false, jurisdictions: jurisdictions(), queryText,
} as never);

describe("an uploaded document is retrievable", () => {
  beforeAll(async () => {
    await policyIngestion.ensureSeeded();
    await policyIngestion.ingestRaw(DOC, {
      name: "Regression profile",
      jurisdiction: "IN" as never,
      regulation: "REGRESSION-PROFILE",
      version: "2026-01",
      isDemo: false,
      source: "UPLOAD",
    } as never);
  }, 300_000);

  it("indexes the document with its text intact", async () => {
    const chunks = await prisma.policyChunk.findMany({
      where: { regulation: "REGRESSION-PROFILE" },
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.text.includes("Python and JavaScript"))).toBe(true);
    // An indexed chunk must record the model that embedded it, or the space it
    // belongs to cannot be determined at query time.
    expect(chunks.every((c) => c.embeddingModel !== "none")).toBe(true);
  }, 120_000);

  it("triggers retrieval for a question naming the document", () => {
    for (const prompt of [
      "What programming languages does the document say I prefer?",
      "What programming languages does the document say Arun prefers?",
    ]) {
      const d = retrievalDecision.decide({
        prompt, ragMode: "AUTO", hasAttachments: false, riskCategories: [],
      } as never);
      expect(d.shouldRetrieve, prompt).toBe(true);
      expect(d.preGeneration, prompt).toBe(true);
    }
  });

  it("retrieves the evidence for the first-person phrasing", async () => {
    const r = await retrieve("What programming languages does the document say I prefer?");
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.evidence.some((e) => e.text.includes("Python and JavaScript"))).toBe(true);
  }, 200_000);

  it("retrieves the same evidence when the person is named", async () => {
    // The user says "Arun"; the document says "Arun Demo". Semantic retrieval
    // must bridge that without an exact phrase match.
    const r = await retrieve("What programming languages does the document say Arun prefers?");
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.evidence.some((e) => e.text.includes("Python and JavaScript"))).toBe(true);
  }, 200_000);

  it("returns a citable source with the evidence", async () => {
    const r = await retrieve("What programming languages does the document say Arun prefers?");
    const hit = r.evidence.find((e) => e.text.includes("Python and JavaScript"))!;
    expect(hit.documentName).toBeTruthy();
    expect(hit.section).toBeTruthy();
    expect(hit.score).toBeGreaterThan(0);
  }, 200_000);

  it("retrieves nothing for an unrelated question", async () => {
    // The relevance floor must let retrieval return empty. Inventing evidence
    // is worse than admitting none applies.
    const r = await retrieve("What is the capital of Brazil?");
    expect(r.evidence.some((e) => e.text.includes("Python and JavaScript"))).toBe(false);
  }, 200_000);

  it("searches every embedding space present in the corpus", async () => {
    // A corpus indexed under more than one model must still be fully
    // searchable — this was the second root cause.
    const spaces = await prisma.policyChunk.groupBy({
      by: ["embeddingModel"], where: { embeddingModel: { not: "none" } },
    });
    expect(spaces.length).toBeGreaterThan(0);

    const r = await retrieve("What programming languages does the document say Arun prefers?");
    expect(r.evidence.length).toBeGreaterThan(0);
  }, 200_000);
});
