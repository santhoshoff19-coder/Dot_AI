import type { CostResult, GenerationResult, ModelRecommendation } from "@/types";

const ABOVE_TARGET = 1.5;
const OVER_BUDGET = 3;

/**
 * Cost is an observer, not a gate: it compares actual usage against the CAI
 * estimate. It never blocks an answer for being expensive.
 */
export class CostService {
  check(
    rec: ModelRecommendation,
    gen: GenerationResult,
    opts: { attempts: number; verificationCost: number; succeeded: boolean },
  ): CostResult {
    const estimated = Math.max(rec.estimatedCost, 1e-9);
    const totalCost = gen.cost + opts.verificationCost;
    const ratio = gen.cost / estimated;
    const notes: string[] = [];

    let status: CostResult["status"] = "WITHIN TARGET";
    if (ratio >= OVER_BUDGET) {
      status = "OVER BUDGET";
      notes.push(`Spend is ${ratio.toFixed(1)}x the estimate.`);
    } else if (ratio >= ABOVE_TARGET) {
      status = "ABOVE TARGET";
      notes.push(`Spend is ${ratio.toFixed(1)}x the estimate.`);
    }

    if (opts.attempts > 1) {
      status = status === "WITHIN TARGET" ? "ABOVE TARGET" : status;
      notes.push(`${opts.attempts} attempts were needed; routing should learn from this.`);
    }
    if (gen.reasoningTokens > Math.max(50, gen.outputTokens * 3)) {
      notes.push(`${gen.reasoningTokens} reasoning tokens for ${gen.outputTokens} output tokens.`);
    }
    if (opts.verificationCost > 0) {
      notes.push(`Verification added $${opts.verificationCost.toFixed(6)}.`);
    }

    return {
      status,
      estimatedCost: round(rec.estimatedCost),
      actualCost: round(gen.cost),
      inputTokens: gen.inputTokens,
      outputTokens: gen.outputTokens,
      reasoningTokens: gen.reasoningTokens,
      attempts: opts.attempts,
      verificationCost: round(opts.verificationCost),
      totalCost: round(totalCost),
      costPerSuccessfulTask: round(opts.succeeded ? totalCost : totalCost * 2),
      notes,
    };
  }
}

function round(n: number) { return Math.round(n * 1e8) / 1e8; }

export const costService = new CostService();
