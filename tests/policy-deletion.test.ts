import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { policyIngestion } from "@/lib/policy/ingest";
import { policyRetrieval } from "@/lib/policy/engine";
import { retrievalDecision } from "@/lib/rag/decision";
import { GET as docGET, DELETE as docDELETE } from "@/app/api/policy/documents/[id]/route";

const UNIQUE = "zorblatt cephalopod indemnity";

async function seedPolicy(over: { isDemo?: boolean; name?: string } = {}) {
  return policyIngestion.ingest({
    name: over.name ?? `Deletion test ${Date.now()}`,
    jurisdiction: "GLOBAL",
    regulation: "DELETION_TEST",
    version: `v-${Math.random().toString(36).slice(2, 8)}`,
    isDemo: over.isDemo ?? false,
    sections: [{
      section: "Unique clause",
      category: "SECURITY",
      text: `The ${UNIQUE} clause requires written approval before any external transfer.`,
    }],
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("deletion removes the document and its indexed data", () => {
  it("hard-deletes and reports how many sections went with it", async () => {
    const seeded = await seedPolicy();
    expect(seeded.chunks).toBeGreaterThan(0);

    const result = await policyIngestion.deleteDocument(seeded.documentId);

    expect(result.deleted).toBe(true);
    expect(result.chunksRemoved).toBe(seeded.chunks);
    // The verification the API relies on: nothing left behind.
    expect(result.orphanedChunks).toBe(0);

    expect(await prisma.policyDocument.findUnique({
      where: { id: seeded.documentId } })).toBeNull();
    expect(await prisma.policyChunk.count({
      where: { documentId: seeded.documentId } })).toBe(0);
  }, 120_000);

  it("leaves no orphaned chunks or embeddings anywhere", async () => {
    const seeded = await seedPolicy();
    await policyIngestion.deleteDocument(seeded.documentId);

    const orphans = await prisma.policyChunk.count({
      where: { documentId: seeded.documentId },
    });
    expect(orphans).toBe(0);

    // No chunk anywhere may reference a document that no longer exists.
    const allChunks = await prisma.policyChunk.findMany({ select: { documentId: true } });
    const docIds = new Set(
      (await prisma.policyDocument.findMany({ select: { id: true } })).map((d) => d.id));
    for (const c of allChunks) expect(docIds.has(c.documentId)).toBe(true);
  }, 120_000);

  it("makes the deleted text unretrievable", async () => {
    const seeded = await seedPolicy();

    const before = await policyRetrieval.retrieve({
      riskCategories: ["SECURITY"], dataTypes: [UNIQUE],
      external: true, jurisdictions: ["GLOBAL"],
    });
    expect(before.evidence.some((e) => e.regulation === "DELETION_TEST")).toBe(true);

    await policyIngestion.deleteDocument(seeded.documentId);

    const after = await policyRetrieval.retrieve({
      riskCategories: ["SECURITY"], dataTypes: [UNIQUE],
      external: true, jurisdictions: ["GLOBAL"],
    });
    expect(after.evidence.some((e) => e.regulation === "DELETION_TEST")).toBe(false);
  }, 180_000);

  it("returns not-found for a document that does not exist", async () => {
    const r = await policyIngestion.deleteDocument("no-such-document");
    expect(r.deleted).toBe(false);
    expect(r.chunksRemoved).toBe(0);
  }, 60_000);
});

describe("demo policies are deletable", () => {
  it("deletes a demo pack like any other", async () => {
    const seeded = await seedPolicy({ isDemo: true, name: "Demo deletion test" });
    const doc = await prisma.policyDocument.findUnique({ where: { id: seeded.documentId } });
    expect(doc!.isDemo).toBe(true);

    const result = await policyIngestion.deleteDocument(seeded.documentId);
    expect(result.deleted).toBe(true);
    expect(result.orphanedChunks).toBe(0);
  }, 120_000);
});

describe("historical decisions survive deletion", () => {
  it("keeps recorded evidence after the cited policy is deleted", async () => {
    const seeded = await seedPolicy({ name: "Cited then deleted" });

    const record = await prisma.policyDecisionRecord.create({
      data: {
        requestId: `del-${Date.now()}`,
        profileId: "BASELINE",
        jurisdiction: "GLOBAL",
        riskCategories: JSON.stringify(["SECURITY"]),
        decision: "BLOCK",
        reason: "Cited the policy under test.",
        retrievalMode: "SEMANTIC_LOCAL",
        evidence: JSON.stringify([{
          regulation: "DELETION_TEST", version: "v1",
          section: "Unique clause", text: `The ${UNIQUE} clause.`,
        }]),
      },
    });

    await policyIngestion.deleteDocument(seeded.documentId);

    const after = await prisma.policyDecisionRecord.findUnique({ where: { id: record.id } });
    expect(after).toBeTruthy();
    // The snapshot is stored as JSON, not a foreign key, so it survives.
    expect(after!.evidence).toContain(UNIQUE);
    expect(after!.decision).toBe("BLOCK");
  }, 120_000);
});

describe("view and delete endpoints", () => {
  it("returns the document with its indexed sections", async () => {
    const seeded = await seedPolicy();
    const res = await docGET(new Request("http://localhost"), ctx(seeded.documentId));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.document.chunks.length).toBe(seeded.chunks);
    expect(body.document.chunks[0].text).toContain(UNIQUE);

    await policyIngestion.deleteDocument(seeded.documentId);
  }, 120_000);

  it("deletes over HTTP and 404s afterwards", async () => {
    const seeded = await seedPolicy();

    const del = await docDELETE(new Request("http://localhost"), ctx(seeded.documentId));
    expect(del.status).toBe(200);
    expect((await del.json()).orphanedChunks).toBe(0);

    const again = await docDELETE(new Request("http://localhost"), ctx(seeded.documentId));
    expect(again.status).toBe(404);

    const get = await docGET(new Request("http://localhost"), ctx(seeded.documentId));
    expect(get.status).toBe(404);
  }, 120_000);
});

describe("RAG AUTO / ON / OFF is unaffected", () => {
  it("still honours all three modes", () => {
    expect(retrievalDecision.decide({
      prompt: "What is our refund policy?", ragMode: "AUTO" }).shouldRetrieve).toBe(true);
    expect(retrievalDecision.decide({
      prompt: "Explain recursion simply.", ragMode: "AUTO" }).shouldRetrieve).toBe(false);
    expect(retrievalDecision.decide({
      prompt: "Explain recursion simply.", ragMode: "ON" }).forced).toBe(true);
    expect(retrievalDecision.decide({
      prompt: "What is our refund policy?", ragMode: "OFF" }).bypassed).toBe(true);
  });

  it("retrieval still works after a deletion", async () => {
    const seeded = await seedPolicy();
    await policyIngestion.deleteDocument(seeded.documentId);

    await policyIngestion.ensureSeeded();
    const r = await policyRetrieval.retrieve({
      riskCategories: ["SENSITIVE_DATA"], external: true, jurisdictions: ["EU"],
    });
    expect(r.mode).toBeTruthy();
    expect(Array.isArray(r.evidence)).toBe(true);
  }, 180_000);
});
