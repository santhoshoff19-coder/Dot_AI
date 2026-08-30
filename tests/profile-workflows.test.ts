import { describe, expect, it } from "vitest";
import { getProfile, listProfiles } from "@/lib/governance/profiles";
import { runControlPlane } from "@/lib/controlplane";
import type { StreamEvent } from "@/types";

const IDS = ["BASELINE", "CUSTOMER_SUPPORT", "INTERNAL_COPILOT", "DECISION_SUPPORT"];

async function run(prompt: string, profileId: string) {
  const events: StreamEvent[] = [];
  const r = await runControlPlane({
    requestId: crypto.randomUUID(), prompt, attachments: [], history: [], settings: {},
    destinationExternal: false, actor: { role: "support_agent", permissions: [] },
    ragMode: "AUTO", profileId, sessionId: crypto.randomUUID(),
  } as never, (e) => events.push(e));
  return { r, events };
}

describe("each profile has a genuinely distinct workflow", () => {
  it("defines a different stage sequence for every profile", () => {
    const seqs = IDS.map((id) => getProfile(id).workflow.stages.join(">"));
    // Four copies with different names would collapse to one sequence here.
    expect(new Set(seqs).size).toBe(4);
  });

  it("matches the flows each use case is for", () => {
    expect(getProfile("BASELINE").workflow.stages)
      .toEqual(["DETECT", "VERIFY", "DECIDE", "DELIVER"]);

    const cs = getProfile("CUSTOMER_SUPPORT").workflow.stages;
    expect(cs).toContain("PRIVACY_CHECK");
    expect(cs).toContain("FAST_VERIFY");
    expect(cs.indexOf("PRIVACY_CHECK")).toBeLessThan(cs.indexOf("POLICY_CHECK"));

    const ic = getProfile("INTERNAL_COPILOT").workflow.stages;
    expect(ic).toContain("INTERNAL_DATA_CHECK");
    expect(ic).toContain("ACCESS_CHECK");
    expect(ic).toContain("CITE");

    const ds = getProfile("DECISION_SUPPORT").workflow.stages;
    expect(ds).toContain("UNCERTAINTY_CHECK");
    expect(ds).toContain("STRICT_POLICY");
    expect(ds).toContain("HUMAN_APPROVAL");
  });

  it("differs in more than thresholds", () => {
    const w = IDS.map((id) => getProfile(id).workflow);
    // Retrieval policy, citation obligation, verification bounding and the
    // uncertainty rule are behavioural, not numeric.
    expect(new Set(w.map((x) => x.retrieval)).size).toBeGreaterThan(1);
    expect(new Set(w.map((x) => x.requireCitations)).size).toBe(2);
    expect(new Set(w.map((x) => x.boundedVerification)).size).toBe(2);
    expect(new Set(w.map((x) => x.treatUncertaintyAsBlocking)).size).toBe(2);
  });

  it("forces retrieval only where the use case depends on it", () => {
    // Internal Copilot and Decision Support exist to answer from evidence.
    expect(getProfile("INTERNAL_COPILOT").workflow.retrieval).toBe("FORCED");
    expect(getProfile("DECISION_SUPPORT").workflow.retrieval).toBe("FORCED");
    // Support pays for retrieval in latency, so it retrieves only on demand.
    expect(getProfile("CUSTOMER_SUPPORT").workflow.retrieval).toBe("AUTO");
    expect(getProfile("BASELINE").workflow.retrieval).toBe("AUTO");
  });

  it("gives every profile a summary that says what it is for", () => {
    for (const p of listProfiles()) {
      expect(p.workflow.summary.length, p.id).toBeGreaterThan(40);
    }
  });
});

describe("the workflows change actual behaviour", () => {
  it("retrieves for the evidence-led profiles and not otherwise", async () => {
    const copilot = await run("Hi there", "INTERNAL_COPILOT");
    const support = await run("Hi there", "CUSTOMER_SUPPORT");

    // Forced retrieval runs even on a greeting; AUTO correctly does not.
    expect(copilot.r.controlEvent.rag?.mode).toBe("ON");
    expect(support.r.controlEvent.rag?.mode).toBe("AUTO");
  }, 300_000);

  it("caps verification depth for the latency-first profile", async () => {
    const support = await run("Approve a $50,000 payment to the vendor.", "CUSTOMER_SUPPORT");
    const decision = await run("Approve a $50,000 payment to the vendor.", "DECISION_SUPPORT");

    // Support trades depth for latency; Decision Support does the opposite.
    expect(support.r.controlEvent.verificationDepth).not.toBe("deep");
    expect(decision.r.controlEvent.verificationDepth).toBe("deep");
  }, 300_000);

  it("handles the same unsound claim differently per profile", async () => {
    const q = "What is John account balance?";
    const outcomes: Record<string, string> = {};
    for (const id of IDS) {
      outcomes[id] = (await run(q, id)).r.controlEvent.decision.decision;
    }
    // The requirement: the same risky statement is not treated identically.
    expect(new Set(Object.values(outcomes)).size).toBeGreaterThan(1);
    // The strictest profile is never more permissive than the others.
    const order = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"];
    for (const id of IDS) {
      expect(order.indexOf(outcomes.DECISION_SUPPORT))
        .toBeGreaterThanOrEqual(order.indexOf(outcomes[id]));
    }
  }, 600_000);

  it("records the workflow on the control event", async () => {
    const o = await run("Hi there", "DECISION_SUPPORT");
    const w = o.r.controlEvent.workflow;
    expect(w).toBeTruthy();
    expect(w!.profileId).toBe("DECISION_SUPPORT");
    expect(w!.stages).toContain("UNCERTAINTY_CHECK");
    expect(w!.treatUncertaintyAsBlocking).toBe(true);
  }, 300_000);

  it("announces the workflow as a stage the UI can render", async () => {
    const o = await run("Hi there", "CUSTOMER_SUPPORT");
    const stages = o.events
      .filter((e) => e.type === "status")
      .map((e) => (e as { stage: string }).stage);
    expect(stages).toContain("workflow");
  }, 300_000);
});
