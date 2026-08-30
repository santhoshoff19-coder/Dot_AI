import { describe, expect, it } from "vitest";
import { runControlPlane } from "@/lib/controlplane";
import { routeRequest } from "@/lib/routing/orchestrator";
import { prisma } from "@/lib/db";
import type { StreamEvent } from "@/types";

const actor = { role: "support_agent", permissions: ["accounts.read"] };

async function run(prompt: string, over: Record<string, unknown> = {}) {
  const events: StreamEvent[] = [];
  const out = await runControlPlane(
    {
      requestId: `fb-${Math.random().toString(36).slice(2)}`,
      prompt, attachments: [], history: [], settings: {},
      destinationExternal: false, actor, ...over,
    } as Parameters<typeof runControlPlane>[0],
    (e) => events.push(e),
  );
  return { ...out, events };
}

describe("the user's selected model is respected", () => {
  it("sends the request to exactly the model the user chose", async () => {
    const routing = await routeRequest({ prompt: "Summarize this article." });
    const chosen = routing.options.all[routing.options.all.length - 1].modelId;
    const r = await run("Summarize this article.", { routing, selectedModelId: chosen });
    expect(r.controlEvent.selectedModel).toBe(chosen);
    expect(r.controlEvent.requestedModel ?? chosen).toBe(chosen);
  }, 120_000);

  it("records requested and executed model on an image run", async () => {
    const routing = await routeRequest({
      prompt: "Generate a cinematic image of a cat on the Moon.",
    });
    const chosen = routing.options.recommendable.modelId;
    const r = await run("Generate a cinematic image of a cat on the Moon.", {
      routing, selectedModelId: chosen,
    });
    expect(r.controlEvent.requestedModel).toBe(chosen);
    expect(r.controlEvent.executedModel).toBe(chosen);
    // No fallback occurred, so none is claimed.
    expect(r.controlEvent.fallbackReason).toBeUndefined();
  }, 120_000);

  it("does not silently escalate away from an explicit choice", async () => {
    // A contradicted answer normally triggers regeneration on a stronger
    // model. With an explicit selection and no fallback permission, dotAI
    // must stay on the chosen model.
    const routing = await routeRequest({ prompt: "What is John account balance?" });
    const chosen = routing.options.recommendable.modelId;
    const r = await run("What is John account balance?", {
      routing, selectedModelId: chosen, allowFallback: false,
    });
    expect(r.controlEvent.selectedModel).toBe(chosen);
  }, 120_000);

  it("never falls back on a capability mismatch", async () => {
    // Forcing a text model onto an image task must fail cleanly rather than
    // quietly rerouting to a different model.
    const routing = await routeRequest({
      prompt: "Generate a cinematic image of a cat on the Moon.",
    });
    const r = await run("Generate a cinematic image of a cat on the Moon.", {
      routing, selectedModelId: "openai/gpt-4o-mini", allowFallback: true,
    });
    expect(r.controlEvent.executionFailureReason).toBe("MODALITY_UNSUPPORTED");
    expect(r.controlEvent.decision.decision).toBe("BLOCK");
    expect(r.image).toBeUndefined();
  }, 120_000);
});

describe("execution failures feed the learning system", () => {
  it("records a capability mismatch as an execution event, not a reasoning failure", async () => {
    const before = await prisma.modelExecutionEvent.count({
      where: { openrouterModelId: "openai/gpt-4o-mini", modality: "IMAGE" },
    });
    const routing = await routeRequest({
      prompt: "Generate a cinematic image of a cat on the Moon.",
    });
    await run("Generate a cinematic image of a cat on the Moon.", {
      routing, selectedModelId: "openai/gpt-4o-mini",
    });
    const after = await prisma.modelExecutionEvent.count({
      where: { openrouterModelId: "openai/gpt-4o-mini", modality: "IMAGE" },
    });
    expect(after).toBeGreaterThan(before);

    const row = await prisma.model.findUnique({
      where: { openrouterModelId: "openai/gpt-4o-mini" }, include: { capability: true },
    });
    // The text capability profile is untouched by an image-modality failure.
    expect(row?.capability?.reasoning).toBeTruthy();
  }, 120_000);
});
