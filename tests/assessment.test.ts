import { describe, expect, it } from "vitest";
import { modelAssessment, ASSESSMENT_VERSION } from "@/lib/models/assessment";
import { caiBenchmark, CAI_THRESHOLDS } from "@/lib/cai/benchmark";
import { prisma } from "@/lib/db";
import { modelIntelligence } from "@/lib/models/intelligence";

const base = {
  openrouterModelId: "test/model",
  contextLength: 200_000,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: ["tools", "tool_choice", "response_format", "reasoning"],
};

describe("automatic capability assessment", () => {
  it("assesses a model with rich provider metadata", () => {
    const r = modelAssessment.assess(base);
    expect(r.assessed).toBe(true);
    expect(r.evidenceLevel).toBe("DIRECT_PROVIDER_DATA");
    expect(r.profile?.contextHandling).toBe("HIGH");
    // tools + tool_choice is BASIC; ADVANCED additionally requires
    // parallel_tool_calls, which this metadata does not report.
    expect(r.profile?.toolCapability).toBe("BASIC");
  });

  it("claims ADVANCED tools only when parallel tool calls are reported", () => {
    const r = modelAssessment.assess({
      ...base, supportedParameters: [...base.supportedParameters, "parallel_tool_calls"],
    });
    expect(r.profile?.toolCapability).toBe("ADVANCED");
  });

  it("leaves a model unassessed when metadata is too sparse", () => {
    const r = modelAssessment.assess({
      ...base, contextLength: 4_000, supportedParameters: [],
    });
    expect(r.assessed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("refuses to assess when no context length is reported", () => {
    const r = modelAssessment.assess({ ...base, contextLength: 0 });
    expect(r.assessed).toBe(false);
  });

  it("never infers reasoning from price or size alone", () => {
    // Huge context, no reasoning controls: reasoning must not be claimed HIGH.
    const r = modelAssessment.assess({
      ...base, contextLength: 1_000_000,
      supportedParameters: ["tools", "response_format"],
    });
    expect(r.profile?.reasoning).not.toBe("HIGH");
    expect(r.fieldConfidence.reasoning).toBeLessThan(r.fieldConfidence.contextHandling);
  });

  it("marks an image model with IMAGE output and no tool profile", () => {
    const r = modelAssessment.assess({
      ...base, outputModalities: ["image"], supportedParameters: ["response_format"],
      contextLength: 32_000,
    });
    expect(r.profile?.outputCapabilities).toEqual(["IMAGE"]);
    expect(r.profile?.toolCapability).toBe("NONE");
  });

  it("records confidence per field, not one blanket number", () => {
    const r = modelAssessment.assess(base);
    const values = new Set(Object.values(r.fieldConfidence));
    expect(values.size).toBeGreaterThan(1);
    expect(r.fieldConfidence.reliability).toBeLessThan(r.fieldConfidence.outputCapabilities);
  });

  it("stamps the assessment version", () => {
    expect(ASSESSMENT_VERSION).toBeTruthy();
  });

  it("does not overwrite a manual assessment on an automatic pass", async () => {
    await modelIntelligence.ensureSeeded();
    const before = await prisma.model.findUnique({
      where: { openrouterModelId: "openai/o1" }, include: { capability: true },
    });
    await prisma.modelCapability.update({
      where: { modelId: before!.id },
      data: { assessmentSource: "MANUAL", reasoning: "HIGH", assessmentVersion: ASSESSMENT_VERSION },
    });

    const outcome = await modelAssessment.reassessModel("openai/o1");
    expect(outcome.skipped).toBe(true);

    const after = await prisma.modelCapability.findUnique({ where: { modelId: before!.id } });
    expect(after?.assessmentSource).toBe("MANUAL");
  }, 30_000);

  it("reassesses when forced", async () => {
    const outcome = await modelAssessment.reassessModel("openai/o1", { force: true });
    expect(outcome.skipped).toBeUndefined();

    // Restore the shipped manual profile. A forced reassessment overwrites
    // reliability with the conservative metadata-derived value, which would
    // otherwise leave the dev database with no HIGH-reliability model and
    // silently change how high-risk requests route afterwards.
    const row = await prisma.model.findUnique({ where: { openrouterModelId: "openai/o1" } });
    await prisma.modelCapability.update({
      where: { modelId: row!.id },
      data: {
        effort: "HIGH", reasoning: "HIGH", contextHandling: "HIGH",
        instructionComplexity: "HIGH", reliability: "HIGH", toolCapability: "BASIC",
        assessmentSource: "MANUAL", evidenceLevel: "MANUAL_ASSESSMENT",
        capabilityConfidence: 0.8,
      },
    });
  }, 30_000);
});

describe("CAI benchmark", () => {
  it("benchmarks multiple candidates and computes every metric", async () => {
    const r = await caiBenchmark.run(["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"]);
    expect(r.results).toHaveLength(2);
    for (const x of r.results) {
      expect(x.accuracy).toBeGreaterThanOrEqual(0);
      expect(x.schemaSuccessRate).toBeGreaterThanOrEqual(0);
      expect(x.averageLatencyMs).toBeGreaterThanOrEqual(0);
      expect(x.averageCost).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);

  it("labels a mock run so it is never mistaken for live evidence", async () => {
    const r = await caiBenchmark.run(["openai/gpt-4o-mini"]);
    expect(r.mode).toBe("MOCK");
    expect(r.notes.toLowerCase()).toContain("not evidence");
  }, 60_000);

  it("rejects a candidate below the quality floor even if it is free", async () => {
    const original = CAI_THRESHOLDS.MIN_CAI_ACCURACY;
    CAI_THRESHOLDS.MIN_CAI_ACCURACY = 1.01; // unreachable
    try {
      const r = await caiBenchmark.run(["openai/gpt-4o-mini"]);
      expect(r.results[0].meetsThresholds).toBe(false);
      expect(r.selectedModelId).toBeNull();
      expect(r.results[0].rejectionReason).toContain("accuracy");
    } finally {
      CAI_THRESHOLDS.MIN_CAI_ACCURACY = original;
    }
  }, 60_000);

  it("selects the cheapest candidate that clears every threshold", async () => {
    const r = await caiBenchmark.run(["openai/o1", "openai/gpt-4o-mini"]);
    const selected = r.results.find((x) => x.selected);
    if (selected) {
      const cheapestEligible = Math.min(
        ...r.results.filter((x) => x.meetsThresholds).map((x) => x.averageCost));
      expect(selected.averageCost).toBeCloseTo(cheapestEligible, 8);
    }
  }, 120_000);

  it("persists the run and its results", async () => {
    await caiBenchmark.run(["openai/gpt-4o-mini"]);
    const latest = await caiBenchmark.latest();
    expect(latest).toBeTruthy();
    expect(latest!.results.length).toBeGreaterThan(0);
    expect(latest!.benchmarkVersion).toBeTruthy();
  }, 60_000);
});
