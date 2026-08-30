/**
 * Minimum similarity for a chunk to count as evidence.
 *
 * Without a floor, top-K always returns K chunks even when nothing is
 * relevant, and whatever consumes the result then cites text that does not
 * apply. Thresholds differ by retrieval mode because the scores are not
 * comparable across modes.
 *
 * Kept in its own module so the performance checker can apply the same floor
 * the policy engine does without importing the engine itself.
 */
export const RELEVANCE_THRESHOLDS: Record<string, number> = {
  SEMANTIC: Number(process.env.RELEVANCE_SEMANTIC ?? 0.35),
  SEMANTIC_LOCAL: Number(process.env.RELEVANCE_SEMANTIC_LOCAL ?? 0.25),
  LEXICAL_FALLBACK: Number(process.env.RELEVANCE_LEXICAL ?? 0.08),
};

export function relevanceFloor(mode: string): number {
  return RELEVANCE_THRESHOLDS[mode] ?? 0.25;
}
