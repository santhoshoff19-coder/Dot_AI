import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { modelRegistry } from "@/lib/models/registry";
import { DEFAULT_SETTINGS } from "@/types";
import { routeQuery } from "@/lib/intelligence/curated-routing";
import { optionsFromDecision } from "@/lib/intelligence/cai-routing-result";

describe("no predetermined model mappings remain", () => {
  it("seeds no models in the registry", () => {
    // This list once bound "Swift" to openai/gpt-4o-mini, "Balanced" to
    // anthropic/claude-3.5-sonnet and "Deep" to openai/o1. With the live
    // catalog empty, the chat cards fell back to exactly those three for
    // every query.
    expect(modelRegistry.all()).toHaveLength(0);
  });

  it("still resolves any model id handed to it", () => {
    // Nothing depends on a model being listed; resolve() synthesises a spec.
    const spec = modelRegistry.resolve("some-provider/some-model");
    expect(spec.id).toBe("some-provider/some-model");
    expect(spec.provider).toBe("some-provider");
  });

  it("binds no model name to a model id anywhere in source", () => {
    for (const file of [
      "lib/models/registry.ts",
      "lib/models/intelligence.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      // The mappings may be described in comments explaining their removal,
      // but must not appear as code.
      const code = src.split("\n")
        .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
        .join("\n");
      expect(code, file).not.toContain('name: "Swift"');
      expect(code, file).not.toContain('name: "Balanced"');
      expect(code, file).not.toContain('name: "Deep"');
      expect(code, file).not.toContain("openai/gpt-4o-mini");
      expect(code, file).not.toContain("anthropic/claude-3.5-sonnet");
    }
  });
});

describe("settings shape a preference, they do not pin a model", () => {
  it("has no modelPreference field", () => {
    expect("modelPreference" in DEFAULT_SETTINGS).toBe(false);
  });

  it("offers a cost preference instead", () => {
    // A preference weighs cost among models that can do the job. Pinning a
    // model defeats capability matching, because the pinned model may not be
    // able to perform the query.
    expect(DEFAULT_SETTINGS.costPreference).toBe("BALANCED");
  });

  it("does not render a fixed model picker", () => {
    const src = readFileSync("app/settings/page.tsx", "utf8");
    expect(src).not.toContain("modelPreference");
    expect(src).not.toContain("modelRegistry");
    expect(src).toContain("costPreference");
  });
});

describe("cards carry real identities from the routing result", () => {
  it("never shows a placeholder name, and always shows the model id", async () => {
    const d = await routeQuery({ prompt: "Hi, how are you?" });
    const cards = optionsFromDecision(d).all;
    expect(cards.length).toBeGreaterThan(0);

    for (const c of cards) {
      expect(["Swift", "Balanced", "Deep"]).not.toContain(c.name);
      // Name and id both come from the dataset, so they cannot disagree.
      expect(c.modelId).toContain("/");
      const source = d.eligible.find((m) => m.openrouterId === c.modelId);
      expect(source, c.modelId).toBeTruthy();
      expect(c.name).toBe(source!.name);
    }
  }, 300_000);

  it("labels each card with its tier", async () => {
    const d = await routeQuery({ prompt: "Write a Python factorial function." });
    const roles = optionsFromDecision(d).all.map((c) => c.role);
    expect(new Set(roles).size).toBe(roles.length);
    expect(roles[0]).toBe("RECOMMENDED");
  }, 300_000);
});

describe("the manual-mode shortlist uses the same classifier as execution", () => {
  it("routes through CAI, not the old orchestrator", () => {
    const src = readFileSync("app/api/route/route.ts", "utf8");
    // Manual mode once called routeRequest, so the shortlist a user chose
    // from was classified differently from the request that then ran.
    expect(src).not.toContain("routeRequest");
    expect(src).toContain("routeQuery");
  });
});
