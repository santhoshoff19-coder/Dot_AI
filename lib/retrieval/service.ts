import { prisma } from "@/lib/db";
import { embeddingService } from "@/lib/policy/embeddings";
import { relevanceFloor } from "@/lib/policy/thresholds";
import { vectorStore } from "@/lib/policy/vector-store";
import type { EvidencePassage } from "@/types";

/**
 * RetrievalService abstraction: the source of truth a factual claim is
 * checked against.
 *
 * dotAI has one indexed corpus - the policy corpus - and this is how the
 * performance checker reads it. A document uploaded on the Policy page
 * therefore grounds claim verification too, instead of being visible only to
 * the policy verdict.
 */
export interface RetrievalService {
  retrieve(query: string, sources?: string[], k?: number): Promise<EvidencePassage[]>;
}

interface Doc { id: string; source: string; text: string; authoritative: boolean }

const STOP = new Set(["the", "a", "an", "is", "of", "for", "to", "and", "in", "on",
  "what", "please", "this", "that", "it", "as", "his", "her", "their", "s"]);

const tokenize = (s: string) =>
  (s.toLowerCase().match(/[a-z0-9$,.\-]+/g) ?? []).filter((t) => !STOP.has(t));

/**
 * Illustrative records, so grounding is demonstrable before anything has been
 * uploaded. A demo fixture in exactly the sense the demo policy packs are:
 * always ranked below real indexed content.
 */
const SEED: Doc[] = [
  {
    id: "core_banking/ledger",
    source: "Core banking ledger",
    text: "Account 4488-1234-5678 belongs to John Smith. The current account balance is $6,420.00 as of today, reflecting all settled transactions.",
    authoritative: true,
  },
  {
    id: "policy/data_handling",
    source: "Data handling policy",
    text: "Customer account numbers and internal identifiers must never be sent to external recipients. Support agents may view them inside internal tools only.",
    authoritative: true,
  },
  {
    id: "finance/payments",
    source: "Payments policy",
    text: "Payments above $10,000 require documented human approval before release. Vendor bank details must be verified against the supplier master record.",
    authoritative: true,
  },
  {
    id: "finance/invoice-2031",
    source: "Invoice INV-2031",
    text: "Invoice INV-2031 line items: consulting 1200, hosting 450, support 380. The invoice total is $2,030.",
    authoritative: true,
  },
];

/** Keyword-overlap scoring over the in-memory demo records. */
export class LocalRetrievalService implements RetrievalService {
  private docs: Doc[] = [...SEED];

  add(doc: Doc) { this.docs.push(doc); }

  addText(id: string, source: string, text: string, authoritative = false) {
    this.docs.push({ id, source, text, authoritative });
  }

  async retrieve(query: string, sources?: string[], k = 3): Promise<EvidencePassage[]> {
    const q = new Set(tokenize(query));
    if (q.size === 0) return [];

    const pool = sources?.length
      ? this.docs.filter((d) => sources.includes(d.id))
      : this.docs;

    const scored = pool
      .map((d) => {
        const dt = new Set(tokenize(d.text));
        let overlap = 0;
        q.forEach((t) => { if (dt.has(t)) overlap++; });
        if (overlap === 0) return null;
        let score = overlap / (Math.sqrt(q.size) * Math.pow(dt.size, 0.25));
        if (d.authoritative) score *= 1.5;
        return {
          id: d.id, source: d.source, text: d.text,
          score: Math.round(score * 1e4) / 1e4, authoritative: d.authoritative,
        } satisfies EvidencePassage;
      })
      .filter((p): p is EvidencePassage => p !== null)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, k);
  }
}

/**
 * Semantic retrieval over the indexed policy corpus - the same chunks, the
 * same embeddings and the same vector store the policy engine uses. There is
 * no second index.
 */
export class PolicyCorpusRetrievalService implements RetrievalService {
  async retrieve(query: string, _sources?: string[], k = 3): Promise<EvidencePassage[]> {
    if (!query.trim()) return [];

    try {
      const embedded = await embeddingService.embed([query]);
      // Unfiltered: a factual claim is not scoped to a jurisdiction the way a
      // governed action is, so every active indexed section is a candidate.
      const hits = await vectorStore.search(embedded.vectors[0] ?? [], {}, k * 3);

      const floor = relevanceFloor(embedded.mode);
      const kept = hits.filter((h) => h.score >= floor).slice(0, k);
      if (!kept.length) return [];

      const chunks = await prisma.policyChunk.findMany({
        where: { id: { in: kept.map((h) => h.chunkId) } },
        include: { document: true },
      });

      const scoreById = new Map(kept.map((h) => [h.chunkId, h.score]));

      return chunks
        .map((c) => ({
          id: c.id,
          source: `${c.document.name} — ${c.section}`,
          text: c.text,
          score: Math.round((scoreById.get(c.id) ?? 0) * 1e4) / 1e4,
          // A demo pack is illustrative, so it never carries the authority
          // that lets a contradiction settle deterministically.
          authoritative: !c.document.isDemo,
        } satisfies EvidencePassage))
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      // Retrieval failing must leave claims UNCERTAIN. It must never take the
      // request down, and must never read as "nothing contradicts this".
      console.error("[retrieval] policy corpus search failed", err);
      return [];
    }
  }
}

/**
 * The indexed corpus first; the demo records only fill slots it left empty.
 *
 * Real indexed content always ranks above the illustrative fixture, so an
 * uploaded document decides the verdict wherever it is relevant.
 */
export class CompositeRetrievalService implements RetrievalService {
  constructor(
    private readonly corpus: RetrievalService,
    private readonly demo: RetrievalService,
  ) {}

  async retrieve(query: string, sources?: string[], k = 3): Promise<EvidencePassage[]> {
    const indexed = await this.corpus.retrieve(query, sources, k);
    if (indexed.length >= k) return indexed;

    const fallback = await this.demo.retrieve(query, sources, k - indexed.length);
    const seen = new Set(indexed.map((p) => p.id));
    return [...indexed, ...fallback.filter((p) => !seen.has(p.id))].slice(0, k);
  }
}

export const demoRetrievalService = new LocalRetrievalService();
export const policyCorpusRetrievalService = new PolicyCorpusRetrievalService();

export const retrievalService: RetrievalService =
  new CompositeRetrievalService(policyCorpusRetrievalService, demoRetrievalService);
