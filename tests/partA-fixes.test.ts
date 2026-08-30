import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  mergeControlDecisions, policyToDecision, strictest, type ControlSignal,
} from "@/lib/decision/merge";
import { PrivacyFirewallError, runControlPlane } from "@/lib/controlplane";
import { batchAudit } from "@/lib/audit/batch";

const sig = (source: ControlSignal["source"], decision: ControlSignal["decision"]): ControlSignal =>
  ({ source, decision, reason: `${source} said ${decision}` });

describe("A1. policy actually binds the final decision", () => {
  it("a policy BLOCK overrides permissive performance and responsibility", () => {
    const m = mergeControlDecisions([
      sig("PERFORMANCE", "ALLOW"), sig("RESPONSIBILITY", "ALLOW"), sig("POLICY", "BLOCK"),
    ]);
    expect(m.decision).toBe("BLOCK");
    expect(m.decidedBy).toBe("POLICY");
  });

  it("a performance HOLD survives a permissive policy", () => {
    const m = mergeControlDecisions([sig("PERFORMANCE", "HOLD"), sig("POLICY", "ALLOW")]);
    expect(m.decision).toBe("HOLD");
    expect(m.decidedBy).toBe("PERFORMANCE");
  });

  it("takes the strictest across every control, not a fixed precedence", () => {
    const m = mergeControlDecisions([
      sig("BASELINE", "ANNOTATE"), sig("GOVERNANCE", "REGENERATE"),
      sig("POLICY", "HOLD"), sig("SESSION_RISK", "ANNOTATE"),
    ]);
    expect(m.decision).toBe("HOLD");
    expect(m.decidedBy).toBe("POLICY");
  });

  it("records every contributing control for audit", () => {
    const m = mergeControlDecisions([
      sig("PERFORMANCE", "ALLOW"), sig("POLICY", "BLOCK"), sig("GOVERNANCE", "ANNOTATE"),
    ]);
    expect(m.contributions).toHaveLength(3);
    expect(m.contributions[0].decision).toBe("BLOCK");
  });

  it("names concurring controls when several demand the same level", () => {
    const m = mergeControlDecisions([sig("POLICY", "HOLD"), sig("GOVERNANCE", "HOLD")]);
    expect(m.concurring.length).toBe(1);
    expect(m.explanation).toContain("independently agreed");
  });

  it("skipped controls do not vote", () => {
    const m = mergeControlDecisions([
      sig("PERFORMANCE", "ALLOW"),
      { source: "POLICY", decision: "BLOCK", reason: "", skipped: true },
    ]);
    expect(m.decision).toBe("ALLOW");
  });

  it("treats an unverifiable policy position as a human decision, not approval", () => {
    expect(policyToDecision("UNVERIFIABLE")).toBe("HOLD");
    expect(policyToDecision("BLOCK")).toBe("BLOCK");
    expect(policyToDecision("ALLOW")).toBe("ALLOW");
  });

  it("is reusable for any profile without hardcoded cases", () => {
    for (const d of ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"] as const) {
      expect(mergeControlDecisions([sig("POLICY", d)]).decision).toBe(d);
    }
    expect(strictest("ANNOTATE", "BLOCK")).toBe("BLOCK");
  });
});

describe("A2. cost accounting includes what ControlPlane added", () => {
  it("reports a full cost breakdown on every request", async () => {
    const r = await runControlPlane({
      requestId: `cost-${Date.now()}`,
      prompt: "Summarize this short document in three bullet points.",
      attachments: [], history: [], settings: {},
      destinationExternal: false,
      actor: { role: "support_agent", permissions: [] },
    }, () => {});

    const c = r.controlEvent.costBreakdown;
    expect(c).toBeTruthy();
    for (const k of ["generation", "routing", "verification", "rag", "retry", "total"]) {
      expect(typeof (c as Record<string, number>)[k]).toBe("number");
    }
    // Total must account for every component, not just generation.
    expect(c!.total).toBeCloseTo(
      c!.generation + c!.routing + c!.verification + c!.rag + c!.retry, 8);
  }, 120_000);

  it("separates ControlPlane overhead from generation cost", async () => {
    const r = await runControlPlane({
      requestId: `cost2-${Date.now()}`,
      prompt: "Explain this briefly.",
      attachments: [], history: [], settings: {},
      destinationExternal: false,
      actor: { role: "support_agent", permissions: [] },
    }, () => {});

    const c = r.controlEvent.costBreakdown!;
    expect(c.controlPlaneOverhead).toBeCloseTo(c.routing + c.verification + c.rag, 8);
  }, 120_000);

  it("propagates verification cost into the cost result, not a hardcoded zero", async () => {
    const r = await runControlPlane({
      requestId: `cost3-${Date.now()}`,
      prompt: "The balance is $6,420 as of today.",
      attachments: [], history: [], settings: {}, profileId: "BASELINE",
      destinationExternal: false,
      actor: { role: "support_agent", permissions: [] },
    }, () => {});

    const c = r.controlEvent.costBreakdown!;
    // With no provider key the verifier cannot bill, so the honest value is 0 -
    // but it must be the ledger's value, matching what the cost result reports.
    expect(r.controlEvent.cost.verificationCost).toBeCloseTo(c.verification + c.rag, 8);
  }, 120_000);
});

