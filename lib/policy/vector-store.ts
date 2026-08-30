import { prisma } from "@/lib/db";
import type { PolicyCategory } from "@/lib/policy/taxonomy";

export interface PolicyVector {
  chunkId: string;
  embedding: number[];
}

export interface VectorSearchFilter {
  jurisdictions?: string[];
  categories?: PolicyCategory[];
  regulation?: string;
  /**
   * Restrict the scan to chunks embedded with this model.
   *
   * Vectors from different models are not comparable — different dimensions
   * mean cosine similarity of zero — so a corpus containing more than one
   * embedding space has to be searched one space at a time.
   */
  embeddingModel?: string;
}

export interface VectorHit {
  chunkId: string;
  score: number;
}

/**
 * Minimal vector-store contract. The application depends on this, never on a
 * particular database, so pgvector or a hosted store can replace the local
 * implementation without touching the policy engine.
 */
export interface VectorStore {
  upsert(vectors: PolicyVector[]): Promise<void>;
  search(query: number[], filter: VectorSearchFilter, topK: number): Promise<VectorHit[]>;
  delete(chunkIds: string[]): Promise<void>;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * SQLite-backed store. Vectors live in the chunk row and are scanned in
 * memory after metadata filtering has already narrowed the candidate set.
 *
 * This is a deliberate prototype choice: the demo corpus is a few dozen
 * chunks, so a scan costs less than migrating the project to Postgres purely
 * for this feature. The interface is what matters for later.
 */
export class SqliteVectorStore implements VectorStore {
  async upsert(vectors: PolicyVector[]): Promise<void> {
    for (const v of vectors) {
      await prisma.policyChunk.update({
        where: { id: v.chunkId },
        data: { embedding: JSON.stringify(v.embedding) },
      });
    }
  }

  async search(
    query: number[], filter: VectorSearchFilter, topK: number,
  ): Promise<VectorHit[]> {
    // Metadata filtering happens in the database first, so semantic scoring
    // only ever runs over chunks that could legally apply.
    const candidates = await prisma.policyChunk.findMany({
      where: {
        ...(filter.jurisdictions?.length
          ? { jurisdiction: { in: filter.jurisdictions } } : {}),
        ...(filter.categories?.length ? { category: { in: filter.categories } } : {}),
        ...(filter.regulation ? { regulation: filter.regulation } : {}),
        ...(filter.embeddingModel ? { embeddingModel: filter.embeddingModel } : {}),
        document: { status: "ACTIVE" },
      },
      select: { id: true, embedding: true },
    });

    return candidates
      .map((c) => {
        let vec: number[] = [];
        try {
          const parsed = JSON.parse(c.embedding) as unknown;
          if (Array.isArray(parsed)) vec = parsed as number[];
        } catch { /* unembedded chunk scores zero */ }
        return { chunkId: c.id, score: cosine(query, vec) };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async delete(chunkIds: string[]): Promise<void> {
    await prisma.policyChunk.deleteMany({ where: { id: { in: chunkIds } } });
  }
}

export const vectorStore: VectorStore = new SqliteVectorStore();
