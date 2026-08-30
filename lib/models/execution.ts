import { prisma } from "@/lib/db";
import { getOpenRouterKey } from "@/lib/credentials/store";
import { isMockMode } from "@/lib/providers";

export const EXECUTION_CHECK_VERSION = "v1";

/** How long a validated result is trusted before it is re-checked. */
const FRESHNESS_MS = Number(process.env.EXECUTION_CHECK_TTL_MS ?? 30 * 60 * 1000);
/** Minimum attempts before observed health can disqualify a model. */
export const MIN_HEALTH_SAMPLES = Number(process.env.MIN_HEALTH_SAMPLES ?? 5);
/** Success rate below which a model is treated as unhealthy. */
const UNHEALTHY_BELOW = Number(process.env.UNHEALTHY_BELOW ?? 0.5);

/**
 * Execution status, ordered from "never checked" to "proven".
 *
 * The distinction that matters: METADATA_COMPATIBLE means the catalog says a
 * model *should* work, EXECUTION_VERIFIED means dotAI has actually seen it
 * work. Metadata is a claim; only a real call is evidence.
 */
export type ExecutionStatus =
  | "UNKNOWN"
  | "METADATA_COMPATIBLE"
  | "EXECUTION_VERIFIED"
  | "UNAVAILABLE"
  | "FAILED"
  | "TEMPORARILY_UNAVAILABLE"
  | "UNSUPPORTED";

/** Statuses a model may be recommended under. */
export const RECOMMENDABLE_STATUSES: ExecutionStatus[] = [
  "METADATA_COMPATIBLE", "EXECUTION_VERIFIED",
];

/** True only when a real provider call has succeeded for this modality. */
export function isVerified(status: ExecutionStatus): boolean {
  return status === "EXECUTION_VERIFIED";
}

export type FailureReason =
  | "MODEL_NOT_FOUND" | "MODEL_INACTIVE" | "PROVIDER_UNAVAILABLE"
  | "MODALITY_UNSUPPORTED" | "ENDPOINT_UNSUPPORTED" | "INVALID_REQUEST"
  | "AUTHENTICATION_ERROR" | "RATE_LIMIT" | "TIMEOUT" | "PROVIDER_ERROR"
  | "GENERATION_FAILED" | "UNKNOWN_ERROR";

/** Failures that say nothing about the model itself and must never persist. */
const TRANSIENT: FailureReason[] = [
  "PROVIDER_UNAVAILABLE", "RATE_LIMIT", "TIMEOUT", "PROVIDER_ERROR",
];

export type Modality = "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "EMBEDDING";

/**
 * The modalities dotAI actually has a working provider adapter for. Anything
 * else is honestly reported as unsupported rather than recommended and then
 * failing at generation time.
 */
const ADAPTERS: Record<Modality, { endpoint: string; implemented: boolean }> = {
  TEXT: { endpoint: "chat", implemented: true },
  IMAGE: { endpoint: "images", implemented: true },
  AUDIO: { endpoint: "chat", implemented: false },
  VIDEO: { endpoint: "videos", implemented: false },
  EMBEDDING: { endpoint: "embeddings", implemented: false },
};

/**
 * A cached execution result is only trusted while the underlying provider
 * metadata is unchanged. Pricing, modality or parameter changes invalidate it.
 */
export function metadataFingerprint(m: {
  contextLength: number; inputPrice: number; outputPrice: number;
  supportedParameters: string; catalogEndpoints: string; active: boolean;
}): string {
  return [
    m.active ? "1" : "0", m.contextLength, m.inputPrice, m.outputPrice,
    m.supportedParameters.length, m.catalogEndpoints,
  ].join("|");
}

export interface ValidationResult {
  modelId: string;
  modality: Modality;
  status: ExecutionStatus;
  executable: boolean;
  failureReason?: FailureReason;
  message: string;
  /** Which stage of the hierarchy settled it. */
  stage: "local" | "catalog" | "adapter" | "health" | "cache" | "probe";
  /** What this validation cost. Metadata-only checks are free. */
  probeCostUsd?: number;
  health?: { attempts: number; successes: number; rate: number | null };
}

/**
 * ModelExecutionService.
 *
 * Capability answers "could this model do the task". This answers "can dotAI
 * actually run it right now". A model that is CAPABLE but not EXECUTABLE must
 * never be recommended.
 *
 * Validation is cost-conscious and stops at the first decisive stage:
 *   local metadata -> catalog endpoint -> adapter -> health -> cheap probe
 * A live probe only ever runs when a key exists and nothing cheaper decided.
 */
