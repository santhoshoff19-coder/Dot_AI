/**
 * Raw LLM cost.
 *
 * This is provider pricing as OpenRouter reports it - not a score, not a
 * rating, not a normalised value. It exists as its own module because the one
 * thing a cost-intelligence product must never do is show the user a number
 * between 0 and 100 when they asked what something costs.
 *
 * Cost Efficiency is a separate derived score and lives in the matrix. The two
 * must stay distinguishable: a model can be expensive and efficient at once.
 */

/**
 * Billing units, named as the provider bills them.
 *
 * Forcing a non-token modality into token pricing is how "$2.00 / image"
 * ends up quoted against a coding task. Each side of a price carries its own
 * unit, and a side that does not apply says so.
 */
export type PricingUnit =
  | "USD_PER_MILLION_TOKENS"
  | "USD_PER_IMAGE"
  | "USD_PER_REQUEST"
  | "USD_PER_SECOND"
  | "USD_PER_MINUTE"
  | "USD_PER_MEGAPIXEL"
  | "NOT_APPLICABLE"
  | "UNKNOWN";

/** Legacy aliases, kept so existing call sites keep compiling. */
export const PER_1M_TOKENS: PricingUnit = "USD_PER_MILLION_TOKENS";
export const PER_IMAGE: PricingUnit = "USD_PER_IMAGE";

export type DataQuality = "OBSERVED" | "ESTIMATED" | "INFERRED" | "UNKNOWN";

/** Who supplied a price, and when it was last confirmed. */
export type PriceSource = "OPENROUTER" | "BENCHMARK" | "UNKNOWN";

/**
 * One side of a price. `value` is null exactly when the side is unknown or
 * does not apply - an image model has no input-token price, and that is not
 * the same as a price of zero.
 */
export interface PriceSide {
  value: number | null;
  unit: PricingUnit;
  currency: "USD";
  source: PriceSource;
  checkedAt: string | null;
  status: "VERIFIED" | "BENCHMARK" | "UNKNOWN" | "NOT_APPLICABLE";
}

export interface StructuredPrice {
  input: PriceSide;
  output: PriceSide;
}

const side = (over: Partial<PriceSide> = {}): PriceSide => ({
  value: null, unit: "UNKNOWN", currency: "USD",
  source: "UNKNOWN", checkedAt: null, status: "UNKNOWN", ...over,
});

export const unknownSide = () => side();
export const notApplicableSide = (): PriceSide =>
  side({ unit: "NOT_APPLICABLE", status: "NOT_APPLICABLE" });

/** Formats one side for display. Never "$0" for an absent price. */
export function displaySide(s: PriceSide): string {
  if (s.status === "NOT_APPLICABLE") return "N/A";
  if (s.value === null) return "Unknown";

  const suffix: Record<PricingUnit, string> = {
    USD_PER_MILLION_TOKENS: "/M tokens",
    USD_PER_IMAGE: "/ image",
    USD_PER_REQUEST: "/ request",
    USD_PER_SECOND: "/ second",
    USD_PER_MINUTE: "/ minute",
    USD_PER_MEGAPIXEL: "/ megapixel",
    NOT_APPLICABLE: "",
    UNKNOWN: "",
  };
  return `${usd(s.value)}${suffix[s.unit] ? ` ${suffix[s.unit]}` : ""}`;
}

export interface RawCost {
  /** What the user reads, e.g. "$0.15/M in · $0.60/M out" or "Unknown". */
  display: string;
  unit: PricingUnit;
  /** Present only for token pricing. USD per 1M tokens. */
  inputPer1M: number | null;
  outputPer1M: number | null;
  /** Present only for per-image or per-request pricing. USD. */
  perImage: number | null;
  perRequest: number | null;
  known: boolean;
  /** OBSERVED when it came from live catalog metadata. */
  quality: DataQuality;
}

/**
 * A price is usable only if it is a finite, non-negative number.
 *
 * OpenRouter sends -1 for "no price available", and a sentinel treated as a
 * number makes the unpriced model the cheapest thing in the catalog - which
 * is exactly how an unknown-price model would otherwise win Best Value.
 */
export function isUsablePrice(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** Formats a USD amount at a sensible precision for its magnitude. */
export function usd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.001) return `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (n < 1) return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${n.toFixed(2)}`;
}

export interface PricedModel {
  inputPrice: number;
  outputPrice: number;
  imagePrice: number;
  requestPrice: number;
  pricingKnown: boolean;
  outputModalities?: string[];
}

/**
 * Builds the raw cost for a model, choosing the unit its modality actually
 * bills in. Both halves of token pricing are preserved: collapsing input and
 * output into one figure hides the models whose output is ten times dearer
 * than their input.
 */
