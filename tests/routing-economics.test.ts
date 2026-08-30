import { describe, expect, it } from "vitest";
import { fastRouter } from "@/lib/routing/fast-router";
import { routeRequest } from "@/lib/routing/orchestrator";

/**
 * The point of the Fast Router is economic: if it handles the bulk of ordinary
 * traffic for free, CAI's cost stops being a meaningful share of total spend.
 */
const ORDINARY = [
  "Summarize this article.",
  "Translate this paragraph to French.",
  "Extract the invoice dates.",
  "Classify the sentiment of this review.",
  "Convert this to JSON.",
  "Hello there",
  "Summarize the key points.",
  "Translate this to Spanish.",
  "Proofread this paragraph.",
  "Categorise these tickets.",
];

const AMBIGUOUS = [
  "Analyze this proposal, compare the assumptions and recommend whether we should proceed.",
  "Think through the second-order effects and where the strategy might break down.",
  "Review these documents and prepare a strategic response we can send to the board.",
];

describe("routing economics", () => {
  it("handles the large majority of ordinary traffic without CAI", () => {
    const direct = ORDINARY.filter((p) => fastRouter.route({ prompt: p }).routeType === "DIRECT");
    expect(direct.length / ORDINARY.length).toBeGreaterThanOrEqual(0.7);
  });

  it("still escalates genuinely ambiguous work", () => {
    for (const p of AMBIGUOUS) {
      expect(fastRouter.route({ prompt: p }).routeType).toBe("CAI");
    }
  });

  it("spends nothing on routing when the task is obvious", async () => {
    for (const p of ORDINARY.slice(0, 5)) {
      const r = await routeRequest({ prompt: p });
      if (!r.caiUsed) expect(r.routingCostUsd).toBe(0);
    }
  });

  it("keeps the routing decision cheap relative to generation", async () => {
    const r = await routeRequest({ prompt: "Summarize this article." });
    // Free-tier models exist in the live catalog, so generation can cost $0.
    // The invariant that matters is that routing never costs more.
    expect(r.routingCostUsd).toBeLessThanOrEqual(r.estimatedCost);
  });
});
