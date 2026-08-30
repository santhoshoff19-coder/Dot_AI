import { describe, expect, it } from "vitest";
import { fastRouter } from "@/lib/routing/fast-router";
import { routingConfig } from "@/lib/routing/routing-config";
import type { AttachmentRef } from "@/types";

const img: AttachmentRef = {
  id: "i", name: "p.png", mimeType: "image/png", size: 10, type: "image",
  previewUrl: null, storageRef: null, extractedText: null,
};
const doc: AttachmentRef = {
  id: "d", name: "d.txt", mimeType: "text/plain", size: 10, type: "document",
  previewUrl: null, storageRef: null, extractedText: "some text",
};

describe("Fast Router — direct routing (CAI skipped)", () => {
  it("routes a simple summarisation directly", () => {
    const r = fastRouter.route({ prompt: "Summarize this 500-word article." });
    expect(r.routeType).toBe("DIRECT");
    expect(r.taskType).toBe("summarization");
    expect(r.confidence).toBeGreaterThanOrEqual(routingConfig.FAST_ROUTE_MIN_CONFIDENCE);
  });

  it("routes a translation directly", () => {
    const r = fastRouter.route({ prompt: "Translate this paragraph to French." });
    expect(r.routeType).toBe("DIRECT");
    expect(r.taskType).toBe("translation");
  });

  it("routes simple extraction and classification directly", () => {
    expect(fastRouter.route({ prompt: "Extract the invoice dates." }).routeType).toBe("DIRECT");
    expect(fastRouter.route({ prompt: "Classify the sentiment of this review." }).routeType).toBe("DIRECT");
  });

  it("routes basic formatting directly", () => {
    const r = fastRouter.route({ prompt: "Convert this to JSON." });
    expect(r.routeType).toBe("DIRECT");
    expect(r.taskType).toBe("formatting");
  });

  it("routes a straightforward image description directly", () => {
    const r = fastRouter.route({ prompt: "Describe this image.", attachments: [img] });
    expect(r.routeType).toBe("DIRECT");
    expect(r.directRoute?.requiredCapabilities).toContain("vision");
  });

  it("routes a short conversational turn directly", () => {
    expect(fastRouter.route({ prompt: "Hello there" }).routeType).toBe("DIRECT");
  });

  it("never uses an LLM — routing is synchronous and free", () => {
    const r = fastRouter.route({ prompt: "Summarize this." });
    expect(r).not.toBeInstanceOf(Promise);
  });
});

describe("Fast Router — escalation to CAI", () => {
  it("escalates analysis-plus-recommendation", () => {
    const r = fastRouter.route({
      prompt: "Analyze this acquisition proposal, compare financial assumptions and recommend whether we should proceed.",
    });
    expect(r.routeType).toBe("CAI");
    expect(r.confidence).toBeLessThan(routingConfig.FAST_ROUTE_MIN_CONFIDENCE);
  });

  it("escalates an ambiguous multimodal request", () => {
    const r = fastRouter.route({
      prompt: "Look at this manufacturing image and the spec sheet, and explain what caused the defect.",
      attachments: [img, doc],
    });
    expect(r.routeType).toBe("CAI");
    expect(r.modality).toContain("image");
    expect(r.modality).toContain("document");
  });

  it("escalates a keyword-matching task that is not actually simple", () => {
    // "Summarize" is present, but so is a chain of judgement calls.
    const r = fastRouter.route({
      prompt: "Summarize these documents and then compare the assumptions and recommend whether we should proceed with the deal.",
      attachments: [doc, doc],
    });
    expect(r.routeType).toBe("CAI");
  });

  it("reports low confidence when nothing obvious matches", () => {
    const r = fastRouter.route({
      prompt: "Think about the second-order effects here and tell me what you would do differently given everything we discussed and where the strategy might break down.",
    });
    expect(r.routeType).toBe("CAI");
    expect(r.confidence).toBeLessThanOrEqual(routingConfig.CAI_TRIGGER_CONFIDENCE);
  });
});

describe("Fast Router — high-risk detection", () => {
  it("recognises a large payment approval without CAI", () => {
    const r = fastRouter.route({ prompt: "Approve this $50,000 payment." });
    expect(r.routeType).toBe("DIRECT");
    expect(r.highRisk).toBe(true);
    expect(r.riskLevel).toBe("critical");
    expect(r.confidence).toBeGreaterThanOrEqual(routingConfig.HIGH_RISK_DIRECT_CONFIDENCE);
  });

  it("recognises sending an account number externally", () => {
    const r = fastRouter.route({ prompt: "Send John's account number to an external email." });
    expect(r.highRisk).toBe(true);
  });

  it("demands a stricter confidence bar for high-risk direct routing", () => {
    expect(routingConfig.HIGH_RISK_DIRECT_CONFIDENCE)
      .toBeGreaterThan(routingConfig.CAI_TRIGGER_CONFIDENCE);
  });
});
