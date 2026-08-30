import { describe, expect, it } from "vitest";
import { getProfile, listProfiles, USE_CASE_PROFILES } from "@/lib/governance/profiles";
import { privacyFirewall, CRITICAL_CLASSES } from "@/lib/governance/privacy-firewall";
import {
  evaluateAt, isStop, LABELLED_SET, selectThreshold, overrideQuality,
} from "@/lib/governance/threshold-eval";
import { SEED_PROMPTS } from "@/lib/library/seed-prompts";
import { CATEGORIES } from "@/lib/library/taxonomy";
import { parseTemplate } from "@/lib/library/variables";
import { prisma } from "@/lib/db";

describe("1. three governance profiles, backend only", () => {
  it("defines all three alongside the baseline", () => {
    for (const id of ["BASELINE", "CUSTOMER_SUPPORT", "INTERNAL_COPILOT", "DECISION_SUPPORT"]) {
      expect(getProfile(id).id, id).toBe(id);
    }
    expect(listProfiles().length).toBe(4);
  });

  it("differs meaningfully in risk, verification depth and latency", () => {
    const cs = getProfile("CUSTOMER_SUPPORT");
    const ds = getProfile("DECISION_SUPPORT");
    const ic = getProfile("INTERNAL_COPILOT");

    // Latency: somebody is waiting in support; nobody is in decision support.
    expect(cs.latencySLOms).toBeLessThan(ic.latencySLOms);
    expect(ic.latencySLOms).toBeLessThan(ds.latencySLOms);

    // Verification depth rises as the cost of being wrong rises.
    expect(cs.baseVerificationDepth).toBe("light");
    expect(ic.baseVerificationDepth).toBe("standard");
    expect(ds.baseVerificationDepth).toBe("deep");

    // Risk tolerance moves the opposite way.
    expect(cs.riskTolerance).toBe("high");
    expect(ds.riskTolerance).toBe("low");

    // And money is gated differently.
    expect(ds.escalationRules.humanApprovalAboveUsd)
      .toBeLessThan(cs.escalationRules.humanApprovalAboveUsd);
    expect(ds.blockedActions.length).toBeGreaterThan(cs.blockedActions.length);
  });

  it("falls back to the baseline for an unknown id", () => {
    expect(getProfile("NOT_A_PROFILE").id).toBe("BASELINE");
    expect(getProfile(null).id).toBe("BASELINE");
  });

  it("is not offered as a chat selector", () => {
    // Removed deliberately: how strictly a request is judged must not depend
    // on a dropdown the user has no basis for setting.
    expect(Object.keys(USE_CASE_PROFILES)).toContain("BASELINE");
  });
});

