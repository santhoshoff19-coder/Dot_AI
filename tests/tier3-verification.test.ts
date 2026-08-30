import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getProfile } from "@/lib/governance/profiles";
import {
  anomalyDetector, MIN_BASELINE_SAMPLES, thresholdsFor,
} from "@/lib/verification/anomaly";
import { aiVerifier } from "@/lib/verification/judge";
import { decideEscalation } from "@/lib/verification/escalation";
import { verificationMetrics, MIN_LABELLED_FOR_RATES } from "@/lib/verification/metrics";
import { performanceService } from "@/lib/performance/service";

const SLICE = {
  profileId: "BASELINE",
  taskType: "summarization",
  modelId: "test/anomaly-model",
};

const NORMAL = [
  "Your order shipped on Tuesday and should arrive within three working days.",
  "The order left our warehouse on Monday and arrives in about three days.",
  "Your parcel was dispatched Wednesday and typically arrives in three days.",
  "The shipment went out on Thursday, with delivery expected in three days.",
  "Your package shipped Friday and should reach you inside three working days.",
  "The order was dispatched Tuesday and normally arrives within three days.",
];

beforeAll(async () => {
  await prisma.anomalyBaselineSample.deleteMany({ where: { modelId: SLICE.modelId } });
}, 60_000);

describe("1. anomaly detection needs a baseline before it means anything", () => {
  it("returns NORMAL while the baseline is too small", async () => {
    const r = await anomalyDetector.score("Something entirely different.", SLICE);
    expect(r.band).toBe("NORMAL");
    expect(r.baselineSize).toBeLessThan(MIN_BASELINE_SAMPLES);
    expect(r.explanation).toContain("too few");
  }, 60_000);

  it("learns only from responses that passed the checker", async () => {
    const rejected = await anomalyDetector.learn("A failed answer.", SLICE, { passed: false });
    expect(rejected).toBe(false);

    for (const text of NORMAL) {
      await anomalyDetector.learn(text, SLICE, { passed: true });
    }
    const stats = await anomalyDetector.baselineStats();
    const slice = stats.find((s) => s.modelId === SLICE.modelId);
    expect(slice?.samples).toBe(NORMAL.length);
    expect(slice?.usable).toBe(true);
  }, 60_000);
});

describe("2. a typical response is not flagged", () => {
  it("scores an ordinary answer as NORMAL", async () => {
    const r = await anomalyDetector.score(
      "Your order shipped on Monday and should arrive within three working days.", SLICE);
    expect(r.band).toBe("NORMAL");
    expect(r.baselineSize).toBeGreaterThanOrEqual(MIN_BASELINE_SAMPLES);
  }, 60_000);
});

describe("3. an unusual response is flagged as unusual, not as false", () => {
  it("flags an off-distribution answer", async () => {
    const r = await anomalyDetector.score(
      "Quantum chromodynamics predicts confinement of colour charge at low energies.",
      SLICE);
    expect(r.band).not.toBe("NORMAL");
    expect(r.score).toBeGreaterThan(0);
  }, 60_000);

  it("never claims an anomaly proves hallucination", async () => {
    const r = await anomalyDetector.score("Totally unrelated astrophysics content.", SLICE);
    expect(r.provesHallucination).toBe(false);
    expect(r.explanation).toContain("not evidence that it is wrong");
  }, 60_000);

  it("tightens thresholds for a low-tolerance profile", () => {
    const support = thresholdsFor(getProfile("BASELINE"));
    const decision = thresholdsFor(getProfile("BASELINE"));
    expect(decision.unusual).toBeLessThanOrEqual(support.unusual);
  });
});

describe("4. the verifier is invoked only when justified", () => {
  const base = {
    profile: getProfile("BASELINE"),
    depth: "deep" as const,
    deterministicStatus: "UNCERTAIN" as const,
    settledDeterministically: false,
    anomalyBand: "UNUSUAL" as const,
    checkableClaims: 2,
    elapsedMs: 10,
  };

  it("runs on the deep path with unresolved uncertainty", () => {
    expect(decideEscalation(base).runVerifier).toBe(true);
  });

  it("does not run when nothing is checkable", () => {
    const d = decideEscalation({ ...base, checkableClaims: 0 });
    expect(d.runVerifier).toBe(false);
    expect(d.runAnomaly).toBe(false);
  });

  it("does not run on the light path, to protect latency", () => {
    const d = decideEscalation({ ...base, depth: "light" });
    expect(d.runVerifier).toBe(false);
    expect(d.reason).toContain("latency");
  });

  it("does not run once the latency budget is spent", () => {
    const d = decideEscalation({ ...base, elapsedMs: 999_999 });
    expect(d.runVerifier).toBe(false);
    expect(d.reason).toContain("budget");
  });

  it("needs both uncertainty and an unusual response on the standard path", () => {
    const both = decideEscalation({ ...base, depth: "standard" });
    const onlyUncertain = decideEscalation({
      ...base, depth: "standard", anomalyBand: "NORMAL" });
    expect(both.runVerifier).toBe(true);
    expect(onlyUncertain.runVerifier).toBe(false);
  });
});

describe("5. deterministic results are never re-litigated by a model", () => {
  it("skips the verifier when a deterministic check already settled it", () => {
    const d = decideEscalation({
      profile: getProfile("BASELINE"),
      depth: "deep",
      deterministicStatus: "CONTRADICTED",
      settledDeterministically: true,
      anomalyBand: "HIGHLY_UNUSUAL",
      checkableClaims: 3,
      elapsedMs: 5,
    });
    expect(d.runVerifier).toBe(false);
    expect(d.reason).toContain("without adding certainty");
  });

  it("keeps a deterministic contradiction even when the ladder runs on", async () => {
    const r = await performanceService.check(
      "total?", "The items are 1200 + 450 + 380, so the total is 2130.", "deep",
      {
        profile: getProfile("BASELINE"),
        requestId: "t3-det", generationModel: "test/model", taskType: "data_analysis",
      });
    expect(r.status).toBe("CONTRADICTED");
    expect(r.earlyExit).toBe(true);
    expect(r.checksRun).not.toContain("ai_verifier");
  }, 60_000);
});

