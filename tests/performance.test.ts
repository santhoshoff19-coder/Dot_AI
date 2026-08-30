import { describe, expect, it } from "vitest";
import { checkArithmetic, extractClaims, performanceService } from "@/lib/performance/service";

describe("deterministic arithmetic checks", () => {
  it("catches a wrong total", () => {
    const r = checkArithmetic("line items 1200 + 450 + 380, so the total is 2130");
    expect(r.some((x) => !x.ok)).toBe(true);
  });

  it("accepts a correct total", () => {
    const r = checkArithmetic("the sum of 10 + 5 is 15");
    expect(r.every((x) => x.ok)).toBe(true);
  });

  it("never reads an account number as arithmetic", () => {
    expect(checkArithmetic("account number is 4488-1234-5678 and balance is $6,420")).toHaveLength(0);
  });

  it("never reads a phone number as arithmetic", () => {
    expect(checkArithmetic("call 555-123-4567 today")).toHaveLength(0);
  });
});

describe("claim extraction", () => {
  it("marks sentences with numbers as checkable", () => {
    const claims = extractClaims("The balance is $6,420.00. Thanks for asking.");
    expect(claims[0].checkable).toBe(true);
  });
});

describe("evidence grounding", () => {
  it("contradicts a balance that conflicts with the ledger", async () => {
    const r = await performanceService.check(
      "What is John's balance?",
      "John's account balance is $8,420.00 as of today.",
      "standard",
    );
    expect(r.status).toBe("CONTRADICTED");
    expect(r.verdicts.some((v) => v.evidence?.authoritative)).toBe(true);
  });

  it("supports a balance that matches the ledger", async () => {
    const r = await performanceService.check(
      "What is John's balance?",
      "John's account balance is $6,420.00 as of today.",
      "standard",
    );
    expect(r.status).toBe("SUPPORTED");
  });

  it("does not contradict unrelated amounts", async () => {
    // "$50,000 payment" must not be reported as conflicting with an
    // unrelated "$10,000" approval threshold.
    const r = await performanceService.check(
      "Approve a payment",
      "I recommend approving the payment of $50,000 to the vendor account on file.",
      "deep",
    );
    expect(r.status).not.toBe("CONTRADICTED");
  });

  it("exits early on a deterministic failure without retrieval", async () => {
    const r = await performanceService.check(
      "total?", "The items are 1200 + 450 + 380, so the total is 2130.", "deep");
    expect(r.earlyExit).toBe(true);
    expect(r.checksRun).not.toContain("retrieval");
  });

  it("does not claim verification on the light path", async () => {
    const r = await performanceService.check(
      "hi", "The balance is $8,420.00 today.", "light");
    expect(r.status).toBe("UNVERIFIABLE");
    expect(r.claimsChecked).toBe(0);
  });
});
