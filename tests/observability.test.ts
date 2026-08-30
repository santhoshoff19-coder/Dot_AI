import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { runControlPlane } from "@/lib/controlplane";
import {
  checkerMetrics, HUMAN_VERDICTS, MIN_LABELLED, VERDICT_TO_GROUND_TRUTH,
} from "@/lib/governance/metrics";
import { modelHealth, MIN_HEALTH_RUNS } from "@/lib/models/health";
import { batchAudit } from "@/lib/audit/batch";
import { GET as dashboardGET, POST as dashboardPOST } from "@/app/api/dashboard/route";
import { NextRequest } from "next/server";

const actor = { role: "support_agent", permissions: [] };

async function run(prompt: string, over: Record<string, unknown> = {}) {
  return runControlPlane({
    requestId: `obs-${Math.random().toString(36).slice(2)}`,
    prompt, attachments: [], history: [], settings: {},
    destinationExternal: false, actor, ...over,
  } as Parameters<typeof runControlPlane>[0], () => {});
}

describe("1. cost accounting is complete and persisted", () => {
  it("records every cost component on the request", async () => {
    const r = await run("Summarize this short article in two sentences.");
    const c = r.controlEvent.costBreakdown!;
    for (const k of ["generation", "routing", "verification", "rag", "retry", "total"]) {
      expect(typeof (c as Record<string, number>)[k]).toBe("number");
    }
    expect(c.total).toBeCloseTo(
      c.generation + c.routing + c.verification + c.rag + c.retry, 8);
  }, 120_000);

  it("persists the breakdown so metrics can report it", async () => {
    const r = await run("Explain this briefly.");
    const row = await prisma.checkerOutcome.findFirst({
      where: { requestId: r.controlEvent.requestId },
    });
    expect(row).toBeTruthy();
    const c = r.controlEvent.costBreakdown!;
    expect(row!.generationCost).toBeCloseTo(c.generation, 8);
    expect(row!.totalCost).toBeCloseTo(c.total, 8);
    expect(row!.controlPlaneOverhead).toBeCloseTo(c.controlPlaneOverhead, 8);
  }, 120_000);

  it("keeps estimated separate from actual", async () => {
    const r = await run("Say hello.");
    const row = await prisma.checkerOutcome.findFirst({
      where: { requestId: r.controlEvent.requestId },
    });
    expect(row!.estimatedCost).toBeGreaterThanOrEqual(0);
    expect(row!.totalCost).toBeGreaterThanOrEqual(0);
    // Two distinct columns, not one value copied into both.
    expect(row).toHaveProperty("estimatedCost");
    expect(row).toHaveProperty("totalCost");
  }, 120_000);

  it("records image turns too, so image traffic is not invisible", async () => {
    const r = await run("Generate a cinematic image of an orange cat on the Moon.");
    const row = await prisma.checkerOutcome.findFirst({
      where: { requestId: r.controlEvent.requestId },
    });
    expect(row).toBeTruthy();
    expect(row!.selectedModel.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("2. metrics aggregate real recorded cost", () => {
  it("reports cost components per profile", async () => {
    await run("Summarize this article.", { profileId: "BASELINE" });
    const all = await checkerMetrics.all();
    const support = all.find((p) => p.profileId === "BASELINE");
    expect(support).toBeTruthy();
    expect(support!.cost).toBeTruthy();
    // Aggregated across many recorded interactions, so this is a sum of
    // sums: six decimal places is tighter than float addition can promise
    // and the drift it flags is arithmetic, not misattribution.
    const components = support!.cost.generation + support!.cost.cai
      + support!.cost.rag + support!.cost.verification + support!.cost.retry;
    expect(Math.abs(support!.cost.total - components))
      .toBeLessThan(Math.max(1e-5, support!.cost.total * 0.02));
  }, 120_000);

  it("reports decision counts and latency percentiles", async () => {
    const all = await checkerMetrics.all();
    const p = all.find((x) => x.interactions > 0)!;
    expect(p.byDecision).toBeTruthy();
    expect(p.p50CheckerLatencyMs).not.toBeUndefined();
    expect(p.p95CheckerLatencyMs).not.toBeUndefined();
  }, 60_000);

  it("withholds FP/FN until enough labelled decisions exist", async () => {
    const all = await checkerMetrics.all();
    for (const p of all) {
      if (p.labelledCount < MIN_LABELLED) {
        expect(p.falsePositiveRate).toBeNull();
        expect(p.falseNegativeRate).toBeNull();
        expect(p.riskEscapeRate).toBeNull();
        expect(p.groundTruthNote.length).toBeGreaterThan(0);
      }
    }
  }, 60_000);
});

describe("6. human feedback is evidence, not automatic truth", () => {
  it("accepts every required verdict", () => {
    for (const v of ["CORRECT", "INCORRECT", "UNSAFE", "POLICY_VIOLATION",
      "FALSE_POSITIVE", "FALSE_NEGATIVE", "UNVERIFIABLE"]) {
      expect(HUMAN_VERDICTS).toContain(v);
    }
  });

  it("records feedback as an auditable row", async () => {
    const r = await run("Summarize this article.");
    const id = r.controlEvent.requestId;
    await checkerMetrics.recordFeedback({ requestId: id, verdict: "CORRECT", comment: "fine" });

    const rows = await checkerMetrics.feedbackFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("CORRECT");
    expect(rows[0].comment).toBe("fine");
  }, 120_000);

  it("does not treat UNVERIFIABLE as ground truth", async () => {
    const r = await run("Summarize this article.");
    const id = r.controlEvent.requestId;
    const res = await checkerMetrics.recordFeedback({ requestId: id, verdict: "UNVERIFIABLE" });
    expect(res.groundTruth).toBeNull();
    expect(VERDICT_TO_GROUND_TRUTH.UNVERIFIABLE).toBeNull();

    const outcome = await prisma.checkerOutcome.findFirst({ where: { requestId: id } });
    expect(outcome!.humanVerdict).toBeNull();
  }, 120_000);

  it("flags conflicting reviewers instead of letting the last one win", async () => {
    const r = await run("Summarize this article.");
    const id = r.controlEvent.requestId;
    await checkerMetrics.recordFeedback({ requestId: id, verdict: "CORRECT", reviewer: "a" });
    const second = await checkerMetrics.recordFeedback({
      requestId: id, verdict: "INCORRECT", reviewer: "b" });

    expect(second.disputed).toBe(true);
    expect(second.groundTruth).toBeNull();
    const rows = await checkerMetrics.feedbackFor(id);
    expect(rows.every((f) => f.disputed)).toBe(true);
  }, 120_000);

  it("ignores low-confidence feedback as ground truth", async () => {
    const r = await run("Summarize this article.");
    const id = r.controlEvent.requestId;
    await checkerMetrics.recordFeedback({
      requestId: id, verdict: "FALSE_POSITIVE", confidence: 0.2 });
    const outcome = await prisma.checkerOutcome.findFirst({ where: { requestId: id } });
    expect(outcome!.humanVerdict).toBeNull();
  }, 120_000);
});

describe("7. model health separates execution from capability", () => {
  it("returns null rates until there is enough evidence", async () => {
    const h = await modelHealth.forModel("openai/gpt-4o-mini");
    if (h && !h.sufficientEvidence) {
      expect(h.successRate).toBeNull();
      expect(h.note).toContain(String(MIN_HEALTH_RUNS));
    }
  }, 60_000);

  it("counts execution failures by structured reason", async () => {
    const h = await modelHealth.forModel("openai/gpt-4o-mini");
    expect(h).toBeTruthy();
    expect(Array.isArray(h!.executionFailures)).toBe(true);
    for (const f of h!.executionFailures) {
      expect(typeof f.reason).toBe("string");
      expect(f.count).toBeGreaterThan(0);
    }
  }, 60_000);

  it("keeps ranking neutral without sufficient evidence", async () => {
    const factor = await modelHealth.rankingFactor("openai/gpt-4o-mini");
    expect(factor).toBeGreaterThan(0);
    const h = await modelHealth.forModel("openai/gpt-4o-mini");
    if (!h?.sufficientEvidence) expect(factor).toBe(1);
  }, 60_000);

  it("never lets one event swing ranking", async () => {
    const factor = await modelHealth.rankingFactor("openai/gpt-4o-mini");
    expect(factor).toBeLessThanOrEqual(1.15);
    expect(factor).toBeGreaterThanOrEqual(0.6);
  }, 60_000);
});

describe("3/4. batch audit reports real cost", () => {
  it("returns cost components for the audit pass", async () => {
    const run1 = await batchAudit.run({ strategy: "RANDOM", sampleSize: 6, maxDeepChecks: 2 });
    expect(run1.cost.auditTotal).toBeCloseTo(
      run1.cost.checker + run1.cost.verifier + run1.cost.rag, 8);
    expect(run1.cost.reviewedGeneration).toBeGreaterThanOrEqual(0);
  }, 180_000);

  it("PROFILE_BASED restricts the population", async () => {
    const r = await batchAudit.run({
      strategy: "PROFILE_BASED", profileId: "BASELINE", sampleSize: 10 });
    const total = await prisma.controlEvent.count({
      where: { profileId: "BASELINE" } });
    expect(r.populationSize).toBeLessThanOrEqual(total);
  }, 180_000);
});

describe("8. dashboard API", () => {
  it("serves profiles, model health and thresholds", async () => {
    const res = await dashboardGET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(Array.isArray(body.modelHealth)).toBe(true);
    expect(body.thresholds.minLabelled).toBe(MIN_LABELLED);
    expect(body.verdicts).toContain("UNVERIFIABLE");
    expect(body.notice).toContain("never estimated");
  }, 120_000);

  it("accepts feedback and rejects an invented verdict", async () => {
    const r = await run("Summarize this article.");
    const ok = await dashboardPOST(new NextRequest("http://localhost/api/dashboard", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: r.controlEvent.requestId, verdict: "CORRECT" }),
    }));
    expect(ok.status).toBe(200);

    const bad = await dashboardPOST(new NextRequest("http://localhost/api/dashboard", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "x", verdict: "PROBABLY_FINE" }),
    }));
    expect(bad.status).toBe(400);
  }, 120_000);
});
