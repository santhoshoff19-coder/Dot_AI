import { describe, expect, it } from "vitest";
import { decisionEngine } from "@/lib/decision/engine";
import type {
  CostResult, PerformanceResult, ResponsibilityResult, RiskLevel,
} from "@/types";

const cost: CostResult = {
  status: "WITHIN TARGET", estimatedCost: 0.01, actualCost: 0.01,
  inputTokens: 10, outputTokens: 10, reasoningTokens: 0, attempts: 1,
  verificationCost: 0, totalCost: 0.01, costPerSuccessfulTask: 0.01, notes: [],
};

const perf = (status: PerformanceResult["status"]): PerformanceResult => ({
  status, claimsChecked: 1, verdicts: [], checksRun: [], earlyExit: false,
});

const resp = (
  status: ResponsibilityResult["status"],
  findings: ResponsibilityResult["findings"] = [],
): ResponsibilityResult => ({
  status, findings, checksRun: [],
  categories: { privacy: "clear", safety: "clear", fairness: "clear", policy: "clear", security: "clear" },
});

const base = (over: Partial<Parameters<typeof decisionEngine.decide>[0]> = {}) =>
  decisionEngine.decide({
    performance: perf("SUPPORTED"),
    cost,
    responsibility: resp("PERMITTED"),
    riskLevel: "low" as RiskLevel,
    consequence: { irreversible: false, external: false, valueUsd: 0 },
    attempt: 1,
    maxAttempts: 2,
    ...over,
  });

describe("Decision engine", () => {
  it("allows a clean answer", () => {
    expect(base().decision).toBe("ALLOW");
  });

  it("regenerates a contradicted answer while retries remain", () => {
    expect(base({ performance: perf("CONTRADICTED") }).decision).toBe("REGENERATE");
  });

  it("holds a contradicted answer once retries are exhausted", () => {
    const d = base({ performance: perf("CONTRADICTED"), attempt: 3, riskLevel: "medium" });
    expect(d.decision).toBe("HOLD");
  });

  it("blocks a proven critical privacy breach", () => {
    const d = base({
      responsibility: resp("PROHIBITED", [{
        category: "privacy", severity: "critical", deterministic: true,
        message: "account number to external recipient",
      }]),
    });
    expect(d.decision).toBe("BLOCK");
  });

  it("holds rather than blocks when a critical finding is inferred, not proven", () => {
    const d = base({
      responsibility: resp("PROHIBITED", [{
        category: "fairness", severity: "critical", deterministic: false,
        message: "possible stereotype",
      }]),
    });
    expect(d.decision).toBe("HOLD");
  });

  it("holds any critical-risk request for human approval", () => {
    expect(base({ riskLevel: "critical" }).decision).toBe("HOLD");
  });

  it("never gates the answer on cost alone", () => {
    const d = base({ cost: { ...cost, status: "OVER BUDGET" } });
    expect(d.decision).toBe("ALLOW");
  });

  it("escalates the same finding when the consequence is higher", () => {
    const finding = {
      category: "privacy" as const, severity: "medium" as const,
      deterministic: true, message: "email address present",
    };
    const low = base({ responsibility: resp("RESTRICTED", [finding]) });
    const high = base({
      responsibility: resp("RESTRICTED", [finding]),
      consequence: { irreversible: true, external: true, valueUsd: 0 },
    });
    expect(low.decision).toBe("ANNOTATE");
    expect(high.decision).toBe("HOLD");
  });

  it("returns a recommended action for every decision", () => {
    expect(base().recommendedAction).toBe("deliver");
    expect(base({ riskLevel: "critical" }).recommendedAction).toBe("human_review");
  });
});
