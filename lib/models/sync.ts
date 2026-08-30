import { prisma } from "@/lib/db";
import {
  MODEL_CATEGORIES, type ModalityDirection, type ModalityKind, type ModelCategory,
} from "@/lib/capability/taxonomy";
import { getOpenRouterKey } from "@/lib/credentials/store";
import { modelAssessment } from "@/lib/models/assessment";

const TIMEOUT_MS = 30_000;

/**
 * OpenRouter exposes several catalogs. `/api/v1/models` returns only the
 * chat-completions lineup, which is why image, video and embedding models were
 * previously almost entirely missing from dotAI. Every catalog is fetched.
 */
export const CATALOG_SOURCES = [
  { endpoint: "chat", url: "https://openrouter.ai/api/v1/models" },
  { endpoint: "images", url: "https://openrouter.ai/api/v1/images/models" },
  { endpoint: "videos", url: "https://openrouter.ai/api/v1/videos/models" },
  { endpoint: "embeddings", url: "https://openrouter.ai/api/v1/embeddings/models" },
] as const;

export type CatalogEndpoint = (typeof CATALOG_SOURCES)[number]["endpoint"];

const ENDPOINT_DEFAULT_OUTPUT: Record<CatalogEndpoint, ModalityKind> = {
  chat: "TEXT", images: "IMAGE", videos: "VIDEO", embeddings: "EMBEDDING",
};

/** The chat catalog returns an array; media catalogs return an object. */
function normaliseParams(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === "object") return Object.keys(raw as Record<string, unknown>);
  return [];
}

interface MergedModel {
  raw: ORModel;
  endpoints: Set<CatalogEndpoint>;
  inputs: Set<ModalityKind>;
  outputs: Set<ModalityKind>;
  params: Set<string>;
}

/** Shape of an OpenRouter catalog entry (only the fields we rely on). */
interface ORModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    instruct_type?: string | null;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
    request?: string;
  };
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  supported_parameters?: string[] | Record<string, unknown>;
  endpoints?: unknown[];
}

export interface SyncResult {
  status: "SUCCESS" | "FAILED" | "PARTIAL";
  fetched: number;
  created: number;
  updated: number;
  deactivated: number;
  assessed?: number;
  durationMs: number;
  error?: string;
  /** Per-catalog counts, so a partial failure is visible rather than hidden. */
  bySource?: Record<string, number | string>;
}

const MODALITY_MAP: Record<string, ModalityKind> = {
  text: "TEXT", image: "IMAGE", audio: "AUDIO", video: "VIDEO", file: "FILE",
  embedding: "EMBEDDING", rerank: "RERANK",
};

function normaliseModality(raw: string): ModalityKind | null {
  return MODALITY_MAP[raw.trim().toLowerCase()] ?? null;
}

/**
 * OpenRouter prices are USD per token; dotAI stores USD per 1M tokens.
 *
 * OpenRouter uses "-1" as a sentinel meaning "price varies / unknown" on its
 * router models. Multiplying that through produced -$1,000,000, which both
 * displayed as nonsense and made those models look like the cheapest option
 * in cost ranking. A sentinel is now reported as unknown, never as a price.
 */
export const PRICE_UNKNOWN = -1;

export function perMillion(raw: string | undefined): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return PRICE_UNKNOWN;
  // Any negative value is a sentinel, not a real price.
  if (n < 0) return PRICE_UNKNOWN;
  return n * 1_000_000;
}

/** True when a stored price is a real, usable number. */
export function hasKnownPrice(price: number): boolean {
  return Number.isFinite(price) && price >= 0;
}

/**
 * Categories are derived from the modality pairing, not guessed from the name.
 * A model that takes text and emits an image is an IMAGE model; one that takes
 * an image and emits text is a TEXT model with vision input.
 */
export function deriveCategories(
  inputs: ModalityKind[], outputs: ModalityKind[],
): ModelCategory[] {
  const cats = new Set<ModelCategory>();
  if (outputs.includes("TEXT")) cats.add("TEXT");
  if (outputs.includes("IMAGE")) cats.add("IMAGE");
  if (outputs.includes("VIDEO")) cats.add("VIDEO");
  if (outputs.includes("EMBEDDING")) cats.add("EMBEDDINGS");
  if (outputs.includes("RERANK")) cats.add("RERANK");
  if (outputs.includes("AUDIO")) { cats.add("AUDIO"); cats.add("SPEECH"); }
  if (inputs.includes("AUDIO") && outputs.includes("TEXT")) cats.add("TRANSCRIPTION");
  if (cats.size === 0) cats.add("TEXT");
  return [...cats].filter((c) => MODEL_CATEGORIES.includes(c));
}

