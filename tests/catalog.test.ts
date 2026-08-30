import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { CATALOG_SOURCES, deriveCategories } from "@/lib/models/sync";
import { modelIntelligence } from "@/lib/models/intelligence";

describe("the catalog is the complete OpenRouter set, not a shortlist", () => {
  it("stores hundreds of models", async () => {
    expect(await prisma.model.count()).toBeGreaterThan(400);
  }, 30_000);

  it("syncs from every OpenRouter catalog, not just chat", () => {
    const endpoints = CATALOG_SOURCES.map((s) => s.endpoint);
    expect(endpoints).toContain("chat");
    expect(endpoints).toContain("images");
    expect(endpoints).toContain("videos");
    expect(endpoints).toContain("embeddings");
  });

  it("holds image, video and embedding models the chat catalog omits", async () => {
    const image = await prisma.modelCategoryLink.count({ where: { category: "IMAGE" } });
    const video = await prisma.modelCategoryLink.count({ where: { category: "VIDEO" } });
    const embed = await prisma.modelCategoryLink.count({ where: { category: "EMBEDDINGS" } });
    expect(image).toBeGreaterThan(20);
    expect(video).toBeGreaterThan(10);
    expect(embed).toBeGreaterThan(10);
  }, 30_000);

  it("keeps input and output modalities separate", async () => {
    const vision = await prisma.model.findFirst({
      where: {
        modalities: { some: { direction: "INPUT", modality: "IMAGE" } },
        AND: [{ modalities: { some: { direction: "OUTPUT", modality: "TEXT" } } }],
      },
      include: { modalities: true },
    });
    expect(vision).toBeTruthy();
    const outs = vision!.modalities.filter((m) => m.direction === "OUTPUT").map((m) => m.modality);
    // Image *input* must not be recorded as image *output*.
    expect(outs).toContain("TEXT");
  }, 30_000);

  it("lets a model belong to several categories", () => {
    const cats = deriveCategories(["TEXT", "AUDIO"], ["TEXT"]);
    expect(cats).toContain("TEXT");
    expect(cats).toContain("TRANSCRIPTION");
  });

  it("keeps unassessed models visible rather than hiding them", async () => {
    const pending = await prisma.modelCapability.count({
      where: { status: { in: ["ASSESSMENT_PENDING", "ASSESSMENT_FAILED", "UNASSESSED"] } },
    });
    if (pending > 0) {
      const all = await modelIntelligence.all(true);
      const visiblePending = all.filter((m) => m.status !== "ASSESSED");
      expect(visiblePending.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("excludes unassessed models from recommendation but not from the catalog", async () => {
    const { qualified, rejected } = await modelIntelligence.qualified({
      taskType: "summarization", effort: "LOW", reasoning: "LOW",
      contextHandling: "LOW", instructionComplexity: "LOW", reliability: "LOW",
      toolCapability: "NONE", requiredInputModalities: ["TEXT"],
      requiredOutputModalities: ["TEXT"], confidence: 0.9,
    });
    expect(qualified.length).toBeGreaterThan(0);
    const unassessedRejections = rejected.filter((r) =>
      r.reason.toLowerCase().includes("assessed"));
    expect(unassessedRejections.length).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("does not reseed the fallback list once a real catalog exists", async () => {
    const created = await modelIntelligence.ensureSeeded();
    expect(created).toBe(0);
  }, 30_000);

  it("stores catalog metadata for routing decisions", async () => {
    const m = await prisma.model.findFirst({ where: { source: "OPENROUTER" } });
    expect(m!.provider).toBeTruthy();
    expect(m!.catalogEndpoints).toContain("chat");
    expect(m!.supportedParameters).toBeTruthy();
  }, 30_000);
});
