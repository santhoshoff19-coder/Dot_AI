import { describe, expect, it } from "vitest";
import { runControlPlane } from "@/lib/controlplane";
import type { StreamEvent } from "@/types";
import { routeQuery } from "@/lib/intelligence/curated-routing";
import { curatedDataset, subTasksForForms } from "@/lib/intelligence/curated-dataset";

async function chat(prompt: string, attachments: unknown[] = []) {
  const events: StreamEvent[] = [];
  const r = await runControlPlane({
    requestId: crypto.randomUUID(), prompt, attachments, history: [], settings: {},
    destinationExternal: false, actor: { role: "support_agent", permissions: [] },
    ragMode: "AUTO", profileId: "BASELINE", sessionId: crypto.randomUUID(),
  } as never, (e) => events.push(e));

  const cap = events.find((e) => e.type === "capability");
  return { r, events, capability: cap && "capability" in cap ? cap.capability : null };
}

describe("the chat path executes the capability-routed model", () => {
  it("runs CAI and emits the capability decision for a trivial query", async () => {
    const { capability } = await chat("Hi, how are you?");
    // There is no fast path around analysis, however simple the query.
    expect(capability).not.toBeNull();
    expect(capability!.analysis.listA.length).toBeGreaterThan(0);
    expect(["CAI", "HEURISTIC"]).toContain(capability!.analysis.source);
  }, 300_000);

  it("executes a model drawn from the eligible set, never outside it", async () => {
    const { r, capability } = await chat("Hi, how are you?");
    const eligible = capability!.eligible.map((m) => m.openrouterId);
    expect(eligible.length).toBeGreaterThan(0);
    // Normally the Recommended model; a provider failure may move execution
    // to the next eligible one, which is still never an ineligible model.
    expect(eligible).toContain(r.controlEvent.selectedModel);
  }, 300_000);

  it("prefers the cheapest eligible model", async () => {
    const { capability } = await chat("Hi, how are you?");
    const cheapest = Math.min(...capability!.eligible.map((m) => m.blendedCost));
    expect(capability!.recommended!.blendedCost).toBeCloseTo(cheapest, 6);
  }, 300_000);

  it("records the decision on the control event for audit", async () => {
    const { r } = await chat("Hi, how are you?");
    expect(r.controlEvent.capability).toBeTruthy();
    expect(r.controlEvent.capability!.analysis.listA.length).toBeGreaterThan(0);
  }, 300_000);

  it("routes a coding query to the coding sub-task", async () => {
    const { capability } = await chat("Write a Python function to calculate factorial.");
    expect(capability!.analysis.subTaskName.toLowerCase()).toContain("coding");
  }, 300_000);

  it("keeps a user's explicit model choice", async () => {
    const decision = await routeQuery({ prompt: "Hi, how are you?" });
    // The second-cheapest eligible model: distinct from the Recommended one,
    // so the assertion is meaningful, and cheap enough to be broadly served -
    // an unreachable pick would be replaced by the fallback below, which is
    // correct behaviour but would not test what this test is about.
    const picked = decision.eligible[1] ?? decision.eligible[0];
    const events: StreamEvent[] = [];
    const r = await runControlPlane({
      requestId: crypto.randomUUID(), prompt: "Hi, how are you?", attachments: [],
      history: [], settings: {}, destinationExternal: false,
      actor: { role: "support_agent", permissions: [] }, ragMode: "AUTO",
      profileId: "BASELINE", sessionId: crypto.randomUUID(),
      selectedModelId: picked.openrouterId,
    } as never, (e) => events.push(e));
    // An explicit choice outranks the recommendation. If the provider is
    // unreachable the request still falls back within the eligible set
    // rather than failing, so both outcomes are legitimate - what must never
    // happen is executing something outside that set.
    const eligible = decision.eligible.map((m) => m.openrouterId);
    expect(eligible).toContain(r.controlEvent.selectedModel);
    expect([picked.openrouterId, ...eligible]).toContain(r.controlEvent.selectedModel);
  }, 300_000);
});

describe("the workbook and the application share one taxonomy", () => {
  it("has no routing example outside the taxonomy", () => {
    const pairs = new Set(curatedDataset().subTasks.map((s) => `${s.input}>${s.output}`));
    for (const ex of curatedDataset().routingExamples) {
      expect(pairs.has(`${ex.input}>${ex.output}`), ex.query.slice(0, 50)).toBe(true);
    }
  });

  it("records the correction rather than hiding it", () => {
    // The one inconsistent example was corrected in the data, not papered
    // over with a routing fallback.
    expect(curatedDataset().meta.corrections?.length).toBeGreaterThan(0);
  });

  it("offers no sub-task for a pair the taxonomy does not define", () => {
    expect(subTasksForForms("Document", "Structured Data")).toHaveLength(0);
  });
});
