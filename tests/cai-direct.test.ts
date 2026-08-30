import { describe, expect, it } from "vitest";
import { caiService } from "@/lib/cai/service";
import { TaskRequirementProfileSchema } from "@/lib/capability/taxonomy";

describe("CAI directly produces the seven fields", () => {
  it("returns a schema-valid profile with every field", async () => {
    const r = await caiService.understand({ prompt: "Summarize this article." });
    expect(TaskRequirementProfileSchema.safeParse(r.profile).success).toBe(true);
    for (const f of ["effort", "reasoning", "contextHandling", "instructionComplexity",
      "reliability", "toolCapability", "requiredOutputModalities"]) {
      expect(r.profile).toHaveProperty(f);
    }
  });

  it("marks image generation as IMAGE output, not TEXT", () => {
    const p = caiService.classify({ prompt: "Generate a cinematic image of a cat on the moon." });
    expect(p.requiredOutputModalities).toEqual(["IMAGE"]);
    expect(p.taskType).toBe("image_generation");
  });

  it("marks a question about an attached image as TEXT output", () => {
    const p = caiService.classify({
      prompt: "What is in this image?",
      attachments: [{
        id: "i", name: "a.png", mimeType: "image/png", size: 1, type: "image",
        previewUrl: null, storageRef: null, extractedText: null,
      }],
    });
    expect(p.requiredInputModalities).toContain("IMAGE");
    expect(p.requiredOutputModalities).toEqual(["TEXT"]);
  });

  it("demands HIGH reliability for a high-value financial action", () => {
    const p = caiService.classify({ prompt: "Approve a $50,000 payment to the vendor." });
    expect(p.reliability).toBe("HIGH");
    expect(p.effort).toBe("HIGH");
  });
});

describe("CAI output validation", () => {
  it("accepts a well-formed reply", () => {
    const r = caiService.validate(JSON.stringify({
      taskType: "summarization", effort: "LOW", reasoning: "LOW",
      contextHandling: "LOW", instructionComplexity: "LOW", reliability: "LOW",
      toolCapability: "NONE", requiredInputModalities: ["TEXT"],
      requiredOutputModalities: ["TEXT"], confidence: 0.9,
    }));
    expect(r.ok).toBe(true);
  });

  it("rejects an invented enum value rather than coercing it", () => {
    const r = caiService.validate(JSON.stringify({
      taskType: "summarization", effort: "VERY_HIGH", reasoning: "LOW",
      contextHandling: "LOW", instructionComplexity: "LOW", reliability: "LOW",
      toolCapability: "NONE", requiredInputModalities: ["TEXT"],
      requiredOutputModalities: ["TEXT"], confidence: 0.9,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("effort");
  });

  it("rejects MEDIUM_HIGH and EXTREME", () => {
    for (const bad of ["MEDIUM_HIGH", "EXTREME", "MODERATE"]) {
      const r = caiService.validate(JSON.stringify({
        taskType: "summarization", effort: "LOW", reasoning: bad,
        contextHandling: "LOW", instructionComplexity: "LOW", reliability: "LOW",
        toolCapability: "NONE", requiredInputModalities: ["TEXT"],
        requiredOutputModalities: ["TEXT"], confidence: 0.9,
      }));
      expect(r.ok).toBe(false);
    }
  });

  it("handles malformed JSON without throwing", () => {
    const r = caiService.validate("not json at all");
    expect(r.ok).toBe(false);
  });

  it("strips markdown fences before parsing", () => {
    const r = caiService.validate('```json\n{"taskType":"summarization","effort":"LOW","reasoning":"LOW","contextHandling":"LOW","instructionComplexity":"LOW","reliability":"LOW","toolCapability":"NONE","requiredInputModalities":["TEXT"],"requiredOutputModalities":["TEXT"],"confidence":0.9}\n```');
    expect(r.ok).toBe(true);
  });

  it("falls back deterministically when the model path is unavailable", async () => {
    const r = await caiService.understand({ prompt: "Translate this to French." });
    expect(r.source).toBe("heuristic");
    expect(r.schemaValid).toBe(true);
    expect(r.profile.taskType).toBe("translation");
  });
});
