import { describe, expect, it } from "vitest";
import { routeQuery } from "@/lib/intelligence/curated-routing";
import { fastRouter } from "@/lib/routing/fast-router";

/**
 * The bug this fixture guards: the UI displayed the fast router's coarse
 * routing bucket, which labels most text prompts "conversation". A coding
 * question, a reasoning question and a greeting all read as Conversation
 * while CAI had correctly identified three different sub-tasks.
 */
describe("classification comes from CAI, not the routing bucket", () => {
  it("the fast router really does bucket most text prompts as conversation", () => {
    // Documented, not fixed: this value is still what sets risk level and
    // verification depth. It simply no longer speaks for the classification.
    const coarse = ["Write a Python function to calculate factorial.",
      "Explain why this algorithm is O(n log n).",
      "Compare these two financial strategies."]
      .map((p) => fastRouter.route({ prompt: p, attachments: [] } as never).taskType);
    expect(coarse.every((t) => t === "conversation")).toBe(true);
  });

  it("CAI separates those same prompts into different sub-tasks", async () => {
    const seen = new Set<string>();
    for (const p of [
      "Hi, how are you?",
      "Write a Python function to calculate factorial.",
      "Explain why this algorithm is O(n log n).",
      "Generate an image of a golden retriever.",
    ]) {
      const d = await routeQuery({ prompt: p });
      seen.add(d.analysis.subTaskName);
    }
    // Four prompts that the routing bucket cannot tell apart.
    expect(seen.size).toBeGreaterThan(1);
  }, 600_000);

  it("routes a coding prompt to Coding", async () => {
    const d = await routeQuery({ prompt: "Write a Python function to calculate factorial." });
    expect(d.analysis.subTaskName.toLowerCase()).toContain("coding");
  }, 300_000);

  it("routes an image prompt to Text → Image", async () => {
    const d = await routeQuery({ prompt: "Generate an image of a golden retriever." });
    expect(d.analysis.output).toBe("Image");
    expect(d.analysis.subTaskName.toLowerCase()).toContain("image");
  }, 300_000);

  it("routes a document prompt to Document input", async () => {
    const d = await routeQuery({
      prompt: "Extract invoice number, tax and total from this PDF.",
      attachments: [{ type: "document" }],
    });
    expect(d.analysis.input).toBe("Document");
  }, 300_000);
});

describe("List A is specific to the query, not to the sub-task", () => {
  it("gives two prompts in one sub-task different capability sets", async () => {
    const a = await routeQuery({ prompt: "Hi, how are you?" });
    const b = await routeQuery({ prompt: "Summarize this document." });
    // Both land in general text handling, yet need different capabilities.
    expect(a.analysis.listA.join(",")).not.toBe(b.analysis.listA.join(","));
  }, 600_000);

  it("never returns an empty List A", async () => {
    // An empty requirement set would make every model eligible, which is the
    // opposite of capability matching.
    for (const p of ["Hi", "Translate this into Tamil."]) {
      const d = await routeQuery({ prompt: p });
      expect(d.analysis.listA.length).toBeGreaterThan(0);
    }
  }, 600_000);

  it("eligible models satisfy List A ⊆ List B", async () => {
    const d = await routeQuery({ prompt: "Write a Python function to calculate factorial." });
    for (const m of d.eligible) {
      for (const t of d.analysis.listA) {
        expect(m.listB, `${m.modelId} missing ${t}`).toContain(t);
      }
    }
  }, 300_000);

  it("names the missing capability for every rejected model", async () => {
    const d = await routeQuery({ prompt: "Generate an image of a golden retriever." });
    expect(d.rejected.length).toBeGreaterThan(0);
    for (const r of d.rejected) expect(r.missing.length).toBeGreaterThan(0);
  }, 300_000);
});

describe("recommendations are recalculated per query", () => {
  it("changes the recommended model across materially different queries", async () => {
    const picks = new Set<string>();
    for (const p of [
      "Hi, how are you?",
      "Write a Python function to calculate factorial.",
      "Generate an image of a golden retriever.",
      "Summarize this document.",
    ]) {
      const d = await routeQuery({ prompt: p });
      if (d.recommended) picks.add(d.recommended.modelId);
    }
    // Not the same three models regardless of the request.
    expect(picks.size).toBeGreaterThan(1);
  }, 900_000);

  it("draws all three choices from the eligible set only", async () => {
    const d = await routeQuery({ prompt: "Compare these two financial strategies." });
    const ids = new Set(d.eligible.map((m) => m.modelId));
    for (const pick of [d.recommended, d.best, d.alternative]) {
      if (pick) expect(ids.has(pick.modelId)).toBe(true);
    }
  }, 300_000);

  it("defines Best as a strict step up from Alternative", async () => {
    // Best is no longer "the highest-intelligence eligible model". The three
    // tiers rise strictly, so Best is the cheapest model stronger than
    // Alternative - which keeps the ladder about capability gained rather
    // than simply naming the most expensive option available.
    const d = await routeQuery({ prompt: "Hi, how are you?" });
    if (d.alternative && d.best) {
      expect(d.best.intelligence).toBeGreaterThan(d.alternative.intelligence);
    }
    if (d.recommended && d.alternative) {
      expect(d.alternative.intelligence).toBeGreaterThan(d.recommended.intelligence);
    }
  }, 300_000);
});
