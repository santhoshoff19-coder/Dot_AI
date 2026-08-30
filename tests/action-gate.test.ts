import { describe, expect, it } from "vitest";
import { actionGate } from "@/lib/action-gate/service";
import type { ActionIntent } from "@/types";

const actor = {
  role: "support_agent",
  permissions: ["accounts.read", "mail.send", "refunds.write", "payments.approve"],
};

const intent = (name: string, valueUsd = 0, external = false): ActionIntent => ({
  name, parameters: { note: "test" }, valueUsd, reversible: false,
  destination: { channel: "api", external },
});

describe("Action Gate", () => {
  it("denies an unregistered action by default", () => {
    const r = actionGate.evaluate(intent("wire_transfer", 100), actor);
    expect(r.decision).toBe("BLOCK");
    expect(r.stage).toBe("intent");
  });

  it("blocks when the actor lacks the permission", () => {
    const r = actionGate.evaluate(intent("issue_refund", 50), { role: "user", permissions: [] });
    expect(r.decision).toBe("BLOCK");
    expect(r.stage).toBe("permission");
  });

  it("blocks a value above the hard limit", () => {
    const r = actionGate.evaluate(intent("issue_refund", 9_000), actor);
    expect(r.decision).toBe("BLOCK");
    expect(r.stage).toBe("risk");
  });

  it("holds a high-value payment for human approval", () => {
    const r = actionGate.evaluate(intent("approve_payment", 50_000), actor);
    expect(r.decision).toBe("HOLD");
    expect(r.stage).toBe("policy");
  });

  it("allows a small permitted action", () => {
    const r = actionGate.evaluate(intent("issue_refund", 50), actor);
    expect(r.allowed).toBe(true);
    expect(r.executed).toBe(true);
  });

  it("detects a payment intent from the prompt", () => {
    const i = actionGate.detectIntent("Approve a $50,000 payment to the vendor.", false);
    expect(i?.name).toBe("approve_payment");
    expect(i?.valueUsd).toBe(50_000);
  });

  it("records every stage it evaluated", () => {
    const r = actionGate.evaluate(intent("approve_payment", 50_000), actor);
    expect(r.checks.map((c) => c.stage)).toContain("permission");
    expect(r.checks.map((c) => c.stage)).toContain("risk");
  });
});
