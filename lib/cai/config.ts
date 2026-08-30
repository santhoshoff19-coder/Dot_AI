/**
 * CAI: the query analyser that runs on the chat request path.
 *
 * Deliberately its own module and its own model. CAI previously borrowed the
 * offline evaluator's configuration, which tied a per-request call to a model
 * chosen for slow, expensive, once-a-day work. They have opposite
 * requirements: CAI runs on every single query and must be fast and cheap,
 * so it is configured here and nowhere else.
 *
 * CAI classifies. It never selects a model, and it never sees the catalogue —
 * eligibility is decided by LIST A ⊆ LIST B against the curated dataset.
 */

export const CAI_MODEL =
  process.env.CAI_MODEL ?? "google/gemini-2.5-flash-lite";

/**
 * How long a CAI call may take before it is abandoned.
 *
 * Short, because this sits in front of every request: a slow analyser delays
 * every answer, and the deterministic fallback is a better outcome than a
 * request that hangs. Read per call so it stays configurable at runtime.
 */
export function caiTimeoutMs(): number {
  // `||` rather than `??`: an env var set to "" would become 0 and abort
  // every call instantly.
  return Number(process.env.CAI_TIMEOUT_MS || 20_000);
}
