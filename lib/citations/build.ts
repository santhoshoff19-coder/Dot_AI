import type { ClaimVerdict, ControlEventData } from "@/types";

export type CitationKind = "EVIDENCE" | "POLICY";
export type CitationStatus =
  | "SUPPORTED" | "CONTRADICTED" | "UNCERTAIN" | "UNVERIFIABLE";

/** What the cited source does to the claim. Shown verbatim in the UI. */
export type CitationRelationship = "SUPPORTS" | "CONTRADICTS" | "POLICY";

export interface Citation {
  /** 1-based marker rendered next to the claim, e.g. [1]. */
  index: number;
  kind: CitationKind;
  /** What the claim was checked against. */
  source: string;
  /** The passage itself, trimmed for display. */
  text: string;
  /** The claim this supports or contradicts. */
  claim: string;
  status: CitationStatus;
  relationship: CitationRelationship;
  detail: string;
  /** Only ever set when the source genuinely reported one. Never inferred. */
  page?: number | null;
  sourceUrl?: string | null;
  /** Policy citations carry their regulation and version. */
  regulation?: string;
  version?: string;
  section?: string;
  jurisdiction?: string;
  score?: number;
  isDemo?: boolean;
}

export interface CitationSet {
  citations: Citation[];
  /** Claims the checker examined but could not ground in any source. */
  ungroundedClaims: { claim: string; status: CitationStatus; detail: string }[];
  /** How retrieval behaved, so an empty list is explainable. */
  retrievalMode: string | null;
  retrievalLabel: string | null;
  /** True when retrieval was deliberately switched off. */
  retrievalDisabled: boolean;
  summary: string;
}

const MAX_TEXT = 400;

function trim(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
}

function statusOf(v: ClaimVerdict): CitationStatus {
  switch (v.status) {
    case "SUPPORTED": return "SUPPORTED";
    case "CONTRADICTED": return "CONTRADICTED";
    case "UNCERTAIN": return "UNCERTAIN";
    default: return "UNVERIFIABLE";
  }
}

/**
 * Builds the citations shown beneath an answer.
 *
 * Only sources the checker actually consulted appear here. A claim with no
 * evidence is reported as ungrounded rather than quietly omitted - the absence
 * of a citation is itself information the reader needs.
 */
export function buildCitations(event: ControlEventData): CitationSet {
  const citations: Citation[] = [];
  const ungrounded: CitationSet["ungroundedClaims"] = [];
  const seen = new Map<string, number>();

  // --- evidence the performance checker used --------------------------
  for (const verdict of event.verification.verdicts ?? []) {
    const status = statusOf(verdict);

    // Rule: an unverifiable claim never receives a citation marker. A number
    // beside a sentence reads as "this was checked", and it was not.
    if (!verdict.evidence || status === "UNVERIFIABLE" || status === "UNCERTAIN") {
      ungrounded.push({
        claim: verdict.claim,
        status,
        detail: verdict.detail ||
          "Unable to verify this claim from available evidence.",
      });
      continue;
    }

    const key = `${verdict.evidence.source}::${verdict.evidence.text}`;
    const existing = seen.get(key);
    if (existing !== undefined) {
      // The same passage supporting two claims is one citation, not two.
      continue;
    }

    const index = citations.length + 1;
    seen.set(key, index);
    citations.push({
      index,
      kind: "EVIDENCE",
      source: verdict.evidence.source,
      text: trim(verdict.evidence.text),
      claim: verdict.claim,
      status,
      relationship: status === "CONTRADICTED" ? "CONTRADICTS" : "SUPPORTS",
      detail: verdict.detail,
      // Present only when the retriever actually recorded them.
      page: (verdict.evidence as { page?: number }).page ?? null,
      sourceUrl: (verdict.evidence as { url?: string }).url ?? null,
    });
  }

  // --- sections the model was grounded in ------------------------------
  // These were supplied to the model before it wrote, so they explain where
  // the answer came from rather than what it was graded against.
  if (event.rag?.groundedGeneration) {
    for (const p of event.rag.evidence ?? []) {
      const key = `${p.regulation}::${p.section}::${p.text}`;
      if (seen.has(key)) continue;

      const index = citations.length + 1;
      seen.set(key, index);
      citations.push({
        index,
        kind: "POLICY",
        source: `${p.documentName} — ${p.section}`,
        text: trim(p.text),
        claim: "Answer grounded in this indexed section.",
        status: "SUPPORTED",
        relationship: "POLICY",
        detail: "Retrieved before generation and supplied to the model.",
        page: null,
        sourceUrl: null,
        regulation: p.regulation,
        version: p.version,
        section: p.section,
        jurisdiction: p.jurisdiction,
        score: p.score,
        isDemo: p.isDemo,
      });
    }
  }

  // --- policy evidence the decision cited -----------------------------
  for (const p of event.policy?.evidence ?? []) {
    const key = `${p.regulation}::${p.section}::${p.text}`;
    if (seen.has(key)) continue;

    const index = citations.length + 1;
    seen.set(key, index);
    citations.push({
      index,
      kind: "POLICY",
      source: `${p.regulation} ${p.version} — ${p.section}`,
      text: trim(p.text),
      claim: event.policy?.reason ?? "Policy applied to this response.",
      status: "SUPPORTED",
      relationship: "POLICY",
      detail: event.policy?.appliedRule ?? "",
      page: null,
      sourceUrl: null,
      regulation: p.regulation,
      version: p.version,
      section: p.section,
      jurisdiction: p.jurisdiction,
      score: p.score,
      isDemo: p.isDemo,
    });
  }

  const retrievalDisabled = event.rag?.label === "OFF";
  const retrievalMode = event.policy?.retrievalMode ?? event.rag?.mode ?? null;

  return {
    citations,
    ungroundedClaims: ungrounded,
    retrievalMode,
    retrievalLabel: event.rag?.label ?? null,
    retrievalDisabled,
    summary: summarise(citations, ungrounded, retrievalDisabled, event),
  };
}

function summarise(
  citations: Citation[],
  ungrounded: CitationSet["ungroundedClaims"],
  retrievalDisabled: boolean,
  event: ControlEventData,
): string {
  if (retrievalDisabled) {
    return "Knowledge search was switched off for this request, so nothing was checked against a source.";
  }
  if (citations.length === 0 && ungrounded.length === 0) {
    return event.verification.claimsChecked === 0
      ? "This response made no factual claims to check."
      : "No sources were consulted for this response.";
  }
  if (citations.length === 0) {
    return `${ungrounded.length} statement(s) could not be grounded in any source.`;
  }

  const contradicted = citations.filter((c) => c.status === "CONTRADICTED").length;
  const parts = [`${citations.length} source(s) cited`];
  if (contradicted > 0) parts.push(`${contradicted} contradicted the response`);
  if (ungrounded.length > 0) parts.push(`${ungrounded.length} statement(s) ungrounded`);
  return `${parts.join("; ")}.`;
}
