import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  detectOutputIntent, wantsImageEditing, wantsImageGeneration,
} from "@/lib/routing/modality-intent";
import { resolveOutputModality } from "@/lib/documents/matrix";
import { fastRouter } from "@/lib/routing/fast-router";
import { caiService } from "@/lib/cai/service";
import { routeRequest } from "@/lib/routing/orchestrator";
import { hasKnownPrice, perMillion, PRICE_UNKNOWN } from "@/lib/models/sync";
import type { AttachmentRef } from "@/types";

const img: AttachmentRef = {
  id: "i", name: "a.png", mimeType: "image/png", size: 10, type: "image",
  previewUrl: null, storageRef: null, extractedText: null,
};

/** The exact phrasings from the bug report, plus natural variants. */
const IMAGE_REQUESTS = [
  "generate a cat pic",
  "create an image of a dog",
  "draw a futuristic city",
  "make me a picture of a mountain",
  "create an illustration of a robot",
  "generate a poster",
  "design a logo",
  "make a photo of a sunset",
  "create an infographic",
  "generate an image",
  "sketch a bridge at dawn",
  "give me a wallpaper of deep space",
  "can you make a banner for our launch",
  "i want a portrait of a fox",
  "paint a stormy sea",
];

const TEXT_REQUESTS = [
  "write a report on quarterly results",
  "summarize this article",
  "explain quantum computing simply",
  "what is the capital of France",
  "translate this to French",
];

describe("ROOT CAUSE: image intent is detected once, consistently", () => {
  it("classifies 'generate a cat pic' as TEXT to IMAGE", () => {
    const intent = detectOutputIntent("generate a cat pic");
    expect(intent.output).toBe("IMAGE");
    expect(intent.signal).toBe("PRODUCE_IMAGE");
  });

  it("recognises every natural phrasing of an image request", () => {
    for (const p of IMAGE_REQUESTS) {
      expect(detectOutputIntent(p).output, `failed on: ${p}`).toBe("IMAGE");
    }
  });

  it("does not treat ordinary text requests as image requests", () => {
    for (const p of TEXT_REQUESTS) {
      expect(detectOutputIntent(p).output, `false positive on: ${p}`).toBe("TEXT");
    }
  });

  it("the matrix, the fast router and CAI all agree", () => {
    for (const p of [...IMAGE_REQUESTS, ...TEXT_REQUESTS]) {
      const matrix = resolveOutputModality(p).output;
      const cai = caiService.classify({ prompt: p }).requiredOutputModalities[0];
      const router = fastRouter.route({ prompt: p }).taskType;

      expect(matrix === "IMAGE", `matrix/cai disagree on: ${p}`)
        .toBe(cai === "IMAGE");
      if (matrix === "IMAGE") {
        expect(router, `router disagrees on: ${p}`).toBe("image_generation");
      }
    }
  });

  it("is not hardcoded to any particular subject", () => {
    for (const subject of ["capybara", "nebula", "1920s tram", "quantum foam"]) {
      expect(detectOutputIntent(`generate a pic of a ${subject}`).output).toBe("IMAGE");
    }
  });
});

describe("input modality does not determine output modality", () => {
  it("image input with a question is vision: IMAGE to TEXT", () => {
    const r = detectOutputIntent("what is in this image?", { hasImageInput: true });
    expect(r.output).toBe("TEXT");
    expect(r.signal).toBe("ASK_ABOUT_INPUT");
  });

  it("image input with an edit request is IMAGE to IMAGE", () => {
    const r = detectOutputIntent("edit this image and make the sky blue", {
      hasImageInput: true,
    });
    expect(r.output).toBe("IMAGE");
    expect(r.signal).toBe("EDIT_IMAGE");
    expect(wantsImageEditing("edit this image and make the sky blue", true)).toBe(true);
  });

  it("the same edit phrasing without an image is not image editing", () => {
    expect(wantsImageEditing("edit this and make it shorter", false)).toBe(false);
  });

  it("document input with an infographic request is DOCUMENT to IMAGE", () => {
    const r = detectOutputIntent("create an infographic from this", {
      hasDocumentInput: true,
    });
    expect(r.output).toBe("IMAGE");
  });

  it("a DOCX request outranks an image noun", () => {
    const r = detectOutputIntent("create an infographic report as a DOCX");
    expect(r.output).toBe("DOCUMENT");
  });

  it("separates generation from editing", () => {
    expect(wantsImageGeneration("generate a cat pic")).toBe(true);
    expect(wantsImageGeneration("edit this image", { hasImageInput: true })).toBe(false);
  });
});

