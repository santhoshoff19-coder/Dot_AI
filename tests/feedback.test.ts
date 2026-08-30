import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  classifyOutcome, modelFeedback, MIN_CAPABILITY_UPDATE_SAMPLES,
} from "@/lib/models/feedback";
import { modelIntelligence } from "@/lib/models/intelligence";
import type { ControlEventData } from "@/types";

const MODEL_ID = "openai/gpt-4o-mini";

function event(over: Partial<ControlEventData> = {}): ControlEventData {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    taskClassification: "summarization",
    complexity: 0.2,
    recommendedModel: MODEL_ID,
    selectedModel: MODEL_ID,
    provider: "openai",
    effort: "low",
    estimatedCost: 0.001,
    actualCost: 0.001,
    verification: {
      status: "SUPPORTED", claimsChecked: 1, verdicts: [], checksRun: [], earlyExit: false,
    },
    cost: {
      status: "WITHIN TARGET", estimatedCost: 0.001, actualCost: 0.001,
      inputTokens: 10, outputTokens: 10, reasoningTokens: 0, attempts: 1,
      verificationCost: 0, totalCost: 0.001, costPerSuccessfulTask: 0.001, notes: [],
    },
    responsibility: {
      status: "PERMITTED", findings: [], checksRun: [],
      categories: { privacy: "clear", safety: "clear", fairness: "clear", policy: "clear", security: "clear" },
    },
    riskLevel: "low",
    verificationDepth: "light",
    decision: { decision: "ALLOW", reason: "ok", recommendedAction: "deliver", annotations: [] },
    actionGate: null,
    latencyMs: 100,
    attempts: 1,
    rationale: "test",
    mock: true,
    ...over,
  } as ControlEventData;
}

async function reset() {
  await modelIntelligence.ensureSeeded();
  const model = await prisma.model.findUnique({ where: { openrouterModelId: MODEL_ID } });
  if (model) {
    await prisma.modelOutcome.deleteMany({ where: { modelId: model.id } });
    await prisma.modelCapabilityRevision.deleteMany({ where: { modelId: model.id } });
    await prisma.modelCapability.update({
      where: { modelId: model.id },
      data: { reliability: "MEDIUM", assessmentSource: "MANUAL", status: "ASSESSED" },
    });
  }
  return model!;
}

describe("outcome classification", () => {
  it("classifies a clean generation as success", () => {
    const r = classifyOutcome(event());
    expect(r.category).toBe("SUCCESS");
    expect(r.success).toBe(true);
  });

  it("classifies a responsibility block", () => {
    const r = classifyOutcome(event({
      decision: { decision: "BLOCK", reason: "pii", recommendedAction: "block", annotations: [] },
    }));
    expect(r.category).toBe("RESPONSIBILITY_BLOCK");
    expect(r.success).toBe(false);
  });

  it("classifies a performance hold", () => {
    const r = classifyOutcome(event({
      decision: { decision: "HOLD", reason: "contradicted", recommendedAction: "human_review", annotations: [] },
    }));
    expect(r.category).toBe("PERFORMANCE_FAILURE");
  });

  it("records a regeneration distinctly", () => {
    expect(classifyOutcome(event({ attempts: 2 })).category).toBe("REGENERATED");
  });

  it("does not collapse every rejection into one boolean", () => {
    const categories = new Set([
      classifyOutcome(event()).category,
      classifyOutcome(event({ decision: { decision: "BLOCK", reason: "", recommendedAction: "block", annotations: [] } })).category,
      classifyOutcome(event({ decision: { decision: "HOLD", reason: "", recommendedAction: "human_review", annotations: [] } })).category,
      classifyOutcome(event({ attempts: 3 })).category,
    ]);
    expect(categories.size).toBe(4);
  });
});

describe("checker versus human disagreement", () => {
  it("records a false negative when the checker passed but a human rejected", () => {
    const r = classifyOutcome(event(), "reject");
    expect(r.category).toBe("HUMAN_REJECTED");
    expect(r.disagreement).toBe("FALSE_NEGATIVE");
  });

  it("records a false positive when the checker flagged but a human approved", () => {
    const r = classifyOutcome(event({
      verification: {
        status: "CONTRADICTED", claimsChecked: 1, verdicts: [], checksRun: [], earlyExit: false,
      },
      decision: { decision: "HOLD", reason: "", recommendedAction: "human_review", annotations: [] },
    }), "approve");
    expect(r.disagreement).toBe("FALSE_POSITIVE");
    expect(r.success).toBe(true);
  });

  it("reports no disagreement when checker and human agree", () => {
    const r = classifyOutcome(event({
      responsibility: {
        status: "PROHIBITED", findings: [], checksRun: [],
        categories: { privacy: "flagged", safety: "clear", fairness: "clear", policy: "clear", security: "clear" },
      },
    }), "reject");
    expect(r.disagreement).toBe("NONE");
  });
});

