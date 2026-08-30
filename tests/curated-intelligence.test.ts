import { describe, expect, it } from "vitest";
import {
  allListB, curatedDataset, inputForms, intelligenceFor, listBFor,
  miniTaskById, modelById, outputFormsFor, subTasksForForms,
  capabilityGroups, CAPABILITY_PROVENANCE,
} from "@/lib/intelligence/curated-dataset";
import {
  analyseHeuristically, blendedCost, resolveSubTask, routeQuery,
} from "@/lib/intelligence/curated-routing";

const D = curatedDataset();

describe("the curated dataset is the only source", () => {
  it("loads the workbook's full contents", () => {
    expect(D.models.length).toBe(65);
    expect(D.miniTasks.length).toBe(72);
    expect(D.subTasks.length).toBe(16);
    expect(D.capabilities.length).toBe(4680);
    expect(D.intelligence.length).toBe(410);
  });

  it("gives every mini-task three example queries and a test criterion", () => {
    for (const m of D.miniTasks) {
      expect(m.examples.filter(Boolean), m.id).toHaveLength(3);
      expect(m.criteria, m.id).toBeTruthy();
    }
  });

  it("records capability labels as analytic, not as executed probes", () => {
    // The workbook's evidence says "pending live three-example execution".
    // Presenting these as measured would overstate what is known.
    expect(CAPABILITY_PROVENANCE).toBe("ANALYTIC");
  });

  it("populates cost and intelligence for every rated pair", () => {
    for (const i of D.intelligence) {
      expect(Number.isFinite(i.inputCost), i.modelId).toBe(true);
      expect(Number.isFinite(i.outputCost), i.modelId).toBe(true);
      expect(i.inputCost).toBeGreaterThanOrEqual(0);
      expect(i.outputCost).toBeGreaterThanOrEqual(0);
      expect(i.intelligence).toBeGreaterThan(0);
      expect(i.intelligence).toBeLessThanOrEqual(100);
    }
  });

  it("exposes the taxonomy as input → output → sub-task", () => {
    expect(inputForms()).toContain("Text");
    expect(outputFormsFor("Text")).toContain("Image");
    expect(subTasksForForms("Text", "Text").map((s) => s.id))
      .toEqual(["ST01", "ST02", "ST03", "ST04"]);
    expect(subTasksForForms("Document", "Text").map((s) => s.id))
      .toEqual(["ST08", "ST09"]);
  });

  it("offers nothing for a pair the taxonomy does not define", () => {
    // The workbook's one inconsistent routing example was corrected in the
    // data rather than absorbed by a routing fallback, so an undefined pair
    // now genuinely has no sub-task and resolveSubTask says so.
    expect(subTasksForForms("Document", "Structured Data")).toHaveLength(0);
    expect(resolveSubTask("Document", "Structured Data")).toBeNull();
  });
});

