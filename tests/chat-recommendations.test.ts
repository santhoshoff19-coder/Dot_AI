import { describe, expect, it } from "vitest";
import { routeQuery, requiredIntelligenceFor } from "@/lib/intelligence/curated-routing";
import { subTaskById } from "@/lib/intelligence/curated-dataset";
import { modelRegistry } from "@/lib/models/registry";

const st = (id: string) => subTaskById().get(id) ?? null;

describe("the requirement bar depends on the query", () => {
  it("asks less of a greeting than of a rigorous comparison", () => {
    const easy = requiredIntelligenceFor("Hi, how are you?", st("ST01"), ["MT001"]);
    const hard = requiredIntelligenceFor(
      "Compare these two financial strategies in depth and justify the trade-offs rigorously.",
      st("ST02"), ["MT014"]);
    expect(hard).toBeGreaterThan(easy);
  });

  it("rises with explicit demands for rigour", () => {
    const plain = requiredIntelligenceFor("Summarise this", st("ST04"), ["MT002"]);
    const rigorous = requiredIntelligenceFor(
      "Summarise this thoroughly and comprehensively", st("ST04"), ["MT002"]);
    expect(rigorous).toBeGreaterThan(plain);
  });

  it("rises when several capabilities are required at once", () => {
    const one = requiredIntelligenceFor("Extract the total", st("ST08"), ["MT046"]);
    const three = requiredIntelligenceFor(
      "Extract the total", st("ST08"), ["MT046", "MT045", "MT030"]);
    expect(three).toBeGreaterThan(one);
  });

  it("stays inside a range some model can clear", () => {
    // A bar nothing clears would silently fall back to the most expensive
    // model, which is the opposite of what it is for.
    for (const p of ["hi", "prove this rigorously in depth and comprehensively"]) {
      const v = requiredIntelligenceFor(p, st("ST02"), ["MT014", "MT015", "MT016"]);
      expect(v).toBeGreaterThanOrEqual(30);
      expect(v).toBeLessThanOrEqual(92);
    }
  });
});

describe("recommendations are query-dependent", () => {
  it("gives a greeting and a rigorous comparison different recommendations", async () => {
    const easy = await routeQuery({ prompt: "Hi, how are you?" });
    const hard = await routeQuery({
      prompt: "Compare these two financial strategies in depth and justify the trade-offs rigorously.",
    });

    expect(easy.recommended).not.toBeNull();
    expect(hard.recommended).not.toBeNull();
    // The complaint this answers: same broad task, same three models.
    expect(hard.recommended!.modelId).not.toBe(easy.recommended!.modelId);
    expect(hard.recommended!.intelligence)
      .toBeGreaterThan(easy.recommended!.intelligence);
  }, 300_000);

  it("keeps a simple query on an inexpensive model", async () => {
    const easy = await routeQuery({ prompt: "Hi, how are you?" });
    const cheapest = Math.min(...easy.eligible.map((m) => m.blendedCost));
    expect(easy.recommended!.blendedCost).toBeCloseTo(cheapest, 6);
  }, 300_000);

  it("never recommends a model below the query's bar when one clears it", async () => {
    const hard = await routeQuery({
      prompt: "Compare these two financial strategies in depth and justify the trade-offs rigorously.",
    });
    const clears = hard.eligible.filter(
      (m) => m.intelligence >= hard.analysis.requiredIntelligence);
    if (clears.length > 0) {
      expect(hard.recommended!.intelligence)
        .toBeGreaterThanOrEqual(hard.analysis.requiredIntelligence);
    }
  }, 300_000);
});

describe("recommendation cards carry real model identities", () => {
  it("never shows a seed placeholder name", async () => {
    const d = await routeQuery({ prompt: "Hi, how are you?" });
    // "Swift", "Balanced" and "Deep" are seed models in the local registry.
    // They were shown for every query because the synced catalog is empty.
    const placeholders = ["Swift", "Balanced", "Deep"];
    for (const pick of [d.recommended, d.best, d.alternative]) {
      if (pick) expect(placeholders).not.toContain(pick.name);
    }
  }, 300_000);

  it("carries an OpenRouter id alongside every name", async () => {
    const d = await routeQuery({ prompt: "Hi, how are you?" });
    for (const pick of [d.recommended, d.best, d.alternative]) {
      if (pick) {
        expect(pick.openrouterId).toBeTruthy();
        expect(pick.openrouterId).toContain("/");
        expect(pick.name).toBeTruthy();
      }
    }
  }, 300_000);

  it("offers three distinct models when three qualify", async () => {
    const d = await routeQuery({ prompt: "Hi, how are you?" });
    const ids = [d.recommended, d.best, d.alternative]
      .filter(Boolean).map((m) => m!.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  }, 300_000);

  it("seeds no models in production, so nothing can fall back to placeholders", () => {
    // The placeholders appeared because this registry shipped three seeded
    // models and routing fell back to them when the live catalog was empty.
    // An empty registry is what makes that impossible.
    expect(modelRegistry.all()).toHaveLength(0);
  });
});

describe("CAI telemetry is recorded", () => {
  it("names the analyser and reports usage", async () => {
    const d = await routeQuery({ prompt: "Hi, how are you?" });
    const t = d.analysis.telemetry;
    expect(t).toBeTruthy();
    expect(typeof t.inputTokens).toBe("number");
    expect(typeof t.outputTokens).toBe("number");
    expect(typeof t.costUsd).toBe("number");
    expect(t.latencyMs).toBeGreaterThanOrEqual(0);
    // A heuristic run called nothing and must not claim a model or a cost.
    if (d.analysis.source === "HEURISTIC") {
      expect(t.model).toBe("none");
      expect(t.costUsd).toBe(0);
    } else {
      expect(t.model).toBe("google/gemini-2.5-flash-lite");
    }
  }, 300_000);
});