export class ModelExecutionService {
  async validateModel(openrouterModelId: string, modality: Modality): Promise<ValidationResult> {
    const base = { modelId: openrouterModelId, modality };

    // ---- 1. LOCAL METADATA ------------------------------------------------
    const model = await prisma.model.findUnique({
      where: { openrouterModelId },
      include: { capability: true, modalities: true },
    });

    if (!model) {
      return this.persist({
        ...base, status: "UNAVAILABLE", executable: false,
        failureReason: "MODEL_NOT_FOUND", stage: "local",
        message: "Model is not present in the catalog.",
      });
    }
    if (!model.active) {
      return this.persist({
        ...base, status: "UNAVAILABLE", executable: false,
        failureReason: "MODEL_INACTIVE", stage: "local",
        message: "Model is no longer listed by OpenRouter.",
      });
    }

    const outputs = model.modalities
      .filter((m) => m.direction === "OUTPUT")
      .map((m) => m.modality);
    if (!outputs.includes(modality)) {
      return this.persist({
        ...base, status: "UNSUPPORTED", executable: false,
        failureReason: "MODALITY_UNSUPPORTED", stage: "local",
        message: `Model does not produce ${modality.toLowerCase()} output.`,
      });
    }

    // ---- 2. CATALOG ENDPOINT ---------------------------------------------
    const adapter = ADAPTERS[modality];
    const endpoints = safeList(model.catalogEndpoints);

    // Image models predating the dedicated API are still reachable through
    // chat/completions with a modalities parameter, so either endpoint counts.
    const endpointOk =
      endpoints.includes(adapter.endpoint) ||
      (modality === "IMAGE" && endpoints.includes("chat")) ||
      (modality === "TEXT" && endpoints.includes("chat"));

    if (!endpointOk) {
      return this.persist({
        ...base, status: "UNSUPPORTED", executable: false,
        failureReason: "ENDPOINT_UNSUPPORTED", stage: "catalog",
        message: `OpenRouter does not expose this model on the ${adapter.endpoint} endpoint.`,
      });
    }

    // ---- 3. ADAPTER -------------------------------------------------------
    if (!adapter.implemented) {
      return this.persist({
        ...base, status: "UNSUPPORTED", executable: false,
        failureReason: "ENDPOINT_UNSUPPORTED", stage: "adapter",
        message: `dotAI has no ${modality.toLowerCase()} generation adapter yet.`,
      });
    }

    // ---- 4. OBSERVED HEALTH ----------------------------------------------
    const existing = await prisma.modelExecutionStatus.findUnique({
      where: { modelId_modality: { modelId: model.id, modality } },
    });

    if (existing && existing.attempts >= MIN_HEALTH_SAMPLES) {
      const rate = existing.successes / existing.attempts;
      if (rate < UNHEALTHY_BELOW) {
        return this.persist({
          ...base, status: "TEMPORARILY_UNAVAILABLE", executable: false,
          failureReason: "PROVIDER_ERROR", stage: "health",
          message: `Observed ${existing.successes}/${existing.attempts} successful executions.`,
          health: { attempts: existing.attempts, successes: existing.successes, rate },
        });
      }
    }

    // A cached result is trusted only while it is recent, produced by the
    // current check version, and based on unchanged provider metadata.
    const fingerprint = metadataFingerprint(model);
    const fresh = existing &&
      Date.now() - existing.lastCheckedAt.getTime() < FRESHNESS_MS &&
      RECOMMENDABLE_STATUSES.includes(existing.status as ExecutionStatus) &&
      existing.checkVersion === EXECUTION_CHECK_VERSION &&
      existing.metadataFingerprint === fingerprint;

    if (fresh) {
      return {
        ...base,
        status: existing.status as ExecutionStatus,
        executable: true,
        stage: "cache",
        message: existing.status === "EXECUTION_VERIFIED"
          ? "Previously executed successfully; cache still valid."
          : "Compatible per catalog metadata; cache still valid. Execution is " +
            "unverified - no live call has proven it.",
      };
    }

    // ---- 5. CHEAP PROBE (only with a real key) ---------------------------
    // Without credentials dotAI cannot prove executability, so it says so
    // rather than asserting a model works.
    if (isMockMode() || !(await getOpenRouterKey())) {
      // No credentials, so no live probe is possible. The model is compatible
      // on paper and may be recommended, but dotAI has not seen it run and
      // says so rather than claiming availability it cannot demonstrate.
      return this.persist({
        ...base, status: "METADATA_COMPATIBLE", executable: true, stage: "catalog",
        message:
          "Compatible per catalog metadata. No live execution probe has run, " +
          "so execution is unverified.",
      });
    }

    return this.probe(model.id, openrouterModelId, modality);
  }