describe("2. pre-generation privacy firewall", () => {
  const P = (id: string) => getProfile(id);

  it("allows a request with nothing sensitive in it", () => {
    const r = privacyFirewall({
      prompt: "What is the weather?", profile: P("BASELINE"), destinationExternal: false });
    expect(r.decision).toBe("ALLOW");
    expect(r.safePrompt).toBe("What is the weather?");
  });

  it("redacts rather than blocking where the request is still answerable", () => {
    const r = privacyFirewall({
      prompt: "My account 4488-1234-5678 needs checking",
      profile: P("BASELINE"), destinationExternal: false });
    expect(r.decision).toBe("REDACT");
    expect(r.safePrompt).toContain("[REDACTED:");
    expect(r.safePrompt).not.toContain("4488-1234-5678");
  });

  it("blocks a critical identifier leaving the system", () => {
    const r = privacyFirewall({
      prompt: "Email card 4111 1111 1111 1111 to partner@external.com",
      profile: P("BASELINE"), destinationExternal: true });
    expect(r.decision).toBe("BLOCK");
    // Nothing goes to the model at all.
    expect(r.safePrompt).toBe("");
  });

  it("holds a critical identifier under a strict policy, even internally", () => {
    const r = privacyFirewall({
      prompt: "Account 4488-1234-5678 balance",
      profile: P("DECISION_SUPPORT"), destinationExternal: false });
    expect(r.decision).toBe("HOLD");
  });

  it("produces different decisions per profile for the same input", () => {
    const prompt = "Account 4488-1234-5678 balance";
    const baseline = privacyFirewall({ prompt, profile: P("BASELINE"), destinationExternal: false });
    const strict = privacyFirewall({ prompt, profile: P("DECISION_SUPPORT"), destinationExternal: false });
    expect(baseline.decision).not.toBe(strict.decision);
  });

  it("mirrors the scanner's own critical severities", () => {
    // Omitting account_number meant a card leaving the system was merely
    // masked, which still leaked its last four digits.
    expect(CRITICAL_CLASSES).toContain("account_number");
    expect(CRITICAL_CLASSES).toContain("credit_card");
    expect(CRITICAL_CLASSES).toContain("private_key");
  });

  it("scans attachment text, not only the prompt", () => {
    const r = privacyFirewall({
      prompt: "Summarise the attached file",
      attachmentText: "Card on file: 4111 1111 1111 1111",
      profile: P("BASELINE"), destinationExternal: true });
    expect(r.decision).toBe("BLOCK");
  });

  it("reports confidence from the weakest matching pattern", () => {
    const r = privacyFirewall({
      prompt: "key sk-abcdefghijklmnop1234", profile: P("BASELINE"), destinationExternal: false });
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("always states a reason and a policy basis", () => {
    for (const prompt of ["hello", "card 4111 1111 1111 1111"]) {
      const r = privacyFirewall({ prompt, profile: P("BASELINE"), destinationExternal: true });
      expect(r.reason.length).toBeGreaterThan(10);
      expect(r.policyBasis).toContain(P("BASELINE").name);
    }
  });
});

describe("5. threshold evaluation", () => {
  it("has a labelled set with both classes", () => {
    expect(LABELLED_SET.length).toBeGreaterThanOrEqual(10);
    expect(LABELLED_SET.some((c) => c.expected === "PASS")).toBe(true);
    expect(LABELLED_SET.some((c) => c.expected === "STOP")).toBe(true);
    // Every case carries its reasoning, so a disagreement can be argued.
    for (const c of LABELLED_SET) expect(c.note.length).toBeGreaterThan(10);
  });

  it("counts FP and FN and derives precision and recall", () => {
    const p = evaluateAt(0.85);
    expect(p.truePositives + p.falseNegatives).toBe(
      LABELLED_SET.filter((c) => c.expected === "STOP").length);
    expect(p.falsePositives + p.trueNegatives).toBe(
      LABELLED_SET.filter((c) => c.expected === "PASS").length);
    expect(p.precision).toBeGreaterThanOrEqual(0);
    expect(p.recall).toBeLessThanOrEqual(1);
  });

  it("chooses the highest threshold that misses nothing, and says why", () => {
    const r = selectThreshold();
    expect(r.chosen.falseNegatives).toBe(0);
    expect(r.rationale).toContain("false negative");
    // The reasoning must name the asymmetry it rests on.
    expect(r.rationale.toLowerCase()).toContain("cannot be undone");

    // Nothing above the chosen point achieves full recall, or it would have
    // been chosen instead.
    for (const p of r.points.filter((x) => x.threshold > r.chosen.threshold)) {
      expect(p.falseNegatives).toBeGreaterThan(0);
    }
  });

  it("treats redaction as passing", () => {
    expect(isStop("REDACT")).toBe(false);
    expect(isStop("ALLOW")).toBe(false);
    expect(isStop("HOLD")).toBe(true);
    expect(isStop("BLOCK")).toBe(true);
  });
});

describe("4. feedback loop", () => {
  it("persists a verdict and measures agreement", async () => {
    const before = await overrideQuality();

    await prisma.decisionFeedback.create({ data: {
      requestId: crypto.randomUUID(), originalDecision: "HOLD",
      humanDecision: "ALLOW", source: "firewall",
      comment: "legitimate request, wrongly held", profileId: "BASELINE" } });

    const after = await overrideQuality();
    expect(after.total).toBe(before.total + 1);
    expect(after.overturned).toBe(before.overturned + 1);
    expect(after.agreementRate).toBeLessThanOrEqual(1);
    expect(after.byDecision.some((d) => d.decision === "HOLD")).toBe(true);
  }, 120_000);

  it("counts an upheld decision as agreement", async () => {
    const before = await overrideQuality();
    await prisma.decisionFeedback.create({ data: {
      requestId: crypto.randomUUID(), originalDecision: "BLOCK",
      humanDecision: "BLOCK", source: "firewall", comment: "correct", profileId: "BASELINE" } });
    const after = await overrideQuality();
    expect(after.upheld).toBe(before.upheld + 1);
  }, 120_000);
});

describe("6. library seed prompts", () => {
  it("adds exactly two to every category", () => {
    for (const c of CATEGORIES) {
      const n = SEED_PROMPTS.filter((s) => s.category === c).length;
      expect(n, `${c} has ${n}`).toBe(2);
    }
    expect(SEED_PROMPTS.length).toBe(CATEGORIES.length * 2);
  });

  it("gives every prompt working dynamic variables", () => {
    for (const s of SEED_PROMPTS) {
      const parsed = parseTemplate(s.template);
      expect(parsed.variables.length, s.title).toBeGreaterThanOrEqual(2);
      for (const v of parsed.variables) {
        expect(v.name, s.title).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it("makes the two prompts in a category do different jobs", () => {
    for (const c of CATEGORIES) {
      const pair = SEED_PROMPTS.filter((s) => s.category === c);
      expect(pair[0].title).not.toBe(pair[1].title);
      // Different variables means a genuinely different task, not a reword.
      const a = new Set(parseTemplate(pair[0].template).variables.map((v) => v.name));
      const b = parseTemplate(pair[1].template).variables.map((v) => v.name);
      expect(b.some((n) => !a.has(n)), c).toBe(true);
    }
  });

  it("has a unique title for every prompt", () => {
    const titles = SEED_PROMPTS.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
