import { describe, expect, it } from "vitest";
import { buildCitations } from "@/lib/citations/build";
import { alignCitations } from "@/lib/citations/inline";
import type { ClaimVerdict, ControlEventData, EvidencePassage } from "@/types";

function passage(source: string, text: string): EvidencePassage {
  return { id: `${source}-1`, source, text, score: 0.8, authoritative: true };
}

function verdict(
  claim: string, status: ClaimVerdict["status"],
  evidence: EvidencePassage | null, detail = "",
): ClaimVerdict {
  return { claim, status, detail, evidence };
}

function event(verdicts: ClaimVerdict[], over: Partial<ControlEventData> = {}): ControlEventData {
  return {
    requestId: "i-1", taskClassification: "summarization", complexity: 0.2,
    recommendedModel: "m", selectedModel: "m", provider: "p", effort: "low",
    estimatedCost: 0, actualCost: 0,
    verification: {
      status: "SUPPORTED", claimsChecked: verdicts.length, verdicts,
      checksRun: [], earlyExit: false,
    },
    cost: {
      status: "WITHIN TARGET", estimatedCost: 0, actualCost: 0, inputTokens: 0,
      outputTokens: 0, reasoningTokens: 0, attempts: 1, verificationCost: 0,
      totalCost: 0, costPerSuccessfulTask: 0, notes: [],
    },
    responsibility: {
      status: "PERMITTED", findings: [], checksRun: [],
      categories: { privacy: "clear", safety: "clear", fairness: "clear", policy: "clear", security: "clear" },
    },
    riskLevel: "low", verificationDepth: "light",
    decision: { decision: "ALLOW", reason: "ok", recommendedAction: "deliver", annotations: [] },
    actionGate: null, latencyMs: 1, attempts: 1, rationale: "", mock: true,
    ...over,
  } as ControlEventData;
}

const markers = (segs: ReturnType<typeof alignCitations>["segments"]) =>
  segs.filter((s) => s.kind === "claim");

describe("ACCEPTANCE: supported claim", () => {
  it("places [1] after the sentence and labels it SUPPORTS", () => {
    const answer = "The balance is $6,420.";
    const set = buildCitations(event([
      verdict(answer, "SUPPORTED", passage("accounts.ledger", "Ledger balance: $6,420.")),
    ]));
    const a = alignCitations(answer, set);

    expect(a.inline).toBe(true);
    expect(markers(a.segments)).toHaveLength(1);
    expect(markers(a.segments)[0].citationIndex).toBe(1);
    expect(set.citations[0].relationship).toBe("SUPPORTS");
    expect(set.citations[0].source).toBe("accounts.ledger");
  });
});

describe("ACCEPTANCE: contradicted claim", () => {
  it("still cites, and shows the contradicting evidence", () => {
    const answer = "The balance is $9,000.";
    const set = buildCitations(event([
      verdict(answer, "CONTRADICTED",
        passage("accounts.ledger", "Ledger balance: $6,420."), "Ledger disagrees."),
    ]));
    const a = alignCitations(answer, set);

    expect(a.inline).toBe(true);
    expect(markers(a.segments)[0].relationship).toBe("CONTRADICTS");
    expect(set.citations[0].relationship).toBe("CONTRADICTS");
    expect(set.citations[0].text).toContain("$6,420");
    expect(set.summary).toContain("contradicted");
  });
});

describe("ACCEPTANCE: unverifiable claim gets no marker", () => {
  it("produces no citation and says it could not be verified", () => {
    const answer = "The refund period is 60 days.";
    const set = buildCitations(event([
      verdict(answer, "UNVERIFIABLE", null),
    ]));
    const a = alignCitations(answer, set);

    expect(set.citations).toHaveLength(0);
    expect(a.inline).toBe(false);
    expect(markers(a.segments)).toHaveLength(0);
    expect(set.ungroundedClaims[0].detail)
      .toContain("Unable to verify this claim from available evidence");
  });

  it("refuses a citation even when a passage was retrieved but inconclusive", () => {
    const answer = "The refund period is 60 days.";
    const set = buildCitations(event([
      verdict(answer, "UNVERIFIABLE", passage("policy.md", "Refund terms vary.")),
    ]));
    expect(set.citations).toHaveLength(0);
    expect(set.ungroundedClaims).toHaveLength(1);
  });
});

