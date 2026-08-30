import { describe, expect, it } from "vitest";
import { qualifyModel } from "@/lib/capability/matching";
import {
  CapabilityProfileSchema, TaskRequirementProfileSchema, levelSatisfies, toolSatisfies,
  type CapabilityProfile, type TaskRequirementProfile,
} from "@/lib/capability/taxonomy";

const cap = (o: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
  effort: "MEDIUM", reasoning: "MEDIUM", contextHandling: "MEDIUM",
  instructionComplexity: "MEDIUM", reliability: "MEDIUM",
  toolCapability: "BASIC", outputCapabilities: ["TEXT"], ...o,
});

const req = (o: Partial<TaskRequirementProfile> = {}): TaskRequirementProfile => ({
  taskType: "summarization", effort: "MEDIUM", reasoning: "MEDIUM",
  contextHandling: "MEDIUM", instructionComplexity: "MEDIUM", reliability: "MEDIUM",
  toolCapability: "NONE", requiredInputModalities: ["TEXT"],
  requiredOutputModalities: ["TEXT"], confidence: 0.9, ...o,
});

describe("ordered level matching", () => {
  it("a medium task matches medium and high", () => {
    expect(levelSatisfies("MEDIUM", "MEDIUM")).toBe(true);
    expect(levelSatisfies("HIGH", "MEDIUM")).toBe(true);
  });

  it("a medium task does not match low", () => {
    expect(levelSatisfies("LOW", "MEDIUM")).toBe(false);
  });

  it("high reasoning rejects a low-reasoning model", () => {
    const r = qualifyModel(cap({ reasoning: "LOW" }), req({ reasoning: "HIGH" }));
    expect(r.qualified).toBe(false);
    expect(r.reason.toLowerCase()).toContain("reasoning");
  });
});

describe("tool capability matching", () => {
  it("basic accepts basic and advanced", () => {
    expect(toolSatisfies("BASIC", "BASIC")).toBe(true);
    expect(toolSatisfies("ADVANCED", "BASIC")).toBe(true);
  });

  it("basic rejects none", () => {
    expect(toolSatisfies("NONE", "BASIC")).toBe(false);
  });

  it("a requirement of none accepts every tool level", () => {
    for (const level of ["NONE", "BASIC", "ADVANCED"] as const) {
      expect(qualifyModel(cap({ toolCapability: level }), req()).qualified).toBe(true);
    }
  });
});

describe("output capability is a hard constraint", () => {
  it("image output rejects text-only models", () => {
    const r = qualifyModel(
      cap({ outputCapabilities: ["TEXT"] }),
      req({ requiredOutputModalities: ["IMAGE"] }),
    );
    expect(r.qualified).toBe(false);
    expect(r.reason).toContain("image");
  });

  it("video output rejects text and image models", () => {
    const r = qualifyModel(
      cap({ outputCapabilities: ["TEXT", "IMAGE"] }),
      req({ requiredOutputModalities: ["VIDEO"] }),
    );
    expect(r.qualified).toBe(false);
  });

  it("is evaluated before any ordered field, so cost can never override it", () => {
    const r = qualifyModel(
      cap({ effort: "HIGH", reasoning: "HIGH", outputCapabilities: ["TEXT"] }),
      req({ requiredOutputModalities: ["IMAGE"], effort: "LOW", reasoning: "LOW" }),
    );
    expect(r.qualified).toBe(false);
    expect(r.checks[0].field).toBe("outputCapabilities");
  });

  it("an image model qualifies for an image task", () => {
    const r = qualifyModel(
      cap({ outputCapabilities: ["IMAGE"] }),
      req({ requiredOutputModalities: ["IMAGE"] }),
    );
    expect(r.qualified).toBe(true);
  });
});

describe("controlled enums reject invented values", () => {
  it("rejects VERY_HIGH for effort", () => {
    const parsed = CapabilityProfileSchema.safeParse({ ...cap(), effort: "VERY_HIGH" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown output capability", () => {
    const parsed = CapabilityProfileSchema.safeParse({
      ...cap(), outputCapabilities: ["HOLOGRAM"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown tool level", () => {
    expect(CapabilityProfileSchema.safeParse({ ...cap(), toolCapability: "EXPERT" }).success)
      .toBe(false);
  });

  it("accepts a well-formed task requirement profile", () => {
    expect(TaskRequirementProfileSchema.safeParse(req()).success).toBe(true);
  });

  it("rejects a task profile with an invalid level", () => {
    expect(TaskRequirementProfileSchema.safeParse({ ...req(), reasoning: "EXTREME" }).success)
      .toBe(false);
  });
});

describe("explainability", () => {
  it("reports every field that was checked", () => {
    const r = qualifyModel(cap(), req());
    const fields = r.checks.map((c) => c.field);
    for (const f of ["outputCapabilities", "effort", "reasoning", "contextHandling",
      "instructionComplexity", "reliability", "toolCapability"]) {
      expect(fields).toContain(f);
    }
  });

  it("gives a user-safe reason with no chain-of-thought", () => {
    const r = qualifyModel(cap({ effort: "LOW" }), req({ effort: "HIGH" }));
    expect(r.reason.length).toBeLessThan(200);
  });
});

describe("input modality is a hard constraint too", () => {
  const cap2: CapabilityProfile = {
    effort: "HIGH", reasoning: "HIGH", contextHandling: "HIGH",
    instructionComplexity: "HIGH", reliability: "HIGH",
    toolCapability: "BASIC", outputCapabilities: ["TEXT"],
  };
  const visionTask: TaskRequirementProfile = {
    taskType: "image_analysis", effort: "LOW", reasoning: "LOW",
    contextHandling: "LOW", instructionComplexity: "LOW", reliability: "LOW",
    toolCapability: "NONE", requiredInputModalities: ["TEXT", "IMAGE"],
    requiredOutputModalities: ["TEXT"], confidence: 0.9,
  };

  it("rejects a text-only model for a vision task", () => {
    const r = qualifyModel({ ...cap2 }, { ...visionTask }, ["TEXT"]);
    expect(r.qualified).toBe(false);
    expect(r.reason).toContain("image");
  });

  it("accepts a vision-capable model", () => {
    const r = qualifyModel({ ...cap2 }, { ...visionTask }, ["TEXT", "IMAGE"]);
    expect(r.qualified).toBe(true);
  });

  it("does not enforce input modality when metadata is absent", () => {
    const r = qualifyModel({ ...cap2 }, { ...visionTask });
    expect(r.qualified).toBe(true);
  });
});
