import { describe, expect, it } from "vitest";
import { routeQuery } from "@/lib/intelligence/curated-routing";
import {
  depthFromAnalysis, effortFromAnalysis, optionsFromDecision,
  riskFromAnalysis, routingFromDecision,
} from "@/lib/intelligence/cai-routing-result";

describe("CAI is the only classifier", () => {
  it("builds the routing result from CAI, with no fast router involved", async () => {
    const d = await routeQuery({ prompt: "Write a Python function to calculate factorial." });
    const r = routingFromDecision(d, 0);

    expect(r.routeSource).toBe("CAI");
    // The fast router no longer runs, so it has no confidence to report.
    expect(r.fastRouter.confidence).toBe(0);
    expect(r.fastRouter.reason).toContain("only classifier");
    expect(r.subTaskLabel).toBe(d.analysis.subTaskName);
  }, 300_000);

  it("derives risk, depth and effort from CAI's own analysis", async () => {
    const easy = await routeQuery({ prompt: "Hi" });
    const hard = await routeQuery({
      prompt: "Compare these strategies in depth and justify the trade-offs rigorously." });

    const order = ["light", "standard", "deep"];
    expect(order.indexOf(depthFromAnalysis(hard)))
      .toBeGreaterThanOrEqual(order.indexOf(depthFromAnalysis(easy)));

    const risk = ["low", "medium", "high", "critical"];
    expect(risk.indexOf(riskFromAnalysis(hard)))
      .toBeGreaterThanOrEqual(risk.indexOf(riskFromAnalysis(easy)));
    expect(["low", "medium", "high"]).toContain(effortFromAnalysis(easy));
  }, 600_000);

  it("never reports Conversation as the displayed classification", async () => {
    for (const p of [
      "Write a Python function to calculate factorial.",
      "Explain why merge sort is O(n log n).",
      "Generate an image of a golden retriever.",
    ]) {
      const r = routingFromDecision(await routeQuery({ prompt: p }), 0);
      expect(r.subTaskLabel?.toLowerCase()).not.toBe("conversation");
    }
  }, 900_000);
});

describe("the three tiers rise strictly in intelligence", () => {
  const queries = [
    "Hi, how are you?",
    "Write a Python function to calculate factorial.",
    "Explain why merge sort is O(n log n).",
    "Generate an image of a golden retriever.",
    "Translate this sentence into Tamil.",
  ];

  it("orders Recommended < Alternative < Best", async () => {
    for (const q of queries) {
      const d = await routeQuery({ prompt: q });
      if (d.recommended && d.alternative) {
        expect(d.alternative.intelligence, q).toBeGreaterThan(d.recommended.intelligence);
      }
      if (d.alternative && d.best) {
        expect(d.best.intelligence, q).toBeGreaterThan(d.alternative.intelligence);
      }
    }
  }, 900_000);

  it("recommends the cheapest model that clears the query's bar", async () => {
    const d = await routeQuery({ prompt: "Hi, how are you?" });
    const clearing = d.eligible.filter(
      (m) => m.intelligence >= d.analysis.requiredIntelligence);
    if (clearing.length > 0) {
      const cheapest = Math.min(...clearing.map((m) => m.blendedCost));
      expect(d.recommended!.blendedCost).toBeCloseTo(cheapest, 6);
    }
  }, 300_000);

  it("draws every tier from the eligible set", async () => {
    const d = await routeQuery({ prompt: "Write a Python function to calculate factorial." });
    const ids = new Set(d.eligible.map((m) => m.modelId));
    for (const tier of [d.recommended, d.alternative, d.best]) {
      if (tier) expect(ids.has(tier.modelId)).toBe(true);
    }
  }, 300_000);

  it("satisfies List A ⊆ List B for every tier", async () => {
    const d = await routeQuery({ prompt: "Generate an image of a golden retriever." });
    for (const tier of [d.recommended, d.alternative, d.best]) {
      if (!tier) continue;
      for (const t of d.analysis.listA) expect(tier.listB, tier.modelId).toContain(t);
    }
  }, 300_000);

  it("leaves a tier empty rather than inventing or duplicating one", async () => {
    const d = await routeQuery({ prompt: "Hi, how are you?" });
    const filled = [d.recommended, d.alternative, d.best].filter(Boolean);
    const ids = filled.map((m) => m!.modelId);
    // No tier is ever a copy of the one below it.
    expect(new Set(ids).size).toBe(ids.length);

    const cards = optionsFromDecision(d).all;
    expect(cards.length).toBe(filled.length);
    // A card exists only where a model fills the tier.
    for (const c of cards) expect(ids).toContain(
      d.eligible.find((m) => m.openrouterId === c.modelId)!.modelId);
  }, 300_000);

  it("changes the recommendation when the query's capabilities change", async () => {
    const picks = new Set<string>();
    for (const q of queries) {
      const d = await routeQuery({ prompt: q });
      if (d.recommended) picks.add(d.recommended.modelId);
    }
    expect(picks.size).toBeGreaterThan(1);
  }, 900_000);
});

describe("cards carry real identities", () => {
  it("never labels a card with a placeholder model name", async () => {
    const d = await routeQuery({ prompt: "Hi, how are you?" });
    for (const c of optionsFromDecision(d).all) {
      // Swift / Balanced / Deep may describe a trade-off; they must never be
      // the name of the model that runs.
      expect(["Swift", "Balanced", "Deep"]).not.toContain(c.name);
      expect(c.modelId).toContain("/");
    }
  }, 300_000);
});