describe("end to end: 'generate a cat pic' routes to image models", () => {
  it("requires IMAGE output and qualifies only image-capable models", async () => {
    const r = await routeRequest({ prompt: "generate a cat pic" });

    expect(r.taskType).toBe("image_generation");
    expect(r.requirementProfile?.requiredInputModalities).toContain("TEXT");
    expect(r.requirementProfile?.requiredOutputModalities).toEqual(["IMAGE"]);

    for (const o of r.options.all) {
      const model = await prisma.model.findUnique({
        where: { openrouterModelId: o.modelId }, include: { modalities: true },
      });
      const outs = model!.modalities
        .filter((m) => m.direction === "OUTPUT").map((m) => m.modality);
      expect(outs, `${o.modelId} cannot emit images`).toContain("IMAGE");
    }
  }, 120_000);

  it("never offers a text-only model for image generation", async () => {
    const r = await routeRequest({ prompt: "draw a futuristic city" });
    const ids = r.options.all.map((o) => o.modelId);
    expect(ids).not.toContain("openai/gpt-4o-mini");
    expect(ids).not.toContain("openai/o1");
    expect(ids).not.toContain("anthropic/claude-3.5-sonnet");
  }, 120_000);

  it("a vision request still routes to text output", async () => {
    const r = await routeRequest({
      prompt: "what is in this image?", attachments: [img],
    });
    expect(r.requirementProfile?.requiredOutputModalities).toEqual(["TEXT"]);
    expect(r.requirementProfile?.requiredInputModalities).toContain("IMAGE");
  }, 120_000);
});

describe("PRICING: sentinel values are never treated as prices", () => {
  it("maps OpenRouter's -1 sentinel to unknown, not to a negative price", () => {
    expect(perMillion("-1")).toBe(PRICE_UNKNOWN);
    expect(perMillion("-1")).not.toBe(-1_000_000);
  });

  it("converts real prices correctly", () => {
    expect(perMillion("0.00000015")).toBeCloseTo(0.15, 6);
    expect(perMillion("0")).toBe(0);
  });

  it("rejects NaN and Infinity", () => {
    expect(perMillion("not-a-number")).toBe(PRICE_UNKNOWN);
    expect(perMillion(String(Infinity))).toBe(PRICE_UNKNOWN);
  });

  it("identifies which prices are usable", () => {
    expect(hasKnownPrice(0.15)).toBe(true);
    expect(hasKnownPrice(0)).toBe(true);
    expect(hasKnownPrice(-1)).toBe(false);
    expect(hasKnownPrice(NaN)).toBe(false);
  });

  it("no stored model carries an absurd negative price", async () => {
    const absurd = await prisma.model.count({
      where: { OR: [{ inputPrice: { lt: -1 } }, { outputPrice: { lt: -1 } }] },
    });
    expect(absurd).toBe(0);
  }, 60_000);

  it("an unknown-price model never wins the cheapest recommendation", async () => {
    const r = await routeRequest({ prompt: "Summarize this article." });
    const rec = await prisma.model.findUnique({
      where: { openrouterModelId: r.options.recommendable.modelId },
    });
    // The recommended model must have a real, comparable price.
    expect(rec!.inputPrice).toBeGreaterThanOrEqual(0);
    expect(rec!.outputPrice).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.options.recommendable.estimatedCost)).toBe(true);
  }, 120_000);
});

describe("unknown-price models sort last, not first", () => {
  it("marks sentinel-priced models as pricing-unknown", async () => {
    const { prisma: db } = await import("@/lib/db");
    const unknown = await db.model.count({ where: { pricingKnown: false } });
    const negative = await db.model.count({ where: { inputPrice: { lt: 0 } } });
    // Every negatively-priced model must be flagged, so ordering can push it down.
    expect(unknown).toBeGreaterThanOrEqual(negative);
  }, 60_000);

  it("does not put an unknown price at the top of cheapest-first", async () => {
    const { prisma: db } = await import("@/lib/db");
    const first = await db.model.findFirst({
      where: { active: true },
      orderBy: [{ pricingKnown: "desc" }, { inputPrice: "asc" }],
    });
    expect(first!.pricingKnown).toBe(true);
    expect(first!.inputPrice).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
