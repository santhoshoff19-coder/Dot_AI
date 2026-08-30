import type { Capability, ModelSpec, TaskType } from "@/types";

/**
 * FALLBACK model specs.
 *
 * The authoritative catalog is the model intelligence database, populated from
 * every OpenRouter catalog. These few entries exist only so pricing and skill
 * estimates resolve before the first sync, or if the catalog is unreachable.
 * `resolve()` synthesises a spec for any model not listed here, so nothing in
 * routing is limited to this list.
 */
/**
 * No seeded models.
 *
 * This list once held three fixed entries - "Swift" mapped to
 * openai/gpt-4o-mini, "Balanced" to anthropic/claude-3.5-sonnet, "Deep" to
 * openai/o1 - and they leaked into the product in two ways: the Settings page
 * rendered them as fixed model choices, and with the live catalog empty the
 * chat recommendation cards fell back to them, so every query was offered the
 * same three models under placeholder names.
 *
 * Models now come from the curated Model Intelligence dataset, chosen per
 * query by capability matching. `resolve()` below synthesises a spec for any
 * model id it is handed, so nothing depends on a model being listed here.
 */
const MODELS: ModelSpec[] = [];


export class ModelRegistry {
  private models: Map<string, ModelSpec>;

  /**
   * Accepts an explicit list, so a test can supply its own fixtures rather
   * than depending on production seed data. The default is empty: models come
   * from the curated dataset, not from here.
   */
  constructor(models: ModelSpec[] = MODELS) {
    this.models = new Map(models.map((m) => [m.id, m]));
  }

  all(): ModelSpec[] {
    return [...this.models.values()].filter((m) => m.enabled);
  }

  get(id: string): ModelSpec | undefined {
    return this.models.get(id);
  }

  require(id: string): ModelSpec {
    const m = this.models.get(id);
    if (!m) throw new Error(`Unknown model: ${id}`);
    return m;
  }

  /**
   * Returns a usable spec for any model id. The static registry only describes
   * the models dotAI ships with; the catalog now holds hundreds more, and
   * generation must not throw merely because a model was discovered through
   * sync rather than hardcoded.
   */
  resolve(id: string, overrides: Partial<ModelSpec> = {}): ModelSpec {
    const known = this.models.get(id);
    if (known) return known;
    return {
      id,
      provider: id.split("/")[0] ?? "openrouter",
      name: id.split("/").pop() ?? id,
      capabilities: ["text"],
      inputCost: 0,
      outputCost: 0,
      contextLimit: 32_000,
      modalities: ["text"],
      reasoningSupport: false,
      relativeCapability: 0.7,
      latencyClass: "balanced",
      enabled: true,
      skills: {},
      ...overrides,
    };
  }

  eligible(caps: Capability[], minContext = 0): ModelSpec[] {
    const out = this.all().filter(
      (m) => caps.every((c) => m.capabilities.includes(c)) && m.contextLimit >= minContext,
    );
    return out.length ? out : this.all();
  }

  skill(model: ModelSpec, task: TaskType): number {
    return model.skills[task] ?? model.relativeCapability;
  }

  price(model: ModelSpec, inTok: number, outTok: number, reasoningTok = 0): number {
    return (inTok * model.inputCost) / 1e6 + ((outTok + reasoningTok) * model.outputCost) / 1e6;
  }
}

export const modelRegistry = new ModelRegistry();
export const SUCCESS_FLOOR = 0.8;
