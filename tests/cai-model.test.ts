import { describe, expect, it } from "vitest";
import { CAI_MODEL, caiTimeoutMs } from "@/lib/cai/config";
import { routingConfig } from "@/lib/routing/routing-config";
import { analyseHeuristically } from "@/lib/intelligence/curated-routing";
import { miniTaskById } from "@/lib/intelligence/curated-dataset";

describe("CAI runs on Gemini 2.5 Flash Lite", () => {
  it("is the configured analyser", () => {
    expect(CAI_MODEL).toBe("google/gemini-2.5-flash-lite");
    expect(routingConfig.CAI_MODEL).toBe("google/gemini-2.5-flash-lite");
  });

  it("is not the offline evaluator's model", () => {
    // CAI sits in front of every request, so it must not inherit a model
    // chosen for slow, expensive, once-a-day work.
    expect(CAI_MODEL).not.toContain("opus");
  });

  it("bounds its own call and never degrades that bound to zero", () => {
    const original = process.env.CAI_TIMEOUT_MS;
    try {
      process.env.CAI_TIMEOUT_MS = "1234";
      expect(caiTimeoutMs()).toBe(1234);
      process.env.CAI_TIMEOUT_MS = "";
      expect(caiTimeoutMs()).toBeGreaterThan(1000);
    } finally {
      if (original === undefined) delete process.env.CAI_TIMEOUT_MS;
      else process.env.CAI_TIMEOUT_MS = original;
    }
  });
});

describe("the analyser's answer is validated, not trusted", () => {
  it("never accepts an input form outside the taxonomy", () => {
    // It returned the prompt itself ("Hi") as an input form, which resolved
    // to no sub-task and left every text query with zero eligible models.
    const a = analyseHeuristically("Hi");
    expect(["Text", "Image", "Document", "Structured Data"]).toContain(a.input);
  });

  it("lets the mini-tasks decide the output form", () => {
    // MT032 is Text-to-Image Synthesis; a List A containing it cannot belong
    // to a Text output however the analyser labelled it.
    expect(miniTaskById().get("MT032")?.output).toBe("Image");
  });

  it("records which model performed the analysis", () => {
    const a = analyseHeuristically("Hi");
    // Heuristic runs called no model, and say so rather than claiming CAI.
    expect(a.analyser).toBe("none");
    expect(a.source).toBe("HEURISTIC");
  });
});

describe("the offline Opus evaluator is gone", () => {
  it("leaves no module behind", async () => {
    // Asserted against the filesystem rather than by importing: a missing
    // module is a typecheck failure, so an import assertion would not
    // compile in the first place.
    const { existsSync } = await import("fs");
    for (const f of [
      "lib/intelligence/evaluator.ts",
      "lib/intelligence/evaluation-run.ts",
      "lib/intelligence/capability-probe.ts",
      "lib/intelligence/benchmark-seed.ts",
    ]) {
      expect(existsSync(f), f).toBe(false);
    }
  });
});