describe("feedback loop persistence", () => {
  beforeEach(async () => { await reset(); }, 30_000);

  it("a successful generation creates an outcome", async () => {
    const model = await reset();
    const e = event();
    await modelFeedback.recordOutcome({ requestId: e.requestId, openrouterModelId: MODEL_ID, event: e });
    const rows = await prisma.modelOutcome.findMany({ where: { modelId: model.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(true);
  }, 30_000);

  it("one failure does not change the declared capability", async () => {
    const model = await reset();
    const e = event({
      decision: { decision: "HOLD", reason: "", recommendedAction: "human_review", annotations: [] },
    });
    await modelFeedback.recordOutcome({ requestId: e.requestId, openrouterModelId: MODEL_ID, event: e });

    const cap = await prisma.modelCapability.findUnique({ where: { modelId: model.id } });
    expect(cap?.reliability).toBe("MEDIUM");
    expect(await prisma.modelCapabilityRevision.count({ where: { modelId: model.id } })).toBe(0);
  }, 30_000);

  it("revises capability only after the minimum sample size", async () => {
    const model = await reset();
    for (let i = 0; i < MIN_CAPABILITY_UPDATE_SAMPLES; i++) {
      const e = event({
        decision: { decision: "HOLD", reason: "", recommendedAction: "human_review", annotations: [] },
      });
      await modelFeedback.recordOutcome({ requestId: e.requestId, openrouterModelId: MODEL_ID, event: e });
    }
    const cap = await prisma.modelCapability.findUnique({ where: { modelId: model.id } });
    expect(cap?.reliability).toBe("LOW");
    expect(cap?.assessmentSource).toBe("OBSERVED");
  }, 40_000);

  it("writes an auditable revision recording the evidence", async () => {
    const model = await reset();
    for (let i = 0; i < MIN_CAPABILITY_UPDATE_SAMPLES; i++) {
      const e = event({
        decision: { decision: "HOLD", reason: "", recommendedAction: "human_review", annotations: [] },
      });
      await modelFeedback.recordOutcome({ requestId: e.requestId, openrouterModelId: MODEL_ID, event: e });
    }
    const rev = await prisma.modelCapabilityRevision.findFirst({ where: { modelId: model.id } });
    expect(rev).toBeTruthy();
    expect(rev?.fieldChanged).toBe("reliability");
    expect(rev?.oldValue).toBe("MEDIUM");
    expect(rev?.newValue).toBe("LOW");
    expect(rev?.evidenceCount).toBeGreaterThanOrEqual(MIN_CAPABILITY_UPDATE_SAMPLES);
    expect(rev?.reason).toContain("failures");
  }, 40_000);

  it("tracks reliability per model and task, not one universal score", async () => {
    const model = await reset();
    for (let i = 0; i < 3; i++) {
      const e = event({ taskClassification: "summarization" });
      await modelFeedback.recordOutcome({ requestId: e.requestId, openrouterModelId: MODEL_ID, event: e });
    }
    const e2 = event({
      taskClassification: "complex_reasoning",
      decision: { decision: "HOLD", reason: "", recommendedAction: "human_review", annotations: [] },
    });
    await modelFeedback.recordOutcome({ requestId: e2.requestId, openrouterModelId: MODEL_ID, event: e2 });

    const summ = await modelFeedback.observedReliability(model.id, "summarization");
    const reason = await modelFeedback.observedReliability(model.id, "complex_reasoning");
    expect(summ?.rate).toBe(1);
    expect(reason?.rate).toBe(0);
  }, 40_000);

  it("a human rejection updates the recorded outcome", async () => {
    const model = await reset();
    const e = event();
    await modelFeedback.recordOutcome({ requestId: e.requestId, openrouterModelId: MODEL_ID, event: e });
    await modelFeedback.attachHumanDecision(e.requestId, "reject");

    const row = await prisma.modelOutcome.findFirst({ where: { modelId: model.id } });
    expect(row?.category).toBe("HUMAN_REJECTED");
    expect(row?.success).toBe(false);
    expect(row?.disagreement).toBe("FALSE_NEGATIVE");
  }, 30_000);
});
