import { describe, expect, it } from "vitest";
import { runControlPlane } from "@/lib/controlplane";
import { routeRequest } from "@/lib/routing/orchestrator";
import { modelExecution } from "@/lib/models/execution";
import { prisma } from "@/lib/db";
import type { StreamEvent } from "@/types";

const PROMPT =
  "Generate a cinematic image of a small orange cat sitting on the Moon while Earth appears in the background.";

describe("FINAL TEST — image generation end to end", () => {
  it("runs every step of the required sequence", async () => {
    // 1 + 2. Task classified as image generation with the seven fields.
    const routing = await routeRequest({ prompt: PROMPT });
    expect(routing.taskType).toBe("image_generation");
    const p = routing.requirementProfile!;
    for (const f of ["effort", "reasoning", "contextHandling", "instructionComplexity",
      "reliability", "toolCapability"]) {
      expect(p).toHaveProperty(f);
    }
    expect(p.requiredOutputModalities).toEqual(["IMAGE"]);

    // 3 + 4. Text-only models removed, image-output models remain.
    for (const o of routing.options.all) {
      const model = await prisma.model.findUnique({
        where: { openrouterModelId: o.modelId }, include: { modalities: true },
      });
      const outs = model!.modalities.filter((m) => m.direction === "OUTPUT").map((m) => m.modality);
      expect(outs).toContain("IMAGE");
    }

    // 5. Every candidate is execution-validated.
    for (const o of routing.options.all) {
      const v = await modelExecution.validateModel(o.modelId, "IMAGE");
      expect(v.executable).toBe(true);
    }

    // 6. Up to three verified options, never invented.
    expect(routing.options.all.length).toBeGreaterThan(0);
    expect(routing.options.all.length).toBeLessThanOrEqual(3);

    // 7 + 8. The user selects one and that exact model is called.
    const chosen = routing.options.all[routing.options.all.length - 1].modelId;
    const events: StreamEvent[] = [];
    const result = await runControlPlane(
      {
        requestId: `final-${Date.now()}`,
        prompt: PROMPT,
        attachments: [], history: [], settings: {},
        destinationExternal: false,
        actor: { role: "support_agent", permissions: ["accounts.read"] },
        routing, selectedModelId: chosen,
      },
      (e) => events.push(e),
    );
    expect(result.controlEvent.selectedModel).toBe(chosen);

    // 9 + 10. An image is returned and streamed to the UI.
    expect(result.image).toBeTruthy();
    expect(result.image!.url.startsWith("data:image/")).toBe(true);
    expect(events.some((e) => e.type === "image")).toBe(true);

    // 11. Cost is recorded.
    expect(result.controlEvent.cost).toBeTruthy();
    expect(result.controlEvent.actualCost).toBeGreaterThanOrEqual(0);

    // 12. Execution result is recorded.
    const status = await modelExecution.getExecutionStatus(chosen, "IMAGE");
    expect(status).toBeTruthy();
    // In mock mode the run is simulated, so it is recorded as compatible
    // rather than verified, and does not inflate the health counters.
    expect(status!.status).toBe("METADATA_COMPATIBLE");
    expect(status!.attempts).toBe(0);

    // 13. ControlPlane processed the result.
    expect(result.controlEvent.decision.decision).toBeTruthy();
    expect(result.controlEvent.responsibility.status).toBeTruthy();

    // 14. The outcome is available to future routing.
    const events2 = await prisma.modelExecutionEvent.count({
      where: { openrouterModelId: chosen, modality: "IMAGE" },
    });
    expect(events2).toBeGreaterThan(0);
  }, 180_000);

  it("never routes an image task to a text-only model", async () => {
    const routing = await routeRequest({ prompt: PROMPT });
    const ids = routing.options.all.map((o) => o.modelId);
    expect(ids).not.toContain("openai/gpt-4o-mini");
    expect(ids).not.toContain("openai/o1");
  }, 60_000);
});
