import { getOpenRouterKey } from "@/lib/credentials/store";

/**
 * How the retrieval that produced a result was actually performed. This is
 * surfaced on every policy decision, because "we found relevant policy" means
 * something very different depending on which of these was used.
 */
export type RetrievalMode = "SEMANTIC" | "SEMANTIC_LOCAL" | "LEXICAL_FALLBACK";

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  mode: RetrievalMode;
  costUsd: number;
}

/** Configurable, and deliberately a small embedding model - never a reasoner. */
export const EMBEDDING_MODEL =
  process.env.POLICY_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

/**
 * Local sentence-transformer used when no provider key is configured.
 *
 * This is a real semantic model running in-process, not a keyword trick: it
 * places "medical information" near "health data", which the lexical fallback
 * could never do. It costs nothing and needs no credentials.
 */
export const LOCAL_EMBEDDING_MODEL =
  process.env.LOCAL_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";

const LOCAL_DIMS = 384;

/** Loaded once and reused; the first call downloads and warms the model. */
let localPipeline: unknown | null = null;
let localFailed = false;

async function getLocalEmbedder(): Promise<((t: string) => Promise<number[]>) | null> {
  if (localFailed) return null;
  try {
    if (!localPipeline) {
      const { pipeline, env } = await import("@xenova/transformers");
      env.allowLocalModels = false;
      localPipeline = await pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL);
    }
    const pipe = localPipeline as (
      text: string, opts: { pooling: string; normalize: boolean },
    ) => Promise<{ data: Float32Array }>;

    return async (text: string) => {
      const out = await pipe(text, { pooling: "mean", normalize: true });
      return Array.from(out.data);
    };
  } catch (err) {
    // Falling back is acceptable; pretending it was semantic is not.
    console.warn("[policy] local embedding model unavailable:", err);
    localFailed = true;
    return null;
  }
}

/** Cache so repeated text is embedded once. Bounded to stay memory-safe. */
const CACHE_LIMIT = Number(process.env.EMBEDDING_CACHE_SIZE ?? 500);
const cache = new Map<string, number[]>();

function cacheKey(mode: string, text: string): string {
  return `${mode}:${text}`;
}

function cacheGet(mode: string, text: string): number[] | undefined {
  const key = cacheKey(mode, text);
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency so the working set survives eviction.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(mode: string, text: string, vector: number[]): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(cacheKey(mode, text), vector);
}

export function clearEmbeddingCache(): void {
  cache.clear();
}

export function embeddingCacheSize(): number {
  return cache.size;
}

const EMBEDDING_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
const DIMS = 256;

const STOP = new Set([
  "the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "is", "are",
  "be", "may", "must", "shall", "this", "that", "with", "by", "as", "it",
]);

function tokenise(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    .filter((t) => !STOP.has(t));
}

/** Stable string hash, so the same term always lands in the same dimension. */
function hash(term: string): number {
  let h = 2166136261;
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Deterministic hashed bag-of-words vector.
 *
 * This is NOT a semantic embedding. It matches on shared vocabulary, so
 * "personal data" and "customer information" look unrelated to it. Any result
 * produced this way is reported as LEXICAL_FALLBACK so nobody mistakes it for
 * semantic retrieval.
 */
export function lexicalVector(text: string): number[] {
  const vec = new Array<number>(DIMS).fill(0);
  const terms = tokenise(text);
  if (terms.length === 0) return vec;

  const counts = new Map<string, number>();
  for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);

  counts.forEach((count, term) => {
    // Sub-linear term weighting keeps one repeated word from dominating.
    const weight = 1 + Math.log(count);
    vec[hash(term) % DIMS] += weight;
    // A second bucket per term reduces collision damage in a small space.
    vec[hash(term + "#2") % DIMS] += weight * 0.5;
  });

  return vec;
}

export class EmbeddingService {
  /**
   * Embeds text. Uses a real embedding model when a key is configured;
   * otherwise falls back to lexical vectors and says so.
   */
  /**
   * Embeds text for indexing or search.
   *
   * `preferMode` forces a specific embedding space. Retrieval needs this
   * because a query embedded with one model cannot be compared against chunks
   * embedded with another - the vectors have different dimensions, cosine
   * similarity returns zero, and retrieval silently finds nothing. The caller
   * that knows which model the corpus was indexed with must be able to say so.
   */
  async embed(
    texts: string[],
    opts: { preferMode?: "SEMANTIC" | "SEMANTIC_LOCAL" } = {},
  ): Promise<EmbeddingResult> {
    if (opts.preferMode === "SEMANTIC_LOCAL") return this.embedLocal(texts);

    const key = await getOpenRouterKey();

    // No credentials: use the local semantic model rather than degrading
    // straight to keyword matching.
    if (!key) return this.embedLocal(texts);

    try {
      const res = await fetch(EMBEDDING_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "dotAI",
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) throw new Error(`Embedding request returned ${res.status}`);

      const json = (await res.json()) as {
        data?: { embedding?: number[] }[];
        usage?: { total_cost?: number; cost?: number };
      };
      const vectors = (json.data ?? [])
        .map((d) => d.embedding)
        .filter((v): v is number[] => Array.isArray(v));

      if (vectors.length !== texts.length) {
        throw new Error("Embedding response did not cover every input.");
      }

      return {
        vectors,
        model: EMBEDDING_MODEL,
        mode: "SEMANTIC",
        costUsd: json.usage?.total_cost ?? json.usage?.cost ?? 0,
      };
    } catch (err) {
      // Falling back is fine; pretending it was semantic is not.
      console.warn("[policy] provider embedding failed, trying local model:", err);
      return this.embedLocal(texts);
    }
  }

  /** Local semantic embeddings, with lexical as the last resort. */
  private async embedLocal(texts: string[]): Promise<EmbeddingResult> {
    const embedder = await getLocalEmbedder();

    if (!embedder) {
      return {
        vectors: texts.map((t) => cacheGet("lex", t) ?? cacheThrough("lex", t, lexicalVector(t))),
        model: "lexical-fallback",
        mode: "LEXICAL_FALLBACK",
        costUsd: 0,
      };
    }

    const vectors: number[][] = [];
    for (const text of texts) {
      const hit = cacheGet("local", text);
      if (hit) { vectors.push(hit); continue; }
      try {
        const v = await embedder(text);
        cacheSet("local", text, v);
        vectors.push(v);
      } catch {
        vectors.push(lexicalVector(text));
      }
    }

    return {
      vectors,
      model: LOCAL_EMBEDDING_MODEL,
      mode: "SEMANTIC_LOCAL",
      costUsd: 0,
    };
  }
}

function cacheThrough(mode: string, text: string, vector: number[]): number[] {
  cacheSet(mode, text, vector);
  return vector;
}

export { LOCAL_DIMS };

export const embeddingService = new EmbeddingService();