export function rawCost(model: PricedModel, opts: { billsAs?: PricingUnit } = {}): RawCost {
  const empty: RawCost = {
    display: "Unknown", unit: "UNKNOWN",
    inputPer1M: null, outputPer1M: null, perImage: null, perRequest: null,
    known: false, quality: "UNKNOWN",
  };

  if (!model.pricingKnown) return empty;

  const outputs = (model.outputModalities ?? []).map((m) => m.toUpperCase());

  // Which unit applies depends on what is being asked for, not only on what
  // the model can do. A model that both chats and draws bills per token when
  // it writes code and per image when it draws, and quoting "$2.00 / image"
  // against a coding task is simply the wrong number.
  const billsAs = opts.billsAs
    ?? (outputs.includes("IMAGE") ? "USD_PER_IMAGE" : "USD_PER_MILLION_TOKENS");

  if (billsAs === "USD_PER_IMAGE" && isUsablePrice(model.imagePrice) && model.imagePrice > 0) {
    return {
      ...empty,
      display: `${usd(model.imagePrice)} / image`,
      unit: "USD_PER_IMAGE",
      perImage: model.imagePrice,
      known: true,
      quality: "OBSERVED",
    };
  }

  const inOk = isUsablePrice(model.inputPrice);
  const outOk = isUsablePrice(model.outputPrice);

  if ((inOk && model.inputPrice > 0) || (outOk && model.outputPrice > 0)) {
    const parts: string[] = [];
    if (inOk) parts.push(`${usd(model.inputPrice)}/M in`);
    if (outOk) parts.push(`${usd(model.outputPrice)}/M out`);
    return {
      ...empty,
      display: parts.join(" · "),
      unit: "USD_PER_MILLION_TOKENS",
      inputPer1M: inOk ? model.inputPrice : null,
      outputPer1M: outOk ? model.outputPrice : null,
      known: true,
      quality: "OBSERVED",
    };
  }

  if (isUsablePrice(model.requestPrice) && model.requestPrice > 0) {
    return {
      ...empty,
      display: `${usd(model.requestPrice)} / request`,
      unit: "USD_PER_REQUEST",
      perRequest: model.requestPrice,
      known: true,
      quality: "OBSERVED",
    };
  }

  // Every reported price was zero. Free is a real price, but only when the
  // provider actually said so rather than omitting the field.
  if (inOk && outOk) {
    return {
      ...empty,
      display: "Free",
      unit: "USD_PER_MILLION_TOKENS",
      inputPer1M: 0, outputPer1M: 0,
      known: true, quality: "OBSERVED",
    };
  }

  return empty;
}

/**
 * A single comparable magnitude for ranking, in USD.
 *
 * Returns null when the price is unknown, so callers must decide explicitly
 * what to do about it rather than silently comparing against zero.
 */
export function comparableCost(cost: RawCost, expectedOutputRatio = 0.3): number | null {
  if (!cost.known) return null;
  if (cost.unit === "USD_PER_IMAGE") return cost.perImage;
  if (cost.unit === "USD_PER_REQUEST") return cost.perRequest;
  if (cost.unit === "USD_PER_MILLION_TOKENS") {
    const input = cost.inputPer1M ?? 0;
    const output = cost.outputPer1M ?? 0;
    // Weighted toward input, since most requests read more than they write.
    return input * (1 - expectedOutputRatio) + output * expectedOutputRatio;
  }
  return null;
}

/**
 * The structured, per-side view of a model's price for a given task.
 *
 * This is the shape the UI and the seed importer both speak. `rawCost` gives
 * the single display string; this gives each side its own value, unit,
 * source and check time, and marks a side NOT_APPLICABLE where the modality
 * genuinely has no such price.
 */
export function structuredPrice(
  model: PricedModel,
  opts: { billsAs?: PricingUnit; checkedAt?: Date | null } = {},
): StructuredPrice {
  const checkedAt = (opts.checkedAt ?? new Date()).toISOString();
  const outputs = (model.outputModalities ?? []).map((m) => m.toUpperCase());
  const billsAs = opts.billsAs
    ?? (outputs.includes("IMAGE") ? "USD_PER_IMAGE" : "USD_PER_MILLION_TOKENS");

  if (!model.pricingKnown) return { input: unknownSide(), output: unknownSide() };

  // An image-output model that publishes no per-image price still bills, by
  // tokens. Treating it as unpriced excluded 47 of 50 image models from the
  // list, leaving three expensive ones and no cheap option at all.
  const hasImagePrice = isUsablePrice(model.imagePrice) && model.imagePrice > 0;

  if (billsAs === "USD_PER_IMAGE" && hasImagePrice) {
    // An image generator has no input-token price to report. Saying so is
    // more honest than reporting the chat-side price of a dual model.
    return {
      input: isUsablePrice(model.inputPrice) && model.inputPrice > 0
        ? { value: model.inputPrice, unit: "USD_PER_MILLION_TOKENS", currency: "USD",
            source: "OPENROUTER", checkedAt, status: "VERIFIED" }
        : notApplicableSide(),
      output: isUsablePrice(model.imagePrice) && model.imagePrice > 0
        ? { value: model.imagePrice, unit: "USD_PER_IMAGE", currency: "USD",
            source: "OPENROUTER", checkedAt, status: "VERIFIED" }
        : unknownSide(),
    };
  }

  const mk = (v: number): PriceSide => ({
    value: v, unit: "USD_PER_MILLION_TOKENS", currency: "USD",
    source: "OPENROUTER", checkedAt, status: "VERIFIED",
  });

  return {
    input: isUsablePrice(model.inputPrice) ? mk(model.inputPrice) : unknownSide(),
    output: isUsablePrice(model.outputPrice) ? mk(model.outputPrice) : unknownSide(),
  };
}
