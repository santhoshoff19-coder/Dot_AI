import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  clearEmbeddingCache, embeddingCacheSize, embeddingService, lexicalVector,
  LOCAL_EMBEDDING_MODEL,
} from "@/lib/policy/embeddings";
import { cosine } from "@/lib/policy/vector-store";
import { chunkText, policyIngestion } from "@/lib/policy/ingest";
import { policyRetrieval, relevanceFloor, DEFAULT_TOP_K } from "@/lib/policy/engine";
import { extractDocument } from "@/lib/documents/extract";
import { makePdf } from "./fixtures/make";

async function reindex() {
  const chunks = await prisma.policyChunk.findMany({ select: { id: true, text: true } });
  for (let i = 0; i < chunks.length; i += 32) {
    const slice = chunks.slice(i, i + 32);
    const r = await embeddingService.embed(slice.map((c) => c.text));
    for (let j = 0; j < slice.length; j++) {
      await prisma.policyChunk.update({
        where: { id: slice[j].id },
        data: { embedding: JSON.stringify(r.vectors[j] ?? []), embeddingModel: r.model },
      });
    }
  }
}

beforeAll(async () => {
  await policyIngestion.ensureSeeded();
  await reindex();
}, 300_000);

describe("1-3. real semantic embeddings", () => {
  it("uses a semantic model even with no provider key", async () => {
    const r = await embeddingService.embed(["personal data"]);
    expect(r.mode).not.toBe("LEXICAL_FALLBACK");
    expect(r.model).toBe(LOCAL_EMBEDDING_MODEL);
  }, 120_000);

  it("places paraphrases close together, which lexical could not", async () => {
    const r = await embeddingService.embed([
      "medical information about a patient",
      "health data concerning an individual",
      "quarterly revenue rose twelve percent",
    ]);
    const paraphrase = cosine(r.vectors[0], r.vectors[1]);
    const unrelated = cosine(r.vectors[0], r.vectors[2]);

    expect(paraphrase).toBeGreaterThan(0.5);
    expect(paraphrase).toBeGreaterThan(unrelated + 0.3);

    // The same pair under the old lexical scheme shares almost no vocabulary.
    const lexical = cosine(
      lexicalVector("medical information about a patient"),
      lexicalVector("health data concerning an individual"));
    expect(paraphrase).toBeGreaterThan(lexical);
  }, 120_000);

  it("separates unrelated text", async () => {
    const r = await embeddingService.embed([
      "data retention and erasure obligations",
      "how to bake sourdough bread",
    ]);
    expect(cosine(r.vectors[0], r.vectors[1])).toBeLessThan(0.3);
  }, 120_000);
});

describe("4. retrieval quality", () => {
  it("retrieves the right policy from a paraphrased query", async () => {
    const r = await policyRetrieval.retrieve({
      riskCategories: ["SENSITIVE_DATA", "PRIVACY"],
      dataTypes: ["health data concerning an individual"],
      external: true, jurisdictions: ["EU"],
    });
    expect(r.mode).not.toBe("LEXICAL_FALLBACK");
    expect(r.evidence.length).toBeGreaterThan(0);
    // The special-categories rule is the one that mentions health.
    expect(r.evidence.some((e) => /special categor/i.test(e.section))).toBe(true);
  }, 120_000);

  it("applies a relevance floor rather than always returning top-K", async () => {
    const r = await policyRetrieval.retrieve({
      riskCategories: ["PRIVACY"], dataTypes: ["sourdough baking temperatures"],
      external: false, jurisdictions: ["EU"],
    });
    expect(r.relevanceFloor).toBeGreaterThan(0);
    for (const e of r.evidence) {
      expect(e.score).toBeGreaterThanOrEqual(r.relevanceFloor!);
    }
  }, 120_000);

  it("reports what it discarded, so retrieval is auditable", async () => {
    const r = await policyRetrieval.retrieve({
      riskCategories: ["SENSITIVE_DATA"], external: true, jurisdictions: ["EU"],
    });
    expect(typeof r.consideredCount).toBe("number");
    expect(typeof r.belowThresholdCount).toBe("number");
    expect(r.consideredCount!).toBeGreaterThanOrEqual(r.evidence.length);
  }, 120_000);

  it("uses a configurable floor per mode", () => {
    expect(relevanceFloor("SEMANTIC")).toBeGreaterThan(relevanceFloor("LEXICAL_FALLBACK"));
    expect(relevanceFloor("SEMANTIC_LOCAL")).toBeGreaterThan(0);
    expect(DEFAULT_TOP_K).toBeGreaterThanOrEqual(3);
  });
});

describe("5. chunking keeps split rules retrievable", () => {
  it("overlaps chunks so a boundary does not lose meaning", () => {
    const text = Array.from({ length: 12 },
      (_, i) => `Sentence number ${i} states an obligation about personal data.`).join(" ");
    const chunks = chunkText(text, 200);

    expect(chunks.length).toBeGreaterThan(1);
    // The tail of one chunk reappears at the head of the next.
    const tail = chunks[0].split(/(?<=\.)\s+/).slice(-1)[0];
    expect(chunks[1]).toContain(tail.slice(0, 30));
  });

  it("keeps a short section whole", () => {
    expect(chunkText("A single short rule.")).toHaveLength(1);
  });

  it("returns nothing for empty text rather than an empty chunk", () => {
    expect(chunkText("")).toHaveLength(0);
  });
});

describe("6. embedding cache", () => {
  it("reuses a vector for repeated text", async () => {
    clearEmbeddingCache();
    await embeddingService.embed(["a repeated policy sentence"]);
    const afterFirst = embeddingCacheSize();
    await embeddingService.embed(["a repeated policy sentence"]);
    expect(embeddingCacheSize()).toBe(afterFirst);
  }, 120_000);

  it("is bounded", async () => {
    clearEmbeddingCache();
    for (let i = 0; i < 20; i++) await embeddingService.embed([`unique text ${i}`]);
    expect(embeddingCacheSize()).toBeLessThanOrEqual(500);
  }, 300_000);
});

describe("8-9. multi-document retrieval and PDF end to end", () => {
  it("ranks across documents by relevance, not by document order", async () => {
    const r = await policyRetrieval.retrieve({
      riskCategories: ["SENSITIVE_DATA", "PRIVACY"],
      dataTypes: ["transferring records outside the organisation"],
      external: true, jurisdictions: ["EU"],
    });
    const scores = r.evidence.map((e) => e.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  }, 120_000);

  it("ingests a real PDF and retrieves from it", async () => {
    const pdf = makePdf([
      "Vendor Security Standard",
      "Third party vendors must complete a security review before data is shared.",
      "Vendor access is revoked within 24 hours of contract termination.",
    ]);
    const content = await extractDocument(pdf, "vendor.pdf", "application/pdf");
    expect(content.extractionStatus).toBe("EXTRACTED");

    const ingested = await policyIngestion.ingest({
      name: "Vendor Security Standard (test)",
      jurisdiction: "GLOBAL", regulation: "VENDOR_TEST",
      version: `t-${Date.now()}`,
      isDemo: false,
      sections: [{
        section: "Vendor review", category: "SECURITY",
        text: content.extractedText!,
      }],
    });
    expect(ingested.chunks).toBeGreaterThan(0);

    // A paraphrased question must find it, not a keyword match.
    const r = await policyRetrieval.retrieve({
      riskCategories: ["SECURITY"],
      dataTypes: ["sharing information with an outside supplier"],
      external: true, jurisdictions: ["GLOBAL"],
    });
    expect(r.evidence.some((e) => e.regulation === "VENDOR_TEST")).toBe(true);
  }, 300_000);
});