function latencyClassFor(modelId: string): "fast" | "balanced" | "slow" {
  const id = modelId.toLowerCase();
  if (/mini|flash|haiku|small|lite|8b|7b|nano/.test(id)) return "fast";
  if (/o1|o3|opus|thinking|reasoner|405b|70b/.test(id)) return "slow";
  return "balanced";
}

export class ModelCatalogSyncService {
  /**
   * Pulls the OpenRouter catalog and reconciles it into the local database.
   *
   * Guarantees:
   *  - dotAI capability profiles, outcomes and revisions are never touched.
   *  - Models that disappear are deactivated, not deleted, so history survives.
   *  - A failure here can never break routing; the existing catalog stands.
   */
  async sync(): Promise<SyncResult> {
    const started = Date.now();
    let fetched = 0, created = 0, updated = 0, deactivated = 0;

    const bySource: Record<string, number | string> = {};

    try {
      const merged = new Map<string, MergedModel>();
      let anySucceeded = false;

      for (const source of CATALOG_SOURCES) {
        try {
          const models = await this.fetchCatalog(source.url);
          bySource[source.endpoint] = models.length;
          anySucceeded = true;

          for (const m of models) {
            if (!m.id) continue;
            const entry = merged.get(m.id) ?? {
              raw: m,
              endpoints: new Set<CatalogEndpoint>(),
              inputs: new Set<ModalityKind>(),
              outputs: new Set<ModalityKind>(),
              params: new Set<string>(),
            };
            entry.endpoints.add(source.endpoint);

            // Later catalogs enrich rather than replace: the chat catalog
            // carries pricing, the media catalogs carry modality detail.
            if (!entry.raw.pricing && m.pricing) entry.raw.pricing = m.pricing;
            if (!entry.raw.context_length && m.context_length) entry.raw.context_length = m.context_length;
            if (!entry.raw.description && m.description) entry.raw.description = m.description;

            for (const i of m.architecture?.input_modalities ?? ["text"]) {
              const n = normaliseModality(i);
              if (n) entry.inputs.add(n);
            }
            for (const o of m.architecture?.output_modalities ?? []) {
              const n = normaliseModality(o);
              if (n) entry.outputs.add(n);
            }
            if (entry.outputs.size === 0) entry.outputs.add(ENDPOINT_DEFAULT_OUTPUT[source.endpoint]);
            for (const prm of normaliseParams(m.supported_parameters)) entry.params.add(prm);

            merged.set(m.id, entry);
          }
        } catch (err) {
          // One catalog failing must not lose the others.
          bySource[source.endpoint] = `failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (!anySucceeded) throw new Error("No OpenRouter catalog could be reached.");
      fetched = merged.size;

      const seen = new Set<string>();

      for (const [id, entry] of merged) {
        seen.add(id);
        const m = entry.raw;
        const inputs = [...entry.inputs];
        const outputs = [...entry.outputs];

        const data = {
          name: m.name ?? id,
          provider: id.split("/")[0] ?? "unknown",
          architecture: m.architecture?.modality ?? null,
          description: (m.description ?? "").slice(0, 1000) || null,
          contextLength: m.context_length ?? m.top_provider?.context_length ?? 0,
          inputPrice: perMillion(m.pricing?.prompt),
          outputPrice: perMillion(m.pricing?.completion),
          pricingKnown: hasKnownPrice(perMillion(m.pricing?.prompt)) &&
            hasKnownPrice(perMillion(m.pricing?.completion)),
          imagePrice: perMillion(m.pricing?.image),
          requestPrice: Number(m.pricing?.request ?? 0),
          supportedParameters: JSON.stringify([...entry.params]),
          catalogEndpoints: JSON.stringify([...entry.endpoints]),
          latencyClass: latencyClassFor(id),
          active: true,
          source: "OPENROUTER",
          lastSeenAt: new Date(),
          lastSyncedAt: new Date(),
        };

        const existing = await prisma.model.findUnique({ where: { openrouterModelId: id } });

        const row = existing
          ? await prisma.model.update({ where: { id: existing.id }, data })
          : await prisma.model.create({ data: { ...data, openrouterModelId: id } });

        if (existing) updated++; else created++;

        await this.replaceModalities(row.id, inputs, outputs);
        await this.replaceCategories(row.id, deriveCategories(inputs, outputs));

        if (!existing) {
          // A new model enters the assessment queue. It is visible immediately
          // but stays out of automatic recommendation until assessed.
          const outs = outputs.filter((o) => o !== "FILE");
          await prisma.modelCapability.create({
            data: {
              modelId: row.id,
              effort: "LOW", reasoning: "LOW", contextHandling: "LOW",
              instructionComplexity: "LOW", reliability: "LOW", toolCapability: "NONE",
              outputCapabilities: JSON.stringify(outs.length ? outs : ["TEXT"]),
              status: "ASSESSMENT_PENDING",
              assessmentSource: "INITIAL",
              capabilityConfidence: 0,
            },
          });
        }
      }

      // Deactivate anything the catalog no longer lists. Never delete: the
      // outcomes attached to it are still valid history.
      const stale = await prisma.model.findMany({
        where: { active: true, source: "OPENROUTER", openrouterModelId: { notIn: [...seen] } },
        select: { id: true },
      });
      if (stale.length) {
        await prisma.model.updateMany({
          where: { id: { in: stale.map((s) => s.id) } },
          data: { active: false },
        });
        deactivated = stale.length;
      }

      // Newly discovered models are assessed immediately rather than sitting
      // UNASSESSED indefinitely. This reads stored metadata only, so it costs
      // nothing and cannot fail the sync.
      let assessed = 0;
      try {
        assessed = (await modelAssessment.assessNewModels()).assessed;
      } catch (err) {
        console.error("[sync] assessment pass failed", err);
      }

      const partial = Object.values(bySource).some((v) => typeof v === "string");
      const result: SyncResult = {
        status: partial ? "PARTIAL" : "SUCCESS",
        fetched, created, updated, deactivated, assessed,
        durationMs: Date.now() - started, bySource,
      };
      await this.record(result);
      return result;
    } catch (err) {
      const result: SyncResult = {
        status: "FAILED", fetched, created, updated, deactivated,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
        bySource,
      };
      await this.record(result);
      return result;
    }
  }

  private async fetchCatalog(url: string): Promise<ORModel[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const key = await getOpenRouterKey();
      const res = await fetch(url, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${url} returned ${res.status}`);
      const json = (await res.json()) as { data?: ORModel[] };
      return json.data ?? [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async replaceModalities(
    modelId: string, inputs: ModalityKind[], outputs: ModalityKind[],
  ): Promise<void> {
    await prisma.modelModality.deleteMany({ where: { modelId } });
    const rows: { modelId: string; direction: ModalityDirection; modality: ModalityKind }[] = [
      ...inputs.map((m) => ({ modelId, direction: "INPUT" as const, modality: m })),
      ...outputs.map((m) => ({ modelId, direction: "OUTPUT" as const, modality: m })),
    ];
    if (rows.length) await prisma.modelModality.createMany({ data: rows });
  }

  private async replaceCategories(modelId: string, categories: ModelCategory[]): Promise<void> {
    await prisma.modelCategoryLink.deleteMany({ where: { modelId } });
    if (categories.length) {
      await prisma.modelCategoryLink.createMany({
        data: categories.map((category) => ({ modelId, category })),
      });
    }
  }

  private async record(result: SyncResult): Promise<void> {
    try {
      await prisma.modelSyncEvent.create({
        data: {
          status: result.status, fetched: result.fetched, created: result.created,
          updated: result.updated, deactivated: result.deactivated,
          durationMs: result.durationMs,
          error: result.error ?? (result.bySource ? JSON.stringify(result.bySource) : null),
        },
      });
    } catch {
      // Telemetry must never take the sync down.
    }
  }

  async lastSync() {
    return prisma.modelSyncEvent.findFirst({ orderBy: { createdAt: "desc" } });
  }
}

export const modelCatalogSyncService = new ModelCatalogSyncService();
