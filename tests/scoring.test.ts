import { describe, expect, it } from "vitest";
import { ModelScoringEngine } from "@/lib/models/scoring";
import { ModelRegistry } from "@/lib/models/registry";
import { TEST_MODELS } from "./fixtures/models";

/*
 * These tests own their candidates.
 *
 * They used to score the three models the production registry seeded -
 * "Swift", "Balanced" and "Deep", each bound to a specific model id. Those
 * mappings were removed because they leaked into the product: the Settings
 * page offered them as fixed choices, and with the live catalog empty the
 * chat cards fell back to them for every query.
 *
 * The scoring engine still deserves testing, so the candidates live in the
 * test fixture instead and are injected. Nothing outside these tests depends
 * on them.
 */
const modelRegistry = new ModelRegistry(TEST_MODELS);
const modelScoringEngine = new ModelScoringEngine(modelRegistry);

// Referred to by role, not by name: what these tests check is that the engine
// ranks a cheap model above a strong one for a simple task, not which vendor
// happens to sit in each slot.
const CHEAP = TEST_MODELS[0].id;
const MID = TEST_MODELS[1].id;
const STRONG = TEST_MODELS[2].id;
import type { TaskRequirements } from "@/lib/routing/route-types";

const req = (over: Partial<TaskRequirements> = {}): TaskRequirements => ({
  taskType: "summarization",
  complexity: 0.2,
  requiredCapabilities: ["text"],
  modalities: ["text"],
  reasoningRequirement: "light",
  contextRequirement: 2000,
  expectedOutputSize: 300,
  estimatedInputTokens: 1500,
  riskLevel: "low",
  recommendedEffort: "low",
  confidence: 0.9,
  rationale: "test",
  source: "heuristic",
  caiCostUsd: 0,
  ...over,
});

describe("Model Scoring Engine", () => {
  it("returns three distinct options", () => {
    const o = modelScoringEngine.score({ requirements: req() });
    expect(o.recommendable).toBeTruthy();
    expect(o.best).toBeTruthy();
    expect(o.alternative).toBeTruthy();
    const ids = new Set([o.recommendable.modelId, o.best.modelId, o.alternative!.modelId]);
    expect(ids.size).toBe(3);
  });

  it("picks the cheapest capable model as Recommendable for a simple task", () => {
    const o = modelScoringEngine.score({ requirements: req() });
    expect(o.recommendable.modelId).toBe(CHEAP);
  });

  it("picks the highest-capability model as Best", () => {
    const o = modelScoringEngine.score({ requirements: req() });
    const best = modelRegistry.require(o.best.modelId);
    for (const m of modelRegistry.all()) {
      expect(best.relativeCapability).toBeGreaterThanOrEqual(m.relativeCapability);
    }
  });

  it("does not treat the cheapest model as automatically Recommendable", () => {
    // On hard reasoning the cheap model's success collapses, so it should lose
    // despite being the lowest sticker price.
    const o = modelScoringEngine.score({
      requirements: req({
        taskType: "complex_reasoning", complexity: 0.9,
        reasoningRequirement: "heavy", requiredCapabilities: ["text", "reasoning"],
      }),
    });
    const cheapest = [...o.all].sort((a, b) => a.estimatedCost - b.estimatedCost)[0];
    expect(o.recommendable.modelId).not.toBe(cheapest.modelId);
  });

  it("scores the same model differently per task — no universal ranking", () => {
    const simple = modelScoringEngine.score({ requirements: req() });
    const hard = modelScoringEngine.score({
      requirements: req({ taskType: "complex_reasoning", complexity: 0.9 }),
    });
    const cheapSimple = simple.all.find((o) => o.modelId === CHEAP)!;
    const cheapHard = hard.all.find((o) => o.modelId === CHEAP)!;
    expect(cheapSimple.expectedSuccess).toBeGreaterThan(cheapHard.expectedSuccess);
  });

  it("offers the user's previous model as the Alternative when viable", () => {
    const o = modelScoringEngine.score({
      requirements: req(), previousModelId: MID,
    });
    const shown = [o.recommendable.modelId, o.best.modelId];
    if (!shown.includes(MID)) {
      expect(o.alternative?.modelId).toBe(MID);
    }
  });

  it("enforces the capability floor on high-risk work", () => {
    const o = modelScoringEngine.score({
      requirements: req({ taskType: "tool_execution", riskLevel: "critical", complexity: 0.7 }),
      highRisk: true,
    });
    expect(modelRegistry.require(o.recommendable.modelId).relativeCapability)
      .toBeGreaterThanOrEqual(0.85);
  });

  it("does not let a cost preference weaken high-risk routing", () => {
    const cheapPref = modelScoringEngine.score({
      requirements: req({ taskType: "tool_execution", riskLevel: "critical", complexity: 0.7 }),
      settings: { costPreference: "LOWEST" },
      highRisk: true,
    });
    expect(cheapPref.recommendable.expectedSuccess).toBeGreaterThanOrEqual(0.85);
    expect(modelRegistry.require(cheapPref.recommendable.modelId).relativeCapability)
      .toBeGreaterThanOrEqual(0.85);
  });

  it("blends observed reliability once the sample is large enough", () => {
    const withoutHistory = modelScoringEngine.score({ requirements: req() });
    const withHistory = modelScoringEngine.score({
      requirements: req(),
      reliability: (modelId) =>
        modelId === CHEAP ? { rate: 0.2, samples: 50 } : null,
    });
    const before = withoutHistory.all.find((o) => o.modelId === CHEAP)!;
    const after = withHistory.all.find((o) => o.modelId === CHEAP)!;
    expect(after.expectedSuccess).toBeLessThan(before.expectedSuccess);
  });

  it("ignores observed reliability below the sample threshold", () => {
    const a = modelScoringEngine.score({ requirements: req() });
    const b = modelScoringEngine.score({
      requirements: req(),
      reliability: () => ({ rate: 0.1, samples: 2 }),
    });
    expect(b.recommendable.expectedSuccess).toBe(a.recommendable.expectedSuccess);
  });

  it("excludes models that cannot handle the modality", () => {
    const o = modelScoringEngine.score({
      requirements: req({ modalities: ["text", "image"], requiredCapabilities: ["text", "vision"] }),
    });
    for (const opt of o.all) {
      expect(modelRegistry.require(opt.modelId).modalities).toContain("image");
    }
  });

  it("gives every option a user-safe rationale with no chain-of-thought", () => {
    const o = modelScoringEngine.score({ requirements: req() });
    expect(o.recommendable.rationale.length).toBeLessThan(160);
    expect(o.recommendable.rationale.toLowerCase()).not.toContain("step 1");
  });
});
