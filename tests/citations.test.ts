import { describe, expect, it } from "vitest";
import { buildCitations } from "@/lib/citations/build";
import { runControlPlane } from "@/lib/controlplane";
import type { ControlEventData } from "@/types";

/** Matches the real EvidencePassage shape so fixtures stay honest. */
function passage(source: string, text: string, over: Record<string, unknown> = {}) {
  return {
    id: `${source}-${text.slice(0, 8)}`, source, text,
    score: 0.8, authoritative: true, ...over,
  } as import("@/types").EvidencePassage;
}

function event(over: Partial<ControlEventData> = {}): ControlEventData {
  return {
    requestId: "c-1",
    taskClassification: "summarization",
    complexity: 0.2,
    recommendedModel: "m", selectedModel: "m", provider: "p", effort: "low",
    estimatedCost: 0, actualCost: 0,
    verification: {
      status: "SUPPORTED", claimsChecked: 0, verdicts: [], checksRun: [], earlyExit: false,
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

describe("citations come from what the checker actually consulted", () => {
  it("cites a source that grounded a claim", () => {
    const set = buildCitations(event({
      verification: {
        status: "SUPPORTED", claimsChecked: 1, checksRun: [], earlyExit: false,
        verdicts: [{
          claim: "The balance is $6,420.",
          status: "SUPPORTED",
          detail: "Matches the ledger.",
          evidence: passage("accounts.ledger", "Balance: $6,420 as of today."),
        }],
      },
    }));

    expect(set.citations).toHaveLength(1);
    expect(set.citations[0].index).toBe(1);
    expect(set.citations[0].source).toBe("accounts.ledger");
    expect(set.citations[0].status).toBe("SUPPORTED");
  });

  it("reports an ungrounded claim instead of hiding it", () => {
    const set = buildCitations(event({
      verification: {
        status: "UNVERIFIABLE", claimsChecked: 1, checksRun: [], earlyExit: false,
        verdicts: [{
          claim: "Our refund window is 60 days.",
          status: "UNVERIFIABLE",
          detail: "No source covers this.",
          evidence: null,
        }],
      },
    }));

    expect(set.citations).toHaveLength(0);
    expect(set.ungroundedClaims).toHaveLength(1);
    expect(set.summary).toContain("could not be grounded");
  });

  it("marks a contradicted claim as contradicted, not merely cited", () => {
    const set = buildCitations(event({
      verification: {
        status: "CONTRADICTED", claimsChecked: 1, checksRun: [], earlyExit: false,
        verdicts: [{
          claim: "The balance is $9,000.",
          status: "CONTRADICTED",
          detail: "Ledger says $6,420.",
          evidence: passage("accounts.ledger", "Balance: $6,420."),
        }],
      },
    }));

    expect(set.citations[0].status).toBe("CONTRADICTED");
    expect(set.summary).toContain("contradicted");
  });

  it("does not repeat one passage cited for two claims", () => {
    const p = passage("policy.md", "Refunds within 30 days.");
    const set = buildCitations(event({
      verification: {
        status: "SUPPORTED", claimsChecked: 2, checksRun: [], earlyExit: false,
        verdicts: [
          { claim: "Refunds take 30 days.", status: "SUPPORTED", detail: "", evidence: p },
          { claim: "The window is 30 days.", status: "SUPPORTED", detail: "", evidence: p },
        ],
      },
    }));
    expect(set.citations).toHaveLength(1);
  });

  it("cites policy evidence with its regulation and version", () => {
    const set = buildCitations(event({
      policy: {
        jurisdictions: ["EU"], decision: "HOLD", reason: "Transfer restricted.",
        appliedRule: "SENSITIVE_EXTERNAL_TRANSFER", conflict: false,
        caveat: "Not a legal determination.", retrievalMode: "SEMANTIC_LOCAL",
        evidence: [{
          chunkId: "x", documentName: "GDPR demo", regulation: "GDPR",
          version: "demo-1.0", jurisdiction: "EU", section: "Transfers",
          category: "DATA_TRANSFER", text: "Personal data must not be sent externally.",
          score: 0.62, isDemo: true, retrievedAt: new Date().toISOString(),
        }],
      },
    }));

    const policy = set.citations.find((c) => c.kind === "POLICY");
    expect(policy).toBeTruthy();
    expect(policy!.regulation).toBe("GDPR");
    expect(policy!.version).toBe("demo-1.0");
    expect(policy!.isDemo).toBe(true);
    expect(policy!.score).toBeCloseTo(0.62, 2);
  });

  it("says so when knowledge search was switched off", () => {
    const set = buildCitations(event({
      rag: {
        mode: "OFF", label: "OFF", triggered: false, retrievalType: "NONE",
        reason: "user disabled", chunksRetrieved: 0, embeddingCostUsd: 0,
        retrievalLatencyMs: 0,
      },
    }));
    expect(set.retrievalDisabled).toBe(true);
    expect(set.summary).toContain("switched off");
  });

  it("stays quiet when a response made no claims", () => {
    const set = buildCitations(event());
    expect(set.citations).toHaveLength(0);
    expect(set.summary).toContain("no factual claims");
  });

  it("surfaces the retrieval mode so keyword matching is visible", () => {
    const set = buildCitations(event({
      rag: {
        mode: "AUTO", label: "USED — POLICY", triggered: true,
        retrievalType: "POLICY", reason: "", chunksRetrieved: 2,
        embeddingCostUsd: 0, retrievalLatencyMs: 5,
      },
    }));
    expect(set.retrievalMode).toBe("AUTO");
    expect(set.retrievalLabel).toBe("USED — POLICY");
  });
});

describe("citations on a real control-plane run", () => {
  it("builds without error from a live event", async () => {
    const r = await runControlPlane({
      requestId: `cite-${Date.now()}`,
      prompt: "What is John's account balance?",
      attachments: [], history: [], settings: {},
      destinationExternal: false,
      actor: { role: "support_agent", permissions: [] },
    } as Parameters<typeof runControlPlane>[0], () => {});

    const set = buildCitations(r.controlEvent);
    expect(set.summary.length).toBeGreaterThan(0);
    // Every citation index is sequential and unique.
    set.citations.forEach((c, i) => expect(c.index).toBe(i + 1));
  }, 120_000);
});
