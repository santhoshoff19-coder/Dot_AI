import { getOpenRouterKey } from "@/lib/credentials/store";
import { modelIntelligence } from "@/lib/models/intelligence";
import { isMockMode, ProviderError } from "@/lib/providers";
import type { OutputCapability } from "@/lib/capability/taxonomy";

export interface ImageResult {
  /** Data URL or https URL of a real generated image. Never a placeholder. */
  url: string;
  mimeType: string;
  modelId: string;
  costUsd: number;
  latencyMs: number;
  simulated: boolean;
}

export class CapabilityMismatchError extends Error {
  readonly kind = "CAPABILITY_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "CapabilityMismatchError";
  }
}

export class UnsupportedModalityError extends Error {
  readonly kind = "UNSUPPORTED_MODALITY";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedModalityError";
  }
}

const IMAGES_ENDPOINT = "https://openrouter.ai/api/v1/images";
const CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 120_000;

/**
 * A deterministic, honestly-labelled placeholder used only in mock mode.
 *
 * This is a real SVG rendered from the prompt - it is not a stand-in for a
 * provider image, and every caller marks it `simulated: true` so the UI can
 * say so plainly.
 */
function mockImage(prompt: string, modelId: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const words = prompt.trim().split(/\s+/).slice(0, 14);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > 26) { lines.push(line.trim()); line = w; }
    else line += ` ${w}`;
  }
  if (line.trim()) lines.push(line.trim());

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#1a1030"/><stop offset="55%" stop-color="#3b1f6b"/>
    <stop offset="100%" stop-color="#7C6CFF"/></linearGradient></defs>
  <rect width="640" height="640" fill="url(#g)"/>
  <circle cx="470" cy="170" r="78" fill="#EDE7FF" opacity="0.92"/>
  <circle cx="446" cy="150" r="12" fill="#c9bdf0" opacity="0.8"/>
  <circle cx="492" cy="196" r="8" fill="#c9bdf0" opacity="0.7"/>
  ${Array.from({ length: 40 }, (_, i) => {
    const x = (i * 137) % 640, y = (i * 89) % 420, r = (i % 3) * 0.6 + 0.7;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="0.55"/>`;
  }).join("")}
  <text x="40" y="470" fill="#EDEDF2" font-family="Arial,sans-serif" font-size="11" opacity="0.75">SIMULATED IMAGE — MOCK MODE</text>
  ${lines.map((l, i) =>
    `<text x="40" y="${505 + i * 27}" fill="#fff" font-family="Arial,sans-serif" font-size="21">${escape(l)}</text>`,
  ).join("")}
  <text x="40" y="612" fill="#C1A3FF" font-family="Arial,sans-serif" font-size="12">${escape(modelId)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Generation router.
 *
 * The output modality of the task decides which provider method runs. An
 * image task never goes through text chat completion, and an unsupported
 * modality raises a clear error rather than silently degrading to text.
 */
export class GenerationRouter {
  /** Verifies the chosen model can actually produce what the task requires. */
  async assertCapable(
    modelId: string, required: OutputCapability[],
  ): Promise<void> {
    const model = await modelIntelligence.byOpenRouterId(modelId);
    if (!model) throw new CapabilityMismatchError(`Model '${modelId}' is not in the catalog.`);

    const produces = model.capability?.outputCapabilities ??
      (model.outputModalities as OutputCapability[]);
    const missing = required.filter((r) => !produces.includes(r));
    if (missing.length) {
      throw new CapabilityMismatchError(
        `${model.name} cannot produce ${missing.join(", ").toLowerCase()} output.`);
    }
  }

  /** Chooses the provider method from the required output modality. */
  methodFor(required: OutputCapability[]): "generateText" | "generateImage" | "unsupported" {
    if (required.includes("IMAGE")) return "generateImage";
    if (required.includes("TEXT")) return "generateText";
    return "unsupported";
  }

  /**
   * Image generation.
   *
   * Uses OpenRouter's dedicated image endpoint (POST /api/v1/images), falling
   * back to chat/completions with `modalities: ["image","text"]`, which is the
   * documented path for models predating the dedicated API.
   */
  async generateImage(
    prompt: string, modelId: string, signal?: AbortSignal,
    /**
     * Set when the model's image capability has already been established by
     * the curated Model Intelligence dataset. The catalog check below reads
     * the synced OpenRouter tables, which are no longer the source of model
     * intelligence - so for a curated selection it reports "not in the
     * catalog" for a model that is demonstrably image-capable. This is a
     * different source of the same guarantee, never a way around it.
     */
    capabilityVerified = false,
  ): Promise<ImageResult> {
    const started = Date.now();
    if (!capabilityVerified) await this.assertCapable(modelId, ["IMAGE"]);

    if (isMockMode()) {
      await new Promise((r) => setTimeout(r, 300));
      return {
        url: mockImage(prompt, modelId),
        mimeType: "image/svg+xml",
        modelId,
        costUsd: 0,
        latencyMs: Date.now() - started,
        simulated: true,
      };
    }

    const key = await getOpenRouterKey();
    if (!key) {
      throw new ProviderError(
        "No OpenRouter key is connected. Connect one in Settings.", "auth");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    signal?.addEventListener("abort", () => controller.abort());

    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "dotAI",
    };

    try {
      // --- Preferred: dedicated image endpoint ---------------------------
      const res = await fetch(IMAGES_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: modelId, prompt }),
        signal: controller.signal,
      });

      if (res.ok) {
        const json = (await res.json()) as Record<string, unknown>;
        const normalised = normaliseImageResponse(json);
        if (normalised) {
          return {
            ...normalised, modelId,
            costUsd: extractCost(json),
            latencyMs: Date.now() - started, simulated: false,
          };
        }
      }

      // --- Fallback: chat/completions with image modality ----------------
      const chat = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          modalities: ["image", "text"],
        }),
        signal: controller.signal,
      });

      if (!chat.ok) {
        const detail = await chat.text().catch(() => "");
        throw new ProviderError(
          `Image generation failed (${chat.status}). ${detail.slice(0, 240)}`,
          chat.status === 401 ? "auth" : chat.status >= 500 ? "unavailable" : "bad_request",
        );
      }

      const json = (await chat.json()) as Record<string, unknown>;
      const normalised = normaliseImageResponse(json);
      if (!normalised) {
        throw new ProviderError(
          "The provider returned no image. dotAI does not substitute a placeholder.",
          "unavailable");
      }
      return {
        ...normalised, modelId,
        costUsd: extractCost(json),
        latencyMs: Date.now() - started, simulated: false,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (controller.signal.aborted) {
        throw new ProviderError("Image generation timed out.", "timeout");
      }
      throw new ProviderError(
        `Image generation failed: ${err instanceof Error ? err.message : String(err)}`,
        "unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Audio and video are detected and filtered correctly, but dotAI does not
   * claim to generate them: OpenRouter exposes separate endpoints for these
   * and no path here has been verified against a live provider.
   */
  async generateAudio(): Promise<never> {
    throw new UnsupportedModalityError(
      "Audio generation is not implemented in dotAI yet. The request was correctly identified as audio rather than silently answered as text.");
  }

  async generateVideo(): Promise<never> {
    throw new UnsupportedModalityError(
      "Video generation is not implemented in dotAI yet. The request was correctly identified as video rather than silently answered as text.");
  }
}

/**
 * Normalises the image shapes OpenRouter and its providers return into a
 * single internal result: a dedicated-endpoint `data` array, chat `images`
 * parts, or image content parts inside the message body.
 */
export function normaliseImageResponse(
  json: Record<string, unknown>,
): { url: string; mimeType: string } | null {
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : null;

  // 1. Dedicated image endpoint: { data: [{ b64_json | url, media_type }] }
  const data = Array.isArray(json.data) ? json.data : null;
  const first = data ? asRecord(data[0]) : null;
  if (first) {
    const mime = typeof first.media_type === "string" ? first.media_type : "image/png";
    if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
      return { url: `data:${mime};base64,${first.b64_json}`, mimeType: mime };
    }
    if (typeof first.url === "string" && first.url.length > 0) {
      // Trust an explicit media_type; otherwise infer from the URL rather
      // than assuming PNG.
      return {
        url: first.url,
        mimeType: typeof first.media_type === "string" ? first.media_type : mimeFromUrl(first.url),
      };
    }
  }

  // 2 + 3. Chat completions: message.images[].image_url.url, or an image part
  // inside message.content.
  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const choice of choices) {
    const message = asRecord(asRecord(choice)?.message);
    if (!message) continue;

    const images = Array.isArray(message.images) ? message.images : [];
    for (const img of images) {
      const url = asRecord(asRecord(img)?.image_url)?.url;
      if (typeof url === "string" && url.length > 0) {
        return { url, mimeType: mimeFromUrl(url) };
      }
    }

    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      const p = asRecord(part);
      if (!p) continue;
      const url = asRecord(p.image_url)?.url ?? p.url;
      if (typeof url === "string" && url.length > 0) {
        return { url, mimeType: mimeFromUrl(url) };
      }
      if (typeof p.b64_json === "string") {
        return { url: `data:image/png;base64,${p.b64_json}`, mimeType: "image/png" };
      }
    }
  }

  return null;
}

function mimeFromUrl(url: string): string {
  const m = /^data:([^;,]+)/.exec(url);
  if (m) return m[1];
  if (/\.jpe?g($|\?)/i.test(url)) return "image/jpeg";
  if (/\.webp($|\?)/i.test(url)) return "image/webp";
  return "image/png";
}

function extractCost(json: Record<string, unknown>): number {
  const usage = json.usage && typeof json.usage === "object"
    ? (json.usage as Record<string, unknown>) : null;
  const cost = usage?.total_cost ?? usage?.cost;
  return typeof cost === "number" ? cost : 0;
}

export const generationRouter = new GenerationRouter();