  /**
   * A minimal live request. Deliberately tiny, and only ever reached when the
   * cheaper stages could not decide.
   */
  private async probe(
    rowId: string, openrouterModelId: string, modality: Modality,
  ): Promise<ValidationResult> {
    const base = { modelId: openrouterModelId, modality };
    const key = await getOpenRouterKey();
    if (!key) {
      return this.persist({
        ...base, status: "UNKNOWN", executable: false,
        failureReason: "AUTHENTICATION_ERROR", stage: "probe",
        message: "No OpenRouter key is connected.",
      });
    }

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "dotAI",
        },
        body: JSON.stringify({
          model: openrouterModelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          ...(modality === "IMAGE" ? { modalities: ["image", "text"] } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          usage?: { total_cost?: number; cost?: number };
        };
        const cost = json.usage?.total_cost ?? json.usage?.cost ?? 0;
        return this.persist({
          ...base, status: "EXECUTION_VERIFIED", executable: true, stage: "probe",
          message: "Live probe succeeded against the provider.", probeCostUsd: cost,
        });
      }

      const reason = this.classifyHttp(res.status);
      return this.persist({
        ...base,
        status: TRANSIENT.includes(reason) ? "TEMPORARILY_UNAVAILABLE" : "UNAVAILABLE",
        executable: false, failureReason: reason, stage: "probe",
        message: `Probe returned ${res.status}.`,
      });
    } catch (err) {
      const timedOut = err instanceof Error && /abort|timeout/i.test(err.message);
      return this.persist({
        ...base, status: "TEMPORARILY_UNAVAILABLE", executable: false,
        failureReason: timedOut ? "TIMEOUT" : "PROVIDER_UNAVAILABLE", stage: "probe",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  classifyHttp(status: number): FailureReason {
    if (status === 404) return "MODEL_NOT_FOUND";
    if (status === 401 || status === 403) return "AUTHENTICATION_ERROR";
    if (status === 429) return "RATE_LIMIT";
    if (status === 400 || status === 422) return "INVALID_REQUEST";
    if (status === 408 || status === 504) return "TIMEOUT";
    if (status >= 500) return "PROVIDER_UNAVAILABLE";
    return "UNKNOWN_ERROR";
  }

  /**
   * Validates a batch and returns only the executable ones, in the order given.
   * Used to filter candidates before they are ever shown as recommendations.
   */
  async filterExecutable<T extends { modelId: string }>(
    candidates: T[], modality: Modality, limit = 3,
  ): Promise<{ valid: (T & { validation: ValidationResult })[]; rejected: ValidationResult[] }> {
    const valid: (T & { validation: ValidationResult })[] = [];
    const rejected: ValidationResult[] = [];

    for (const c of candidates) {
      if (valid.length >= limit) break;
      const v = await this.validateModel(c.modelId, modality);
      if (v.executable) valid.push({ ...c, validation: v });
      else rejected.push(v);
    }
    return { valid, rejected };
  }

  /**
   * Records the real outcome of a generation attempt.
   *
   * This is execution health, kept strictly separate from capability: a
   * provider timeout must never be read as the model reasoning badly.
   */
  async recordExecution(
    openrouterModelId: string,
    modality: Modality,
    success: boolean,
    failureReason?: FailureReason,
    failureMessage?: string,
    requestId?: string,
    /**
     * True when the "execution" was produced by the mock provider. A simulated
     * run is not evidence that the model works, so it never earns
     * EXECUTION_VERIFIED - that status must mean a real provider answered.
     */
    simulated = isMockMode(),
  ): Promise<void> {
    try {
      await prisma.modelExecutionEvent.create({
        data: {
          openrouterModelId, modality, success,
          failureReason: failureReason ?? null,
          failureMessage: failureMessage?.slice(0, 500) ?? null,
          requestId: requestId ?? null,
        },
      });

      const model = await prisma.model.findUnique({ where: { openrouterModelId } });
      if (!model) return;

      const existing = await prisma.modelExecutionStatus.findUnique({
        where: { modelId_modality: { modelId: model.id, modality } },
      });

      // A transient provider failure never latches a model to UNAVAILABLE.
      const status: ExecutionStatus = success
        ? (simulated ? "METADATA_COMPATIBLE" : "EXECUTION_VERIFIED")
        : failureReason && TRANSIENT.includes(failureReason)
          ? "TEMPORARILY_UNAVAILABLE"
          : failureReason === "MODALITY_UNSUPPORTED" || failureReason === "ENDPOINT_UNSUPPORTED"
            ? "UNSUPPORTED"
            : "FAILED";

      const data = {
        status,
        failureReason: success ? null : failureReason ?? "UNKNOWN_ERROR",
        failureMessage: success ? null : failureMessage?.slice(0, 500) ?? null,
        provider: model.provider,
        endpoint: ADAPTERS[modality].endpoint,
        checkVersion: EXECUTION_CHECK_VERSION,
        lastCheckedAt: new Date(),
        // Simulated runs do not count toward observed execution health.
        attempts: (existing?.attempts ?? 0) + (simulated ? 0 : 1),
        successes: (existing?.successes ?? 0) + (!simulated && success ? 1 : 0),
      };

      if (existing) {
        await prisma.modelExecutionStatus.update({ where: { id: existing.id }, data });
      } else {
        await prisma.modelExecutionStatus.create({
          data: { modelId: model.id, modality, ...data },
        });
      }
    } catch (err) {
      console.error("[execution] record failed", err);
    }
  }

  /** Manual revalidation: clears the cached result so the next check re-runs. */
  async invalidate(openrouterModelId: string, modality?: Modality): Promise<number> {
    const model = await prisma.model.findUnique({ where: { openrouterModelId } });
    if (!model) return 0;
    const res = await prisma.modelExecutionStatus.deleteMany({
      where: { modelId: model.id, ...(modality ? { modality } : {}) },
    });
    return res.count;
  }

  /** Total spent on live probes, tracked separately from generation cost. */
  async probeSpend(): Promise<{ totalUsd: number; probes: number }> {
    const rows = await prisma.modelExecutionStatus.findMany({
      select: { probeCostUsd: true, probeCount: true },
    });
    return {
      totalUsd: rows.reduce((n, r) => n + r.probeCostUsd, 0),
      probes: rows.reduce((n, r) => n + r.probeCount, 0),
    };
  }

  async getExecutionStatus(openrouterModelId: string, modality: Modality) {
    const model = await prisma.model.findUnique({ where: { openrouterModelId } });
    if (!model) return null;
    return prisma.modelExecutionStatus.findUnique({
      where: { modelId_modality: { modelId: model.id, modality } },
    });
  }

  private async persist(result: ValidationResult): Promise<ValidationResult> {
    try {
      const model = await prisma.model.findUnique({
        where: { openrouterModelId: result.modelId },
      });
      if (!model) return result;

      const existing = await prisma.modelExecutionStatus.findUnique({
        where: { modelId_modality: { modelId: model.id, modality: result.modality } },
      });

      const existingRow = await prisma.modelExecutionStatus.findUnique({
        where: { modelId_modality: { modelId: model.id, modality: result.modality } },
      });

      const data = {
        status: result.status,
        failureReason: result.failureReason ?? null,
        failureMessage: result.message.slice(0, 500),
        provider: model.provider,
        endpoint: ADAPTERS[result.modality].endpoint,
        checkVersion: EXECUTION_CHECK_VERSION,
        lastCheckedAt: new Date(),
        metadataFingerprint: metadataFingerprint(model),
        probeCostUsd: (existingRow?.probeCostUsd ?? 0) + (result.probeCostUsd ?? 0),
        probeCount: (existingRow?.probeCount ?? 0) + (result.stage === "probe" ? 1 : 0),
      };

      if (existing) {
        await prisma.modelExecutionStatus.update({ where: { id: existing.id }, data });
      } else {
        await prisma.modelExecutionStatus.create({
          data: { modelId: model.id, modality: result.modality, ...data },
        });
      }
    } catch {
      // Validation must still return even if telemetry fails.
    }
    return result;
  }
}

function safeList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export const modelExecution = new ModelExecutionService();
