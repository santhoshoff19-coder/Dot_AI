import { modelRegistry } from "@/lib/models/registry";
import type { GenerationRequest, GenerationResult, ModelSpec } from "@/types";
import { getOpenRouterKey } from "@/lib/credentials/store";
import { toImageDataUrl } from "@/lib/attachments/encode";
import { ProviderError, type LLMProvider, type StreamChunk } from "./types";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 90_000;

interface ORDelta { choices?: { delta?: { content?: string } }[]; usage?: ORUsage }
/**
 * The gateway's cost figure, tolerating both field names.
 *
 * Reading only `total_cost` silently produced a cost of zero on every real
 * call, which made the whole cost-intelligence layer report nothing.
 */
function gatewayCost(u?: ORUsage): number | undefined {
  if (!u) return undefined;
  const v = u.cost ?? u.total_cost;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface ORUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenRouter's field name. `total_cost` is accepted as a legacy alias. */
  cost?: number;
  total_cost?: number;
  /** True when the request billed to the caller's own provider key. */
  is_byok?: boolean;
}

/**
 * OpenRouter gateway. Runs server-side only - the API key is read from
 * process.env and is never sent to the browser.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";

  /**
   * Resolved server-side per request: the encrypted credential store first,
   * then .env for developer configuration. The key never reaches the client.
   */
  private async key(): Promise<string> {
    const key = await getOpenRouterKey();
    if (!key) {
      throw new ProviderError(
        "No OpenRouter key is connected. Connect one in Settings, or run in mock mode.",
        "auth");
    }
    return key;
  }

  supports(model: ModelSpec): boolean { return model.enabled; }

  estimateCost(model: ModelSpec, inTok: number, outTok: number, reasoningTok = 0): number {
    return modelRegistry.price(model, inTok, outTok, reasoningTok);
  }

  private async buildMessages(req: GenerationRequest) {
    const content: Record<string, unknown>[] = [{ type: "text", text: req.prompt }];

    for (const a of req.attachments) {
      if (a.type === "image") {
        // Uploads live on disk and must be inlined here. Failing loudly is
        // essential: silently dropping the image would leave the model
        // answering a vision question it never received an image for.
        const url = await toImageDataUrl(a);
        content.push({ type: "image_url", image_url: { url } });
      } else if (a.extractedText) {
        content.push({
          type: "text",
          text: `\n\n[Attached document: ${a.name}]\n${a.extractedText.slice(0, 20_000)}`,
        });
      }
    }

    return [
      ...req.history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content },
    ];
  }

  async *stream(req: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const model = modelRegistry.resolve(req.modelId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    req.signal?.addEventListener("abort", () => controller.abort());

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.key()}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "dotAI",
        },
        body: JSON.stringify({
          model: req.modelId,
          messages: await this.buildMessages(req),
          stream: true,
          usage: { include: true },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted && !req.signal?.aborted) {
        throw new ProviderError("The model provider timed out.", "timeout");
      }
      if (req.signal?.aborted) { yield { text: "", done: true }; return; }
      throw new ProviderError(`Could not reach OpenRouter: ${String(err)}`, "unavailable");
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const detail = await res.text().catch(() => "");
      const kind = res.status === 401 || res.status === 403 ? "auth"
        : res.status === 400 ? "bad_request"
        : res.status >= 500 ? "unavailable" : "unknown";
      throw new ProviderError(
        `OpenRouter returned ${res.status}. ${detail.slice(0, 300)}`, kind);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: StreamChunk["usage"];
    /** Set when the gateway says the call billed to the caller's own key. */
    let byok = false;
    let outChars = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;

          let json: ORDelta;
          try { json = JSON.parse(payload) as ORDelta; } catch { continue; }

          const text = json.choices?.[0]?.delta?.content;
          if (text) { outChars += text.length; yield { text, done: false }; }

          if (json.usage) {
            usage = {
              inputTokens: json.usage.prompt_tokens ?? 0,
              outputTokens: json.usage.completion_tokens ?? 0,
              reasoningTokens: 0,
              cost: gatewayCost(json.usage),
            };
            byok = json.usage.is_byok === true;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }

    const inputTokens = usage?.inputTokens ?? Math.ceil(req.prompt.length / 4);
    const outputTokens = usage?.outputTokens ?? Math.ceil(outChars / 4);
    // A BYOK request bills to the caller's own provider account, so the
    // gateway reports zero. That is not free - cost intelligence still needs
    // the real figure, so it is priced from the catalog instead.
    const reportedCost = byok ? undefined : usage?.cost;
    yield {
      text: "",
      done: true,
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        // Prefer the gateway's own figure; fall back to catalog pricing when
        // it is absent or suppressed by BYOK billing.
        cost: reportedCost ?? modelRegistry.price(model, inputTokens, outputTokens),
      },
    };
  }

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const started = Date.now();
    const model = modelRegistry.resolve(req.modelId);
    let text = "";
    let usage: StreamChunk["usage"];
    for await (const c of this.stream(req)) {
      text += c.text;
      if (c.usage) usage = c.usage;
    }
    return {
      text,
      modelId: req.modelId,
      provider: model.provider,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      cost: usage?.cost ?? 0,
      latencyMs: Date.now() - started,
      cancelled: req.signal?.aborted,
    };
  }
}

export const openRouterProvider = new OpenRouterProvider();
