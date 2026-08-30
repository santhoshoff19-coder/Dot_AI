/**
 * Data status for every assessed field.
 *
 * The problem this exists to solve: a Float column always contains a number.
 * Storing 0.5 for "we have no idea" and 0.5 for "we measured 0.5" makes the
 * two indistinguishable downstream, and the product then presents a guess as
 * a measurement. This module carries the meaning alongside the number.
 *
 * The rule enforced everywhere below: an UNKNOWN or NOT_APPLICABLE field is
 * never displayed as a score and never contributes to a ranking. It does not
 * become 0, -1, 50 or 100.
 */

export const FIELD_STATUSES = [
  /** Measured by dotAI, or a fact taken directly from the live catalog. */
  "VERIFIED",
  /** A published or vendor-stated figure carried in from the benchmark. */
  "BENCHMARK",
  /** A considered estimate. Usable for ranking, never presented as measured. */
  "ESTIMATED",
  /** Derived from an adjacent fact rather than stated anywhere. */
  "INFERRED",
  /** Genuinely not known. Must not be replaced with a number. */
  "UNKNOWN",
  /** The field does not apply here, e.g. context window on an image model. */
  "NOT_APPLICABLE",
] as const;

export type FieldStatus = (typeof FIELD_STATUSES)[number];

/** Statuses whose number means something and may be ranked. */
export const RANKABLE_STATUSES: FieldStatus[] = [
  "VERIFIED", "BENCHMARK", "ESTIMATED", "INFERRED",
];

export function isRankable(status: FieldStatus): boolean {
  return RANKABLE_STATUSES.includes(status);
}

/** How confident a reader should be, in one word, for the UI. */
export const STATUS_LABEL: Record<FieldStatus, string> = {
  VERIFIED: "dotAI verified",
  BENCHMARK: "Benchmark",
  ESTIMATED: "Estimated",
  INFERRED: "Inferred",
  UNKNOWN: "Unknown",
  NOT_APPLICABLE: "Not applicable",
};

/** Compact marks for a dense table. VERIFIED is unmarked - it is the norm. */
export const STATUS_MARK: Record<FieldStatus, string> = {
  VERIFIED: "", BENCHMARK: "†", ESTIMATED: "~", INFERRED: "≈",
  UNKNOWN: "?", NOT_APPLICABLE: "—",
};

/**
 * A number that knows whether it means anything.
 *
 * `value` is null exactly when the status is UNKNOWN or NOT_APPLICABLE, so a
 * caller cannot read a number out of a field that has none.
 */
export interface ScoreValue {
  value: number | null;
  status: FieldStatus;
}

export function scoreValue(value: number | null, status: FieldStatus): ScoreValue {
  return isRankable(status) && value !== null
    ? { value, status }
    : { value: null, status: status === "UNKNOWN" || status === "NOT_APPLICABLE" ? status : "UNKNOWN" };
}

export const unknown = (): ScoreValue => ({ value: null, status: "UNKNOWN" });
export const notApplicable = (): ScoreValue => ({ value: null, status: "NOT_APPLICABLE" });

/** How a score reads in the UI. Never "0" for an absent measurement. */
export function displayScore(v: ScoreValue): string {
  if (v.status === "NOT_APPLICABLE") return "N/A";
  if (v.value === null) return "Unknown";
  return String(Math.round(v.value));
}

export function parseFieldStatus(raw: string): Record<string, FieldStatus> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, FieldStatus> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && (FIELD_STATUSES as readonly string[]).includes(v)) {
        out[k] = v as FieldStatus;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Fields that do not apply to a task at all.
 *
 * Context capacity on an image generator is not a low score, it is not a
 * score. Marking it NOT_APPLICABLE stops it dragging an otherwise strong
 * candidate down a ranking it should win.
 */
export function notApplicableFields(taskType: string): string[] {
  switch (taskType) {
    case "IMAGE_GENERATION":
    case "IMAGE_EDITING":
    case "TEXT_TO_SPEECH":
    case "VIDEO_GENERATION":
      return ["contextCapacity"];
    default:
      return [];
  }
}
