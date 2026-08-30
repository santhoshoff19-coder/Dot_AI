import type { GenerationRequest, GenerationResult, ModelSpec } from "@/types";

export interface StreamChunk {
  text: string;
  done: boolean;
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number; cost?: number };
}

/**
 * Provider abstraction. The chat UI never imports a concrete provider, so
 * adding Anthropic/OpenAI/Google direct adapters later needs no UI change.
 */
export interface LLMProvider {
  readonly name: string;
  supports(model: ModelSpec): boolean;
  estimateCost(model: ModelSpec, inputTokens: number, outputTokens: number, reasoningTokens?: number): number;
  generate(req: GenerationRequest): Promise<GenerationResult>;
  stream(req: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly kind: "auth" | "timeout" | "unavailable" | "bad_request" | "unknown") {
    super(message);
    this.name = "ProviderError";
  }
}
