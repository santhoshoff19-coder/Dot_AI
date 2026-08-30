import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  CapabilityMismatchError, generationRouter, UnsupportedModalityError,
} from "@/lib/generation/router";
import { modelIntelligence } from "@/lib/models/intelligence";

describe("generation router selects the method from output modality", () => {
  it("routes TEXT output to generateText", () => {
    expect(generationRouter.methodFor(["TEXT"])).toBe("generateText");
  });

  it("routes IMAGE output to generateImage, never text", () => {
    expect(generationRouter.methodFor(["IMAGE"])).toBe("generateImage");
  });

  it("reports an unsupported modality rather than degrading to text", () => {
    expect(generationRouter.methodFor(["EMBEDDING"])).toBe("unsupported");
  });
});

describe("capability enforcement at generation time", () => {
  it("refuses to generate an image with a text-only model", async () => {
    await modelIntelligence.ensureSeeded();
    await expect(
      generationRouter.generateImage("a cat", "openai/gpt-4o-mini"),
    ).rejects.toBeInstanceOf(CapabilityMismatchError);
  }, 30_000);

  it("produces a real image with an image-capable model", async () => {
    await modelIntelligence.ensureSeeded();

    // Chosen from the catalog rather than hard-coded. A named slug ties the
    // test to one vendor's naming: this test broke the day the live catalog
    // stopped carrying the model it named, which is exactly the coupling the
    // rest of the system is built to avoid.
    const imageModel = await prisma.model.findFirst({
      where: {
        active: true,
        modalities: { some: { direction: "OUTPUT", modality: "IMAGE" } },
      },
      select: { openrouterModelId: true },
    });

    if (!imageModel) {
      throw new Error("No image-capable model in the catalog to exercise.");
    }

    const r = await generationRouter.generateImage(
      "a cinematic cat on the moon", imageModel.openrouterModelId);
    expect(r.url.startsWith("data:image/")).toBe(true);
    // Mock output is labelled, never passed off as a provider image.
    expect(r.simulated).toBe(true);
    expect(r.url.length).toBeGreaterThan(500);
  }, 30_000);

  it("rejects an unknown model", async () => {
    await expect(
      generationRouter.generateImage("x", "nobody/nothing"),
    ).rejects.toBeInstanceOf(CapabilityMismatchError);
  }, 30_000);

  it("does not claim audio or video support", async () => {
    await expect(generationRouter.generateAudio()).rejects.toBeInstanceOf(UnsupportedModalityError);
    await expect(generationRouter.generateVideo()).rejects.toBeInstanceOf(UnsupportedModalityError);
  });
});