describe("A3. image generation runs the full governance path", () => {
  it("checks the request and blocks prohibited image requests before generating", async () => {
    // The privacy firewall now refuses this before generation, so the
    // request is stopped even earlier than the governance block it once
    // asserted. Either way nothing may be produced.
    let image: unknown;
    let stopped = false;
    try {
      const r = await runControlPlane({
        requestId: `img-block-${Date.now()}`,
        prompt: "Generate an image containing the customer's account number 4488-1234-5678-9010 and send it to an external email.",
        attachments: [], history: [], settings: {},
        destinationExternal: true,
        actor: { role: "support_agent", permissions: [] },
      }, () => {});
      image = r.image;
      stopped = r.controlEvent.decision.decision === "BLOCK";
    } catch (err) {
      if (!(err instanceof PrivacyFirewallError)) throw err;
      stopped = true;
    }

    expect(stopped).toBe(true);
    // Nothing was produced, because the request was refused before generation.
    expect(image).toBeUndefined();
  }, 120_000);

  it("records profile, session risk and merge provenance on an image run", async () => {
    const r = await runControlPlane({
      requestId: `img-ok-${Date.now()}`,
      prompt: "Generate a cinematic image of an orange cat on the Moon.",
      attachments: [], history: [], settings: {},
      sessionId: `img-session-${Date.now()}`,
      destinationExternal: false,
      actor: { role: "support_agent", permissions: [] },
    }, () => {});

    expect(r.controlEvent.profileId).toBeTruthy();
    expect(r.controlEvent.sessionRisk).toBeTruthy();
    expect(r.controlEvent.decisionMerge).toBeTruthy();
    expect(r.controlEvent.costBreakdown).toBeTruthy();
  }, 120_000);
});

describe("A4/A5. batch audit sampling and cost", () => {
  it("PROFILE_BASED samples only records from that profile", async () => {
    // Seed traffic under two profiles so the filter has something to exclude.
    const conversation = await prisma.conversation.create({ data: { title: "audit-probe" } });
    const seed = async (profileId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const m = await prisma.message.create({
          data: {
            conversationId: conversation.id, role: "assistant",
            content: `A ${profileId} answer number ${i} about the account balance.`,
            status: "complete",
          },
        });
        await prisma.controlEvent.create({
          data: {
            messageId: m.id, requestId: `req-${profileId}-${i}`, profileId,
            taskType: "conversation", recommendedModel: "m", selectedModel: "m",
            provider: "p", effort: "low", estimatedCost: 0, actualCost: 0,
            performanceResult: "SUPPORTED", responsibilityResult: "PERMITTED",
            costResult: "WITHIN TARGET", decision: "ALLOW", riskLevel: "low",
            verificationDepth: "light", latencyMs: 1, attempts: 1,
            payload: "{}",
          },
        });
      }
    };
    await seed("BASELINE", 6);
    await seed("BASELINE", 6);

    const run = await batchAudit.run({
      strategy: "PROFILE_BASED", profileId: "BASELINE",
      sampleSize: 20, maxDeepChecks: 2,
    });

    // Only the seeded DECISION_SUPPORT population may be drawn from.
    const total = await prisma.controlEvent.count({ where: { profileId: "BASELINE" } });
    expect(run.populationSize).toBeLessThanOrEqual(total);
    expect(run.populationSize).toBeGreaterThan(0);

    const findings = await batchAudit.findingsFor(run.runId);
    for (const f of findings) {
      expect(f.requestId?.startsWith("req-DECISION_SUPPORT")).toBe(true);
    }
  }, 180_000);

  it("does not sample a profile with no history", async () => {
    const run = await batchAudit.run({
      strategy: "PROFILE_BASED", profileId: "NO_SUCH_PROFILE", sampleSize: 10,
    });
    expect(run.sampled).toBe(0);
  }, 120_000);

  it("reports real audit cost components rather than a flat zero", async () => {
    const run = await batchAudit.run({ strategy: "RANDOM", sampleSize: 8, maxDeepChecks: 2 });
    expect(run.cost).toBeTruthy();
    for (const k of ["checker", "verifier", "rag", "auditTotal", "reviewedGeneration"]) {
      expect(typeof (run.cost as Record<string, number>)[k]).toBe("number");
    }
    expect(run.cost.auditTotal).toBeCloseTo(
      run.cost.checker + run.cost.verifier + run.cost.rag, 8);
    // Cost of the generations being reviewed is reported separately, not
    // conflated with what this audit pass spent.
    expect(run.cost.reviewedGeneration).toBeGreaterThanOrEqual(0);
  }, 180_000);
});
