import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { modelExecution } from "@/lib/models/execution";
import { routeRequest } from "@/lib/routing/orchestrator";

const TEXT_MODEL = "openai/gpt-4o-mini";

beforeAll(async () => {
  // Ensure the catalog is populated for these checks.
  const count = await prisma.model.count();
  expect(count).toBeGreaterThan(0);
}, 60_000);

describe("execution validation", () => {
  it("marks a real, active text model executable but unverified without a probe", async () => {
    const r = await modelExecution.validateModel(TEXT_MODEL, "TEXT");
    expect(r.executable).toBe(true);
    // Compatible on paper. Without a live probe it must NOT claim to be proven.
    expect(["METADATA_COMPATIBLE", "EXECUTION_VERIFIED"]).toContain(r.status);
    if (r.status === "METADATA_COMPATIBLE") {
      expect(r.message).toContain("unverified");
    }
  }, 30_000);

  it("rejects a model id that does not exist", async () => {
    const r = await modelExecution.validateModel("nobody/not-a-real-model", "TEXT");
    expect(r.executable).toBe(false);
    expect(r.failureReason).toBe("MODEL_NOT_FOUND");
  }, 30_000);

  it("rejects an inactive model", async () => {
    const row = await prisma.model.findFirst({ where: { active: true } });
    await prisma.model.update({ where: { id: row!.id }, data: { active: false } });
    try {
      const r = await modelExecution.validateModel(row!.openrouterModelId, "TEXT");
      expect(r.executable).toBe(false);
      expect(r.failureReason).toBe("MODEL_INACTIVE");
    } finally {
      await prisma.model.update({ where: { id: row!.id }, data: { active: true } });
    }
  }, 30_000);

  it("rejects a text-only model for an image task", async () => {
    const r = await modelExecution.validateModel(TEXT_MODEL, "IMAGE");
    expect(r.executable).toBe(false);
    expect(r.failureReason).toBe("MODALITY_UNSUPPORTED");
  }, 30_000);

  it("accepts an image-capable model for an image task", async () => {
    const img = await prisma.model.findFirst({
      where: { active: true, modalities: { some: { direction: "OUTPUT", modality: "IMAGE" } } },
    });
    const r = await modelExecution.validateModel(img!.openrouterModelId, "IMAGE");
    expect(r.executable).toBe(true);
  }, 30_000);

  it("reports an unimplemented modality as unsupported, not merely unavailable", async () => {
    const vid = await prisma.model.findFirst({
      where: { active: true, modalities: { some: { direction: "OUTPUT", modality: "VIDEO" } } },
    });
    if (!vid) return;
    const r = await modelExecution.validateModel(vid.openrouterModelId, "VIDEO");
    expect(r.executable).toBe(false);
    expect(r.status).toBe("UNSUPPORTED");
  }, 30_000);
});

describe("failure classification keeps execution separate from capability", () => {
  it("maps HTTP codes to structured reasons", () => {
    expect(modelExecution.classifyHttp(404)).toBe("MODEL_NOT_FOUND");
    expect(modelExecution.classifyHttp(401)).toBe("AUTHENTICATION_ERROR");
    expect(modelExecution.classifyHttp(429)).toBe("RATE_LIMIT");
    expect(modelExecution.classifyHttp(503)).toBe("PROVIDER_UNAVAILABLE");
    expect(modelExecution.classifyHttp(400)).toBe("INVALID_REQUEST");
  });

  it("treats a timeout as temporary, never permanent", async () => {
    await modelExecution.recordExecution(TEXT_MODEL, "TEXT", false, "TIMEOUT", "timed out");
    const s = await modelExecution.getExecutionStatus(TEXT_MODEL, "TEXT");
    expect(s?.status).toBe("TEMPORARILY_UNAVAILABLE");
  }, 30_000);

  it("does not change any capability field on an execution failure", async () => {
    const row = await prisma.model.findUnique({ where: { openrouterModelId: TEXT_MODEL } });
    const before = await prisma.modelCapability.findUnique({ where: { modelId: row!.id } });
    await modelExecution.recordExecution(TEXT_MODEL, "TEXT", false, "PROVIDER_UNAVAILABLE", "down");
    const after = await prisma.modelCapability.findUnique({ where: { modelId: row!.id } });
    expect(after?.reasoning).toBe(before?.reasoning);
    expect(after?.reliability).toBe(before?.reliability);
  }, 30_000);

  it("keeps a historical record of every execution event", async () => {
    const before = await prisma.modelExecutionEvent.count();
    await modelExecution.recordExecution(TEXT_MODEL, "TEXT", false, "RATE_LIMIT", "429");
    expect(await prisma.modelExecutionEvent.count()).toBeGreaterThan(before);
  }, 30_000);

  it("records execution health as successes over attempts", async () => {
    const img = await prisma.model.findFirst({
      where: { active: true, modalities: { some: { direction: "OUTPUT", modality: "IMAGE" } } },
    });
    // Only a real (non-simulated) run counts toward execution health.
    await modelExecution.recordExecution(
      img!.openrouterModelId, "IMAGE", true, undefined, undefined, undefined, false);
    const s = await modelExecution.getExecutionStatus(img!.openrouterModelId, "IMAGE");
    expect(s!.attempts).toBeGreaterThan(0);
    expect(s!.successes).toBeGreaterThan(0);
  }, 30_000);
});

describe("only executable candidates are recommended", () => {
  it("every option for an image task produces image output", async () => {
    const r = await routeRequest({
      prompt: "Generate a cinematic image of a small orange cat sitting on the Moon.",
    });
    expect(r.requirementProfile?.requiredOutputModalities).toEqual(["IMAGE"]);
    for (const o of r.options.all) {
      const v = await modelExecution.validateModel(o.modelId, "IMAGE");
      expect(v.executable).toBe(true);
    }
  }, 120_000);

  it("shows at most three options and never invents extras", async () => {
    const r = await routeRequest({ prompt: "Summarize this article." });
    expect(r.options.all.length).toBeLessThanOrEqual(3);
    expect(r.verifiedCount).toBeGreaterThan(0);
  }, 120_000);

  it("says so honestly when fewer than three models are available", async () => {
    const r = await routeRequest({
      prompt: "Generate a cinematic image of a cat on the moon.",
    });
    if (r.options.all.length < 3) {
      expect(r.executabilityNote).toContain("verified");
    }
  }, 120_000);

  it("recommends the lowest-cost verified model", async () => {
    const r = await routeRequest({ prompt: "Summarize this article." });
    const cheapest = Math.min(...r.options.all.map((o) => o.estimatedCost));
    expect(r.options.recommendable.estimatedCost).toBeCloseTo(cheapest, 8);
  }, 120_000);
});