describe("multiple claims map to distinct citations", () => {
  it("numbers each claim against its own source, in order", () => {
    const answer = "The balance is $6,420. The last payment was $250.";
    const set = buildCitations(event([
      verdict("The balance is $6,420.", "SUPPORTED",
        passage("accounts.ledger", "Balance: $6,420.")),
      verdict("The last payment was $250.", "SUPPORTED",
        passage("accounts.payments", "Payment: $250.")),
    ]));
    const a = alignCitations(answer, set);

    const m = markers(a.segments);
    expect(m).toHaveLength(2);
    expect(m[0].citationIndex).toBe(1);
    expect(m[1].citationIndex).toBe(2);
    expect(set.citations[0].source).toBe("accounts.ledger");
    expect(set.citations[1].source).toBe("accounts.payments");
  });

  it("keeps the answer text intact around the markers", () => {
    const answer = "The balance is $6,420. The last payment was $250.";
    const set = buildCitations(event([
      verdict("The balance is $6,420.", "SUPPORTED", passage("a", "x")),
      verdict("The last payment was $250.", "SUPPORTED", passage("b", "y")),
    ]));
    const a = alignCitations(answer, set);
    expect(a.segments.map((s) => s.text).join("")).toBe(answer);
  });
});

describe("alignment never corrupts the answer", () => {
  it("does not place a marker when the claim text repeats", () => {
    const answer = "The total is $50. Confirming: The total is $50.";
    const set = buildCitations(event([
      verdict("The total is $50.", "SUPPORTED", passage("ledger", "Total: $50.")),
    ]));
    const a = alignCitations(answer, set);

    // Ambiguous: no way to know which occurrence was checked.
    expect(a.inline).toBe(false);
    expect(a.unplaced).toContain(1);
    expect(a.segments.map((s) => s.text).join("")).toBe(answer);
  });

  it("falls back to a source list when a claim is not present verbatim", () => {
    const set = buildCitations(event([
      verdict("A paraphrased claim not in the text.", "SUPPORTED", passage("s", "t")),
    ]));
    const a = alignCitations("Entirely different wording here.", set);

    expect(a.inline).toBe(false);
    expect(a.note).toContain("listed as supporting sources");
  });

  it("returns the answer unchanged when there are no citations", () => {
    const answer = "Hello, how can I help?";
    const a = alignCitations(answer, buildCitations(event([])));
    expect(a.segments).toHaveLength(1);
    expect(a.segments[0].text).toBe(answer);
  });
});

describe("policy citations", () => {
  it("labels policy evidence POLICY and lists it rather than inlining it", () => {
    const answer = "That transfer is not permitted.";
    const set = buildCitations(event([], {
      policy: {
        jurisdictions: ["EU"], decision: "BLOCK", reason: "Transfer restricted.",
        appliedRule: "SENSITIVE_EXTERNAL_TRANSFER", conflict: false,
        caveat: "Not a legal determination.", retrievalMode: "SEMANTIC_LOCAL",
        evidence: [{
          chunkId: "c", documentName: "GDPR demo", regulation: "GDPR",
          version: "demo-1.0", jurisdiction: "EU", section: "Transfers",
          category: "DATA_TRANSFER", text: "Personal data must not be sent externally.",
          score: 0.62, isDemo: true, retrievedAt: new Date().toISOString(),
        }],
      },
    }));
    const a = alignCitations(answer, set);

    expect(set.citations[0].relationship).toBe("POLICY");
    expect(set.citations[0].version).toBe("demo-1.0");
    expect(set.citations[0].section).toBe("Transfers");
    // A decision reason is not a sentence of the answer, so it is not inlined.
    expect(a.inline).toBe(false);
    expect(a.unplaced).toContain(1);
  });
});

describe("RAG OFF and no-RAG responses", () => {
  it("says retrieval was off and places no markers", () => {
    const set = buildCitations(event([], {
      rag: {
        mode: "OFF", label: "OFF", triggered: false, retrievalType: "NONE",
        reason: "user disabled", chunksRetrieved: 0, embeddingCostUsd: 0,
        retrievalLatencyMs: 0,
      },
    }));
    const a = alignCitations("Some answer text.", set);

    expect(set.retrievalDisabled).toBe(true);
    expect(set.summary).toContain("switched off");
    expect(a.inline).toBe(false);
  });

  it("stays silent for a response with no claims at all", () => {
    const set = buildCitations(event([]));
    expect(set.citations).toHaveLength(0);
    expect(set.ungroundedClaims).toHaveLength(0);
    expect(set.summary).toContain("no factual claims");
  });
});

describe("never invents metadata", () => {
  it("leaves page and source URL null when the passage has none", () => {
    const set = buildCitations(event([
      verdict("The balance is $6,420.", "SUPPORTED",
        passage("accounts.ledger", "Balance: $6,420.")),
    ]));
    // EvidencePassage carries no page or URL, so neither may be fabricated.
    expect(set.citations[0].page).toBeNull();
    expect(set.citations[0].sourceUrl).toBeNull();
  });

  it("uses the real source name, never a placeholder", () => {
    const set = buildCitations(event([
      verdict("A claim.", "SUPPORTED", passage("finance/approvals.md", "text")),
    ]));
    expect(set.citations[0].source).toBe("finance/approvals.md");
  });
});
