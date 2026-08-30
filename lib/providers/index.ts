import { existsSync } from "fs";
import { join } from "path";
import { mockProvider } from "./mock";
import { openRouterProvider } from "./openrouter";
import type { LLMProvider } from "./types";

export { ProviderError } from "./types";
export type { LLMProvider, StreamChunk } from "./types";

/**
 * MOCK_MODE is on unless explicitly disabled. A key connected through the UI
 * counts the same as one in .env.
 */
export function isMockMode(): boolean {
  const flag = (process.env.MOCK_MODE ?? "true").toLowerCase();
  if (flag !== "false") return true;
  return !hasKeySync();
}

/**
 * Synchronous best-effort check used on hot paths. The authoritative async
 * lookup lives in lib/credentials/store.
 */
function hasKeySync(): boolean {
  if (process.env.OPENROUTER_API_KEY) return true;
  try {
    return existsSync(join(process.cwd(), ".credentials.json"));
  } catch {
    return false;
  }
}

export function getProvider(): LLMProvider {
  return isMockMode() ? mockProvider : openRouterProvider;
}
