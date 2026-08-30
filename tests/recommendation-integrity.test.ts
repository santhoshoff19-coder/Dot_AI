import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  isVerified, modelExecution, RECOMMENDABLE_STATUSES,
} from "@/lib/models/execution";
import { routeRequest } from "@/lib/routing/orchestrator";

describe("execution status never overstates what dotAI has seen", () => {
  it("does not call a model verified on metadata alone", async () => {
    const r = await modelExecution.validateModel("openai/gpt-4o-mini", "TEXT");
    expect(r.status).not.toBe("AVAILABLE");
    if (r.stage === "catalog") {
      expect(r.status).toBe("METADATA_COMPATIBLE");
      expect(isVerified(r.status)).toBe(false);
    }
  }, 60_000);

  it("a simulated run never earns EXECUTION_VERIFIED", async () => {
    const id = "openai/gpt-4o-mini";
    await modelExecution.invalidate(id, "TEXT");
    await modelExecution.recordExecution(
      id, "TEXT", true, undefined, undefined, "sim-probe", true);

    const status = await modelExecution.getExecutionStatus(id, "TEXT");
    expect(status?.status).toBe("METADATA_COMPATIBLE");
    // Nor does it inflate observed health.
    expect(status?.attempts).toBe(0);
  }, 60_000);

  it("a real successful run does earn EXECUTION_VERIFIED", async () => {
    const id = "openai/gpt-4o-mini";
    await modelExecution.invalidate(id, "TEXT");
    await modelExecution.recordExecution(
      id, "TEXT", true, undefined, undefined, "real-probe", false);

    const status = await modelExecution.getExecutionStatus(id, "TEXT");
    expect(status?.status).toBe("EXECUTION_VERIFIED");
    expect(status?.attempts).toBe(1);
    expect(status?.successes).toBe(1);
    await modelExecution.invalidate(id, "TEXT");
  }, 60_000);

  it("a real failure is recorded and does not count as success", async () => {
    const id = "openai/gpt-4o-mini";
    await modelExecution.invalidate(id, "TEXT");
    await modelExecution.recordExecution(
      id, "TEXT", false, "PROVIDER_ERROR", "boom", "fail-probe", false);

    const status = await modelExecution.getExecutionStatus(id, "TEXT");
    expect(status?.successes).toBe(0);
    expect(status?.attempts).toBe(1);
    expect(isVerified(status!.status as never)).toBe(false);
    await modelExecution.invalidate(id, "TEXT");
  }, 60_000);

  it("only compatible or verified statuses are recommendable", () => {
    expect(RECOMMENDABLE_STATUSES).toContain("EXECUTION_VERIFIED");
    expect(RECOMMENDABLE_STATUSES).toContain("METADATA_COMPATIBLE");
    expect(RECOMMENDABLE_STATUSES).not.toContain("UNSUPPORTED");
    expect(RECOMMENDABLE_STATUSES).not.toContain("FAILED");
    expect(RECOMMENDABLE_STATUSES).not.toContain("UNKNOWN");
  });
});

describe("recommendations explain themselves", () => {
  it("labels each option with its role, cost and execution status", async () => {
    const r = await routeRequest({ prompt: "Summarize this article." });
    const opts = [r.options.recommendable, r.options.best, r.options.alternative]
      .filter(Boolean);

    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o!.role).toBeTruthy();
      expect(typeof o!.estimatedCost).toBe("number");
      expect(o!.executionStatus).toBeTruthy();
      expect(typeof o!.executionVerified).toBe("boolean");
      expect(o!.whyThisModel!.length).toBeGreaterThan(20);
    }
    expect(r.options.recommendable.role).toBe("RECOMMENDED");
    expect(r.options.best.role).toBe("BEST");
  }, 120_000);

  it("says plainly when execution is unproven", async () => {
    const r = await routeRequest({ prompt: "Summarize this article." });
    const rec = r.options.recommendable;
    if (!rec.executionVerified) {
      expect(rec.whyThisModel).toContain("not yet proven");
    }
  }, 120_000);

  it("recommends only models that can produce the requested output", async () => {
    const r = await routeRequest({
      prompt: "Generate a cinematic image of an orange cat on the Moon.",
    });
    expect(r.requirementProfile?.requiredOutputModalities).toEqual(["IMAGE"]);

    for (const o of r.options.all) {
      const model = await prisma.model.findUnique({
        where: { openrouterModelId: o.modelId }, include: { modalities: true },
      });
      const outputs = model!.modalities
        .filter((m) => m.direction === "OUTPUT").map((m) => m.modality);
      expect(outputs).toContain("IMAGE");
    }
  }, 120_000);

  it("never recommends a model whose execution status excludes it", async () => {
    const r = await routeRequest({ prompt: "Summarize this article." });
    for (const o of r.options.all) {
      expect(RECOMMENDABLE_STATUSES).toContain(o.executionStatus as never);
    }
  }, 120_000);
});

describe("catalog reflects a real synchronisation", () => {
  it("holds models from every OpenRouter catalog, not just chat", async () => {
    const total = await prisma.model.count();
    expect(total).toBeGreaterThan(400);

    for (const category of ["TEXT", "IMAGE", "VIDEO", "EMBEDDINGS"]) {
      const n = await prisma.modelCategoryLink.count({ where: { category } });
      expect(n).toBeGreaterThan(0);
    }
  }, 60_000);

  it("keeps unassessed models visible but out of recommendation", async () => {
    const failed = await prisma.modelCapability.count({
      where: { status: "ASSESSMENT_FAILED" },
    });
    if (failed > 0) {
      const r = await routeRequest({ prompt: "Summarize this article." });
      const rec = await prisma.model.findUnique({
        where: { openrouterModelId: r.options.recommendable.modelId },
        include: { capability: true },
      });
      expect(rec?.capability?.status).toBe("ASSESSED");
    }
  }, 120_000);
});