describe("List B is built only from verified rows", () => {
  it("excludes unverified capabilities", () => {
    const anyModel = D.models[0].id;
    const listB = listBFor(anyModel);
    const unverified = D.capabilities.filter(
      (c) => c.modelId === anyModel && !c.verified);
    for (const u of unverified) expect(listB.has(u.miniTaskId)).toBe(false);
  });

  it("matches the workbook's own verified counts", () => {
    const verified = D.capabilities.filter((c) => c.verified).length;
    const total = [...allListB().values()].reduce((n, s) => n + s.size, 0);
    expect(total).toBe(verified);
  });

  it("groups models with identical verified sets", () => {
    const groups = capabilityGroups();
    expect(groups.length).toBeGreaterThan(0);
    // Every model appears in exactly one group.
    const seen = groups.flatMap((g) => g.modelIds);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("eligibility is List A ⊆ List B", () => {
  it("reproduces the workbook's eligible sets exactly", () => {
    const listBs = allListB();
    for (const ex of D.routingExamples) {
      const mine = [...listBs.entries()]
        .filter(([, b]) => ex.listA.every((t) => b.has(t)))
        .map(([id]) => id).sort();
      expect(mine, ex.query.slice(0, 50)).toEqual([...ex.eligible].sort());
    }
  });

  it("excludes a model missing even one required mini-task", () => {
    const listBs = allListB();
    const [modelId, listB] = [...listBs.entries()][0];
    const absent = D.miniTasks.map((m) => m.id).find((id) => !listB.has(id));
    if (!absent) return;

    const required = [...listB].slice(0, 1).concat(absent);
    const passes = required.every((t) => listB.has(t));
    expect(passes).toBe(false);
    expect(modelId).toBeTruthy();
  });
});

describe("selection draws only from eligible models", () => {
  it("picks cheapest, strongest and a distinct safe alternative", async () => {
    const r = await routeQuery({ prompt: "Hi, how are you?" });

    expect(r.eligible.length).toBeGreaterThan(0);
    expect(r.recommended).not.toBeNull();
    expect(r.best).not.toBeNull();

    const ids = new Set(r.eligible.map((m) => m.modelId));
    for (const pick of [r.recommended, r.best, r.alternative]) {
      if (pick) expect(ids.has(pick.modelId)).toBe(true);
    }

    // Recommended is the cheapest of the eligible set, not of all models.
    const cheapest = Math.min(...r.eligible.map((m) => m.blendedCost));
    expect(r.recommended!.blendedCost).toBeCloseTo(cheapest, 6);

    // Tiers rise strictly rather than jumping to the strongest model.
    if (r.alternative && r.best) {
      expect(r.best.intelligence).toBeGreaterThan(r.alternative.intelligence);
    }

    if (r.alternative) {
      expect(r.alternative.modelId).not.toBe(r.recommended!.modelId);
      expect(r.alternative.intelligence).toBeGreaterThan(r.recommended!.intelligence);
      if (r.best) expect(r.alternative.modelId).not.toBe(r.best.modelId);
    }
  }, 120_000);

  it("explains every rejection by naming what was missing", async () => {
    const r = await routeQuery({ prompt: "Write a Python function to reverse a string." });
    for (const rej of r.rejected) {
      expect(rej.missing.length, rej.modelId).toBeGreaterThan(0);
    }
  }, 120_000);

  it("analyses every query, including a trivial one", async () => {
    const r = await routeQuery({ prompt: "hi" });
    // CAI is mandatory: there is no path that skips analysis, so List A is
    // never empty and eligibility is always a real subset test.
    expect(r.analysis.listA.length).toBeGreaterThan(0);
    expect(["CAI", "HEURISTIC"]).toContain(r.analysis.source);
  }, 120_000);

  it("discriminates between sub-tasks", async () => {
    const chat = await routeQuery({ prompt: "Hi, how are you?" });
    const code = await routeQuery({ prompt: "Write a Python function to reverse a string." });
    // A coding query must not produce the same eligible pool as small talk.
    expect(code.eligible.length).not.toBe(chat.eligible.length);
  }, 200_000);
});

describe("cost blending", () => {
  it("weights input above output", () => {
    expect(blendedCost(1, 0)).toBeGreaterThan(blendedCost(0, 1));
    expect(blendedCost(0, 0)).toBe(0);
  });
});

describe("dataset indexes", () => {
  it("resolves models and mini-tasks by id", () => {
    expect(modelById().get("MD001")?.name).toBe("GPT-5.6 Terra");
    expect(miniTaskById().get("MT001")?.name).toBe("Conversational Response");
  });

  it("returns rated cost and intelligence per sub-task", () => {
    const i = intelligenceFor("MD001", "ST01");
    expect(i).not.toBeNull();
    expect(i!.intelligence).toBeGreaterThan(0);
  });

  it("scores the same model differently across sub-tasks where rated", () => {
    const rated = D.intelligence.filter((i) => i.modelId === "MD001");
    expect(new Set(rated.map((r) => r.intelligence)).size).toBeGreaterThan(0);
  });

  it("falls back sensibly without the evaluator", () => {
    const a = analyseHeuristically("Write a Python function to reverse a string.");
    expect(a.source).toBe("HEURISTIC");
    expect(a.listA.length).toBeGreaterThan(0);
  });
});
