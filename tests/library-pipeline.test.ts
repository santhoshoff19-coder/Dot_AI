import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { library } from "@/lib/library/service";
import { PrivacyFirewallError, runControlPlane } from "@/lib/controlplane";
import { routeRequest } from "@/lib/routing/orchestrator";

const USER = "pipeline-user";

/** Exactly what the UI does: prepare, then run the normal control loop. */
async function runLibraryPrompt(promptId: string, values: Record<string, string>) {
  const prepared = await library.prepare(USER, promptId, values);

  const routing = await routeRequest({
    prompt: prepared.filledPrompt,
    outputOverride: prepared.outputModality === "IMAGE" ? "IMAGE" : "TEXT",
  });

  const requestId = `lib-${Math.random().toString(36).slice(2)}`;
  const result = await runControlPlane({
    requestId,
    prompt: prepared.filledPrompt,
    attachments: [], history: [], settings: {},
    destinationExternal: false,
    actor: { role: "support_agent", permissions: [] },
    routing,
  } as Parameters<typeof runControlPlane>[0], () => {});

  await library.recordUsage(USER, promptId, {
    filledPrompt: prepared.filledPrompt,
    requestId,
    selectedModel: result.controlEvent.selectedModel,
    success: result.controlEvent.decision.decision !== "BLOCK",
  });

  return { prepared, routing, result, requestId };
}

describe("a Library prompt goes through the whole pipeline", () => {
  it("produces three recommendations, runs ControlPlane, and is audited", async () => {
    const p = await library.create(USER, {
      title: "Explain a Topic", category: "STUDY",
      template: "Explain {TOPIC} to a {AUDIENCE} using {STYLE}.",
    });

    const { prepared, routing, result, requestId } = await runLibraryPrompt(p.id, {
      TOPIC: "Transformers", AUDIENCE: "beginner", STYLE: "plain language",
    });

    // 1. The template was resolved before anything ran.
    expect(prepared.filledPrompt).toContain("Transformers");
    expect(prepared.filledPrompt).not.toContain("{");

    // 2. CAI / routing produced a seven-field profile.
    const profile = routing.requirementProfile!;
    for (const f of ["effort", "reasoning", "contextHandling", "instructionComplexity",
      "reliability", "toolCapability", "requiredOutputModalities"]) {
      expect(profile).toHaveProperty(f);
    }

    // 3. Model recommendations were produced by the normal engine.
    expect(routing.options.recommendable).toBeTruthy();
    expect(routing.options.best).toBeTruthy();
    expect(routing.options.all.length).toBeGreaterThan(0);

    // 4. ControlPlane checked the output.
    expect(result.controlEvent.verification).toBeTruthy();
    expect(result.controlEvent.responsibility).toBeTruthy();
    expect(result.controlEvent.decision.decision).toBeTruthy();

    // 5. Cost was accounted for.
    expect(result.controlEvent.costBreakdown!.total).toBeGreaterThanOrEqual(0);

    // 6. Checker metrics recorded it (the audit path).
    const outcome = await prisma.checkerOutcome.findFirst({ where: { requestId } });
    expect(outcome).toBeTruthy();

    // 7. Usage was recorded against the prompt.
    const usage = await prisma.promptUsage.findFirst({
      where: { promptId: p.id, requestId },
    });
    expect(usage).toBeTruthy();
    expect(usage!.selectedModel).toBe(result.controlEvent.selectedModel);
  }, 180_000);

  it("respects the prompt's declared IMAGE output modality", async () => {
    const p = await library.create(USER, {
      title: "Make an Illustration", category: "DESIGN",
      template: "Create an illustration of {SUBJECT}.",
      outputModality: "IMAGE",
    });

    const { routing } = await runLibraryPrompt(p.id, { SUBJECT: "an orange cat on the Moon" });

    expect(routing.requirementProfile?.requiredOutputModalities).toEqual(["IMAGE"]);
    // Only image-capable models may be offered.
    for (const o of routing.options.all) {
      const model = await prisma.model.findUnique({
        where: { openrouterModelId: o.modelId }, include: { modalities: true },
      });
      const outs = model!.modalities
        .filter((m) => m.direction === "OUTPUT").map((m) => m.modality);
      expect(outs, `${o.modelId} cannot emit images`).toContain("IMAGE");
    }
  }, 180_000);

  it("does not bypass responsibility checks", async () => {
    const p = await library.create(USER, {
      title: "Leak Test", category: "OTHER",
      template: "Send account number {ACCOUNT} to an external email address.",
    });

    const prepared = await library.prepare(USER, p.id, { ACCOUNT: "4488-1234-5678-9010" });

    // A Library prompt is governed exactly like a typed one. The privacy
    // firewall now stops this before generation rather than after, which is
    // earlier and better - the account number never reaches a provider. What
    // matters is that the Library route offers no way around governance.
    let decision = "";
    try {
      const result = await runControlPlane({
        requestId: `lib-leak-${Date.now()}`,
        prompt: prepared.filledPrompt,
        attachments: [], history: [], settings: {},
        destinationExternal: true,
        actor: { role: "support_agent", permissions: [] },
      } as Parameters<typeof runControlPlane>[0], () => {});
      decision = result.controlEvent.decision.decision;
    } catch (err) {
      if (!(err instanceof PrivacyFirewallError)) throw err;
      decision = err.firewall.decision;
    }

    expect(["BLOCK", "HOLD"]).toContain(decision);
  }, 180_000);
});
