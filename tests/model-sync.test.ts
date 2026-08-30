import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { deriveCategories, modelCatalogSyncService } from "@/lib/models/sync";
import { modelIntelligence } from "@/lib/models/intelligence";
import { routeRequest } from "@/lib/routing/orchestrator";

describe("category derivation from modalities", () => {
  it("text in, text out is a TEXT model", () => {
    expect(deriveCategories(["TEXT"], ["TEXT"])).toContain("TEXT");
  });

  it("text in, image out is an IMAGE model", () => {
    const cats = deriveCategories(["TEXT"], ["IMAGE"]);
    expect(cats).toContain("IMAGE");
    expect(cats).not.toContain("TEXT");
  });

  it("image in, text out stays a TEXT model — vision input is not image output", () => {
    const cats = deriveCategories(["TEXT", "IMAGE"], ["TEXT"]);
    expect(cats).toContain("TEXT");
    expect(cats).not.toContain("IMAGE");
  });

  it("audio in, text out is TRANSCRIPTION", () => {
    expect(deriveCategories(["AUDIO"], ["TEXT"])).toContain("TRANSCRIPTION");
  });

  it("embedding output is EMBEDDINGS", () => {
    expect(deriveCategories(["TEXT"], ["EMBEDDING"])).toContain("EMBEDDINGS");
  });
});

describe("catalog sync", () => {
  it("seeds shipped models with assessed capability profiles", async () => {
    await modelIntelligence.ensureSeeded();
    const models = await modelIntelligence.all();
    expect(models.length).toBeGreaterThanOrEqual(4);
    for (const m of models.filter((x) => x.assessmentSource === "MANUAL")) {
      expect(m.status).toBe("ASSESSED");
      expect(m.capability).not.toBeNull();
    }
  }, 30_000);

  it("records every sync attempt, including failures", async () => {
    const before = await prisma.modelSyncEvent.count();
    await modelCatalogSyncService.sync();
    expect(await prisma.modelSyncEvent.count()).toBeGreaterThan(before);
  }, 40_000);

  it("never breaks routing when synchronisation fails", async () => {
    // Force a failure by pointing at an unreachable host.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    let result;
    try {
      result = await modelCatalogSyncService.sync();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(result.status).toBe("FAILED");
    expect(result.error).toBeTruthy();

    // Routing still works on the existing catalog.
    const routed = await routeRequest({ prompt: "Summarize this article." });
    expect(routed.recommendedModel).toBeTruthy();
  }, 40_000);

  it("preserves dotAI capability data and outcomes across a sync", async () => {
    await modelIntelligence.ensureSeeded();
    const model = await prisma.model.findUnique({
      where: { openrouterModelId: "openai/gpt-4o-mini" },
    });
    expect(model).toBeTruthy();

    await prisma.modelCapability.update({
      where: { modelId: model!.id },
      data: { reliability: "HIGH", assessmentSource: "BENCHMARK", capabilityConfidence: 0.77 },
    });
    const outcomesBefore = await prisma.modelOutcome.count({ where: { modelId: model!.id } });

    await modelCatalogSyncService.sync();

    const after = await prisma.modelCapability.findUnique({ where: { modelId: model!.id } });
    expect(after?.reliability).toBe("HIGH");
    expect(after?.assessmentSource).toBe("BENCHMARK");
    expect(after?.capabilityConfidence).toBeCloseTo(0.77);
    expect(await prisma.modelOutcome.count({ where: { modelId: model!.id } }))
      .toBe(outcomesBefore);
  }, 60_000);
});