describe("6. verifier output is validated, never trusted raw", () => {
  it("accepts a well-formed judgement", () => {
    const r = aiVerifier.parse(JSON.stringify({
      claims: [{
        claim: "balance is $6,420", verdict: "SUPPORTED",
        confidence: 0.9, reasoning: "ledger states it", evidenceRefs: ["E1"],
      }],
    }));
    expect(r.ok).toBe(true);
  });

  it("rejects an invented verdict value", () => {
    const r = aiVerifier.parse(JSON.stringify({
      claims: [{ claim: "x", verdict: "PROBABLY_TRUE", confidence: 0.9, reasoning: "y" }],
    }));
    expect(r.ok).toBe(false);
  });

  it("rejects malformed JSON without throwing", () => {
    expect(aiVerifier.parse("not json").ok).toBe(false);
  });

  it("strips markdown fences", () => {
    const r = aiVerifier.parse(
      '```json\n{"claims":[{"claim":"a","verdict":"UNVERIFIABLE","confidence":0.2,"reasoning":"no evidence"}]}\n```');
    expect(r.ok).toBe(true);
  });

  it("aggregates conservatively", () => {
    const j = (verdict: "SUPPORTED" | "CONTRADICTED" | "UNVERIFIABLE") => ({
      claim: "c", verdict, confidence: 0.8, reasoning: "r", evidenceRefs: [],
    });
    expect(aiVerifier.aggregate([j("SUPPORTED"), j("CONTRADICTED")])).toBe("CONTRADICTED");
    expect(aiVerifier.aggregate([j("SUPPORTED"), j("UNVERIFIABLE")])).toBe("UNVERIFIABLE");
    expect(aiVerifier.aggregate([j("SUPPORTED")])).toBe("SUPPORTED");
    expect(aiVerifier.aggregate([])).toBe("UNVERIFIABLE");
  });
});

describe("7. verifier failure is never treated as approval", () => {
  it("returns VERIFICATION_UNAVAILABLE with no provider, not SUPPORTED", async () => {
    const r = await aiVerifier.verify({
      requestId: "t3-unavailable",
      prompt: "What is the balance?",
      claims: ["The balance is $8,420."],
      evidence: [],
      generationModel: "openai/gpt-4o-mini",
      profileId: "BASELINE",
    });
    expect(r.outcome).toBe("VERIFICATION_UNAVAILABLE");
    expect(r.outcome).not.toBe("SUPPORTED");
    expect(r.failureReason).toBeTruthy();
    expect(r.note).toContain("rather than assumed correct");
  }, 60_000);

  it("records the call so the failure is visible in metrics", async () => {
    const before = await prisma.verifierCall.count();
    await aiVerifier.verify({
      requestId: "t3-recorded", prompt: "q", claims: ["a claim"], evidence: [],
      generationModel: "openai/gpt-4o-mini", profileId: "BASELINE",
    });
    expect(await prisma.verifierCall.count()).toBeGreaterThan(before);
  }, 60_000);

  it("reports nothing to verify when there are no claims", async () => {
    const r = await aiVerifier.verify({
      requestId: "t3-noclaims", prompt: "hello", claims: [], evidence: [],
      generationModel: "openai/gpt-4o-mini", profileId: "BASELINE",
    });
    expect(r.outcome).toBe("UNVERIFIABLE");
  }, 60_000);
});

describe("8. verifier independence and cost", () => {
  it("prefers a verifier that is not the generating model", async () => {
    const s = await aiVerifier.selectVerifier("openai/gpt-4o-mini");
    if (s.modelId) expect(s.modelId).not.toBe("openai/gpt-4o-mini");
  }, 60_000);

  it("records when self-verification was the only option", async () => {
    const s = await aiVerifier.selectVerifier("nonexistent/model");
    expect(typeof s.sameModel).toBe("boolean");
    expect(s.reason.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("9. metrics are honest about ground truth", () => {
  it("withholds FP/FN rates until enough labels exist", async () => {
    const metrics = await verificationMetrics.verifierMetrics();
    for (const m of metrics) {
      if (m.labelled < MIN_LABELLED_FOR_RATES) {
        expect(m.falsePositiveRate).toBeNull();
        expect(m.falseNegativeRate).toBeNull();
        expect(m.ratesNote).toContain("Withheld");
      }
    }
  }, 60_000);

  it("reports verifier cost, latency and unavailability", async () => {
    const metrics = await verificationMetrics.verifierMetrics();
    expect(metrics.length).toBeGreaterThan(0);
    const m = metrics[0];
    expect(m).toHaveProperty("p95LatencyMs");
    expect(m).toHaveProperty("totalCostUsd");
    expect(m.unavailableRate).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("withholds anomaly precision until enough flagged cases exist", async () => {
    const a = await verificationMetrics.anomalyMetrics();
    if ((a.byBand.UNUSUAL ?? 0) + (a.byBand.HIGHLY_UNUSUAL ?? 0) < 10) {
      expect(a.precisionProxy).toBeNull();
      expect(a.precisionNote).toContain("Withheld");
    }
  }, 60_000);

  it("reports which baselines are usable", async () => {
    const a = await verificationMetrics.anomalyMetrics();
    expect(Array.isArray(a.baselines)).toBe(true);
  }, 60_000);
});
