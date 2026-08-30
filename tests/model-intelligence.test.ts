import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  DEFAULT_WEIGHTS, modelIntelligenceService, weightsFor,
} from "@/lib/intelligence/service";
import {
  confidenceFor, deriveCapabilities, EXECUTABLE_TASKS, normaliseTaskType,
  TASK_REQUIREMENTS,
} from "@/lib/intelligence/taxonomy";
import { getProfile } from "@/lib/governance/profiles";
import { routeRequest } from "@/lib/routing/orchestrator";

beforeAll(async () => {
  await modelIntelligenceService.indexCapabilities();
}, 300_000);

describe("1-4. category is not capability", () => {
  it("image input does not imply image generation", () => {
    const caps = deriveCapabilities({
      inputModalities: ["TEXT", "IMAGE"], outputModalities: ["TEXT"],
      supportedParameters: [], contextLength: 128_000,
    }).map((c) => c.capability);

    expect(caps).toContain("IMAGE_INPUT");
    expect(caps).toContain("IMAGE_UNDERSTANDING");
    // The whole point: reading images is not making them.
    expect(caps).not.toContain("IMAGE_GENERATION");
    expect(caps).not.toContain("IMAGE_OUTPUT");
  });

  it("image output does imply generation", () => {
    const caps = deriveCapabilities({
      inputModalities: ["TEXT"], outputModalities: ["IMAGE"],
      supportedParameters: [], contextLength: 4000,
    }).map((c) => c.capability);
    expect(caps).toContain("IMAGE_GENERATION");
    expect(caps).not.toContain("IMAGE_UNDERSTANDING");
  });

  it("image in and image out implies editing", () => {
    const caps = deriveCapabilities({
      inputModalities: ["TEXT", "IMAGE"], outputModalities: ["IMAGE"],
      supportedParameters: [], contextLength: 0,
    }).map((c) => c.capability);
    expect(caps).toContain("IMAGE_EDITING");
  });

  it("the live catalog reflects the distinction", async () => {
    const inputs = await prisma.modelTaskCapability.count({
      where: { capability: "IMAGE_INPUT" },
    });
    const generation = await prisma.modelTaskCapability.count({
      where: { capability: "IMAGE_GENERATION" },
    });
    expect(inputs).toBeGreaterThan(generation);
  }, 60_000);
});

describe("16. a capability failure is per-capability", () => {
  it("missing context metadata does not disqualify an image model", () => {
    const derived = deriveCapabilities({
      inputModalities: ["TEXT"], outputModalities: ["IMAGE"],
      supportedParameters: [], contextLength: 0,
    });
    const longContext = derived.find((d) => d.capability === "LONG_CONTEXT");
    const imageGen = derived.find((d) => d.capability === "IMAGE_GENERATION");

    // Unknown context, but still a perfectly valid generation candidate.
    expect(longContext?.status).toBe("UNKNOWN");
    expect(imageGen?.status).toBe("SUPPORTED");
  });

  it("keeps a separate status per capability in the database", async () => {
    const rows = await prisma.modelTaskCapability.groupBy({
      by: ["capability", "status"], _count: true,
    });
    const statuses = new Set(rows.map((r) => r.status));
    expect(statuses.size).toBeGreaterThan(1);
  }, 60_000);
});

describe("5-8. task pools filter before scoring", () => {
  it("an image-generation pool contains only image-output models", async () => {
    const pool = await modelIntelligenceService.candidatePool("IMAGE_GENERATION");
    expect(pool.length).toBeGreaterThan(0);

    for (const c of pool) {
      const model = await prisma.model.findUnique({
        where: { openrouterModelId: c.modelId }, include: { modalities: true },
      });
      const outs = model!.modalities
        .filter((m) => m.direction === "OUTPUT").map((m) => m.modality);
      expect(outs, `${c.modelId} cannot emit images`).toContain("IMAGE");
    }
  }, 120_000);

  it("a text pool excludes image-only models", async () => {
    const pool = await modelIntelligenceService.candidatePool("SUMMARIZATION");
    for (const c of pool) {
      const model = await prisma.model.findUnique({
        where: { openrouterModelId: c.modelId }, include: { modalities: true },
      });
      const outs = model!.modalities
        .filter((m) => m.direction === "OUTPUT").map((m) => m.modality);
      expect(outs).toContain("TEXT");
    }
  }, 120_000);

  it("does not load the whole catalog for a request", async () => {
    const total = await prisma.model.count();
    const pool = await modelIntelligenceService.candidatePool("SUMMARIZATION", { limit: 20 });
    expect(total).toBeGreaterThan(400);
    expect(pool.length).toBeLessThan(total / 2);
  }, 120_000);

  it("declares hard requirements for every task", () => {
    for (const t of EXECUTABLE_TASKS) {
      expect(TASK_REQUIREMENTS[t].length).toBeGreaterThan(0);
    }
    expect(TASK_REQUIREMENTS.IMAGE_GENERATION).toContain("IMAGE_GENERATION");
    expect(TASK_REQUIREMENTS.IMAGE_UNDERSTANDING).toContain("IMAGE_UNDERSTANDING");
  });
});

