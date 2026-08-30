import type { Citation, CitationSet } from "@/lib/citations/build";

export interface TextSegment {
  kind: "text";
  text: string;
}

export interface ClaimSegment {
  kind: "claim";
  text: string;
  /** The marker rendered after this sentence, e.g. 1 for [1]. */
  citationIndex: number;
  relationship: Citation["relationship"];
}

export type AnswerSegment = TextSegment | ClaimSegment;

export interface InlineAlignment {
  segments: AnswerSegment[];
  /** True when at least one marker was placed. */
  inline: boolean;
  /** Citations that could not be safely placed and appear in the list only. */
  unplaced: number[];
  /** Why placement was skipped, when it was. */
  note: string | null;
}

/**
 * Aligns citations to the sentences that produced them.
 *
 * Claims come from the performance checker, which extracts them as verbatim
 * sentences of the answer, so alignment is exact substring matching rather
 * than fuzzy similarity.
 *
 * Deliberately conservative. A marker is placed only when the claim occurs
 * exactly once in the answer: a naive global replace would corrupt a response
 * that repeats a figure, and a misplaced marker is worse than none because it
 * attributes a source to a sentence it never checked.
 */
export function alignCitations(answer: string, set: CitationSet): InlineAlignment {
  const fallback: InlineAlignment = {
    segments: [{ kind: "text", text: answer }],
    inline: false,
    unplaced: set.citations.map((c) => c.index),
    note: null,
  };

  if (!answer.trim() || set.citations.length === 0) return fallback;

  // Locate each citation's claim in the answer. Ambiguous or absent claims
  // are left unplaced rather than guessed at.
  type Placement = { start: number; end: number; citation: Citation };
  const placements: Placement[] = [];
  const unplaced: number[] = [];

  for (const citation of set.citations) {
    const claim = citation.claim?.trim();
    // A policy citation's "claim" is a decision reason, not a sentence of the
    // answer, so it belongs in the source list only.
    if (!claim || citation.relationship === "POLICY") {
      unplaced.push(citation.index);
      continue;
    }

    const first = answer.indexOf(claim);
    if (first === -1) {
      unplaced.push(citation.index);
      continue;
    }
    if (answer.indexOf(claim, first + 1) !== -1) {
      // Repeated text: no way to know which occurrence was checked.
      unplaced.push(citation.index);
      continue;
    }

    placements.push({ start: first, end: first + claim.length, citation });
  }

  if (placements.length === 0) {
    return {
      ...fallback,
      unplaced,
      note: set.citations.length > 0
        ? "Citations could not be matched to specific sentences, so they are listed as supporting sources."
        : null,
    };
  }

  placements.sort((a, b) => a.start - b.start);

  // Overlapping placements would produce nested markers; keep the first.
  const kept: Placement[] = [];
  let lastEnd = -1;
  for (const p of placements) {
    if (p.start < lastEnd) {
      unplaced.push(p.citation.index);
      continue;
    }
    kept.push(p);
    lastEnd = p.end;
  }

  const segments: AnswerSegment[] = [];
  let cursor = 0;
  for (const p of kept) {
    if (p.start > cursor) {
      segments.push({ kind: "text", text: answer.slice(cursor, p.start) });
    }
    segments.push({
      kind: "claim",
      text: answer.slice(p.start, p.end),
      citationIndex: p.citation.index,
      relationship: p.citation.relationship,
    });
    cursor = p.end;
  }
  if (cursor < answer.length) {
    segments.push({ kind: "text", text: answer.slice(cursor) });
  }

  return {
    segments,
    inline: true,
    unplaced: [...new Set(unplaced)],
    note: unplaced.length
      ? `${unplaced.length} source(s) could not be tied to a specific sentence and are listed below.`
      : null,
  };
}