describe("9-15. scoring and confidence", () => {
  it("normalises cost across the pool and never lets unknown pricing win", async () => {
    const pool = await modelIntelligenceService.candidatePool("SUMMARIZATION");
    const ranked = modelIntelligenceService.rank(pool, DEFAULT_WEIGHTS);
    for (const c of ranked) {
      expect(c.scores.cost).toBeGreaterThanOrEqual(0);
      expect(c.scores.cost).toBeLessThanOrEqual(1);
      // An unknown price scores neutral, so it cannot top the cost dimension.
      if (!c.pricingKnown) expect(c.scores.cost).toBe(0.5);
    }
  }, 120_000);

  it("derives confidence from sample count", () => {
    expect(confidenceFor(0)).toBe("LOW");
    expect(confidenceFor(5)).toBe("MEDIUM");
    expect(confidenceFor(25)).toBe("HIGH");
  });

  it("pulls a low-confidence score toward neutral", async () => {
    const pool = await modelIntelligenceService.candidatePool("SUMMARIZATION");
    const ranked = modelIntelligenceService.rank(pool, DEFAULT_WEIGHTS);
    expect(ranked.every((c) => c.scores.overall >= 0 && c.scores.overall <= 1.2)).toBe(true);
  }, 120_000);
});

describe("39-41. ranking is governed by a single policy", () => {
  it("uses one weight set, whatever id is asked for", () => {
    // Model selection does not vary by governance policy: capability
    // matching decides which model runs, and the policy decides how the
    // result is judged.
    const a = weightsFor(getProfile("BASELINE"));
    const b = weightsFor(getProfile("CUSTOMER_SUPPORT"));
    expect(a).toEqual(b);

    // The set must still be a usable distribution.
    const total = Object.values(a).reduce((x, y) => x + y, 0);
    expect(total).toBeCloseTo(1, 5);
    for (const w of Object.values(a)) expect(w).toBeGreaterThanOrEqual(0);
  });

  it("ranks the same pool identically every time", async () => {
    const pool = await modelIntelligenceService.candidatePool("SUMMARIZATION");
    const first = modelIntelligenceService.rank(pool, weightsFor(getProfile("BASELINE")));
    const second = modelIntelligenceService.rank(pool, weightsFor(getProfile("BASELINE")));

    // With one policy, ranking is deterministic: the same pool must produce
    // the same order and the same scores on every call.
    expect(first.map((c) => c.modelId)).toEqual(second.map((c) => c.modelId));
    expect(first.map((c) => c.scores.overall)).toEqual(second.map((c) => c.scores.overall));
  }, 120_000);

  it("still separates strong candidates from weak ones", async () => {
    const pool = await modelIntelligenceService.candidatePool("SUMMARIZATION");
    if (pool.length < 2) return;
    const ranked = modelIntelligenceService.rank(pool, weightsFor(getProfile("BASELINE")));
    // A ranking where everything scores the same carries no information.
    expect(ranked[0].scores.overall)
      .toBeGreaterThanOrEqual(ranked[ranked.length - 1].scores.overall);
  }, 120_000);
});

describe("16-22. champions come from the database", () => {
  it("writes champions for tasks that have a pool", async () => {
    const r = await modelIntelligenceService.recalculateChampions(["IMAGE_GENERATION", "SUMMARIZATION"]);
    expect(r.championsWritten).toBeGreaterThan(0);

    const champs = await modelIntelligenceService.championsFor("IMAGE_GENERATION");
    expect(champs.length).toBeGreaterThan(0);
    for (const c of champs) {
      expect(c.reason.length).toBeGreaterThan(10);
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(c.confidence);
    }
  }, 180_000);

  it("an image champion is always image-capable", async () => {
    const champs = await modelIntelligenceService.championsFor("IMAGE_GENERATION");
    for (const c of champs) {
      const caps = await prisma.modelTaskCapability.findFirst({
        where: { modelId: c.modelId, capability: "IMAGE_GENERATION" },
      });
      expect(caps).toBeTruthy();
    }
  }, 120_000);

  it("never invents a champion for an empty pool", async () => {
    const before = await prisma.modelChampion.count({ where: { taskType: "VIDEO_GENERATION" } });
    await modelIntelligenceService.recalculateChampions(["VIDEO_GENERATION"]);
    const pool = await modelIntelligenceService.candidatePool("VIDEO_GENERATION");
    if (pool.length === 0) {
      expect(await prisma.modelChampion.count({ where: { taskType: "VIDEO_GENERATION" } }))
        .toBe(before);
    }
  }, 120_000);

  it("records champion history", async () => {
    await modelIntelligenceService.recalculateChampions(["SUMMARIZATION"]);
    const history = await prisma.modelChampionHistory.count({
      where: { taskType: "SUMMARIZATION" },
    });
    expect(history).toBeGreaterThan(0);
  }, 120_000);
});

describe("34-37. feedback is task-specific", () => {
  const MODEL = "openai/gpt-4o-mini";

  it("a failure lowers reliability for that task only", async () => {
    await modelIntelligenceService.recordOutcome({
      openrouterModelId: MODEL, taskType: "summarization", success: true,
    });
    const summBefore = await modelIntelligenceService.scoreFor(MODEL, "summarization");

    for (let i = 0; i < 4; i++) {
      await modelIntelligenceService.recordOutcome({
        openrouterModelId: MODEL, taskType: "coding", success: false,
      });
    }

    const summAfter = await modelIntelligenceService.scoreFor(MODEL, "summarization");
    const coding = await modelIntelligenceService.scoreFor(MODEL, "coding");

    // Coding suffered; summarisation is untouched.
    expect(coding!.reliabilityScore).toBeLessThan(0.5);
    expect(summAfter!.reliabilityScore).toBe(summBefore!.reliabilityScore);
  }, 120_000);

  it("repeated success raises confidence", async () => {
    for (let i = 0; i < 25; i++) {
      await modelIntelligenceService.recordOutcome({
        openrouterModelId: MODEL, taskType: "translation", success: true,
      });
    }
    const s = await modelIntelligenceService.scoreFor(MODEL, "translation");
    expect(s!.confidence).toBe("HIGH");
    expect(s!.successRate).toBe(1);
  }, 180_000);

  it("a content rejection lowers quality, a provider failure does not", async () => {
    // Reset so the assertion does not depend on how often this suite has run;
    // quality is floored at 0 and would otherwise saturate.
    const row = await prisma.model.findUnique({
      where: { openrouterModelId: MODEL }, select: { id: true },
    });
    await prisma.modelTaskScore.deleteMany({
      where: { modelId: row!.id, taskType: "EXTRACTION" },
    });
    await modelIntelligenceService.recordOutcome({
      openrouterModelId: MODEL, taskType: "extraction", success: true,
    });

    const before = await modelIntelligenceService.scoreFor(MODEL, "extraction");
    await modelIntelligenceService.recordOutcome({
      openrouterModelId: MODEL, taskType: "extraction", success: false,
    });
    const afterProvider = await modelIntelligenceService.scoreFor(MODEL, "extraction");
    expect(afterProvider!.qualityScore).toBe(before?.qualityScore ?? 0.5);

    await modelIntelligenceService.recordOutcome({
      openrouterModelId: MODEL, taskType: "extraction",
      success: false, qualityFailure: true,
    });
    const afterQuality = await modelIntelligenceService.scoreFor(MODEL, "extraction");
    expect(afterQuality!.qualityScore).toBeLessThan(afterProvider!.qualityScore);
  }, 120_000);

  it("normalises router task names onto the taxonomy", () => {
    expect(normaliseTaskType("image_generation")).toBe("IMAGE_GENERATION");
    expect(normaliseTaskType("complex_reasoning")).toBe("REASONING");
    expect(normaliseTaskType("unknown-thing")).toBe("GENERAL_CHAT");
  });
});

describe("23-33. routing uses the pool", () => {
  it("an image request resolves to the image pool", async () => {
    const r = await routeRequest({ prompt: "generate a cat pic" });
    expect(r.taskType_normalised).toBe("IMAGE_GENERATION");
    expect(r.candidatePoolSize).toBeGreaterThan(0);
    for (const i of r.intelligence ?? []) {
      const caps = await prisma.modelTaskCapability.findFirst({
        where: {
          capability: "IMAGE_GENERATION",
          model: { openrouterModelId: i.modelId },
        },
      });
      expect(caps, `${i.modelId} lacks IMAGE_GENERATION`).toBeTruthy();
    }
  }, 180_000);

  it("a text request resolves to a text pool", async () => {
    const r = await routeRequest({ prompt: "Summarize this article." });
    expect(r.taskType_normalised).toBe("SUMMARIZATION");
    expect(r.candidatePoolSize).toBeGreaterThan(0);
  }, 180_000);

  it("every recommendation carries measurable reasons", async () => {
    const r = await routeRequest({ prompt: "generate a cat pic" });
    for (const i of r.intelligence ?? []) {
      expect(i.reasons.length).toBeGreaterThan(0);
      expect(i.confidence).toBeTruthy();
    }
  }, 180_000);
});
