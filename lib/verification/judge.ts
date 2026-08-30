import { z } from "zod";
import { prisma } from "@/lib/db";
import { modelIntelligence } from "@/lib/models/intelligence";
import { modelExecution } from "@/lib/models/execution";
import { getProvider, isMockMode } from "@/lib/providers";
import { modelRegistry } from "@/lib/models/registry";
import type { EvidencePassage } from "@/types";

export type VerifierVerdict =
  | "SUPPORTED" | "CONTRADICTED" | "UNVERIFIABLE" | "VERIFICATION_UNAVAILABLE";

export interface ClaimJudgement {
  claim: string;
  verdict: Exclude<VerifierVerdict, "VERIFICATION_UNAVAILABLE">;
  confidence: number;
  /** Short summary, never raw chain-of-thought. */
  reasoning: string;
  evidenceRefs: string[];
}

export interface VerifierResult {
  outcome: VerifierVerdict;
  judgements: ClaimJudgement[];
  confidence: number;
  verifierModel: string | null;
  generationModel: string;
  /** True when no independent model was available. Weakens the result. */
  sameModel: boolean;
  costUsd: number;
  latencyMs: number;
  failureReason?: string;
  note: string;
}

/** The verifier must answer in this shape. Anything else is not trusted. */
const JudgementSchema = z.object({
  claims: z.array(z.object({
    claim: z.string().min(1).max(600),
    verdict: z.enum(["SUPPORTED", "CONTRADICTED", "UNVERIFIABLE"]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1).max(400),
    evidenceRefs: z.array(z.string().max(120)).default([]),
  })).min(1),
});

const SYSTEM_PROMPT = `You verify claims against supplied evidence for a control system.
You never answer the user's original question. You never speculate beyond the evidence.

Reply with ONLY a JSON object, no markdown fences:
{"claims":[{"claim":"<the claim>","verdict":"SUPPORTED"|"CONTRADICTED"|"UNVERIFIABLE","confidence":<0-1>,"reasoning":"<one short sentence>","evidenceRefs":["<source id>"]}]}

Rules:
- SUPPORTED only when the evidence directly states it. Plausibility is not support.
- CONTRADICTED when the evidence directly conflicts with it.
- UNVERIFIABLE when the evidence is silent, ambiguous, conflicting, or the claim is subjective. This is the correct answer far more often than people expect - use it.
- Never mark a claim SUPPORTED because it sounds reasonable.`;

/** Verifier candidates must be cheap and reliable, never the priciest model. */
const MAX_VERIFIER_COST_PER_1M = Number(process.env.VERIFIER_MAX_INPUT_COST ?? 1.5);
const VERIFIER_TIMEOUT_MS = Number(process.env.VERIFIER_TIMEOUT_MS ?? 25_000);

export class AIVerifier {
  /**
   * Picks a verifier through the existing model intelligence, not a hardcoded
   * name: cheapest assessed, executable, text-capable model that is not the
   * generator. Independence matters, but so does cost - if the only option is
   * the generator itself, that limitation is recorded rather than hidden.
   */
  async selectVerifier(generationModel: string): Promise<{
    modelId: string | null; sameModel: boolean; reason: string;
  }> {
    const configured = process.env.VERIFIER_MODEL;
    if (configured) {
      return {
        modelId: configured,
        sameModel: configured === generationModel,
        reason: "Explicitly configured via VERIFIER_MODEL.",
      };
    }

    try {
      const models = await modelIntelligence.all();
      const eligible = models
        .filter((m) =>
          m.status === "ASSESSED" &&
          m.active &&
          m.outputModalities.includes("TEXT") &&
          m.inputPrice > 0 &&
          m.inputPrice <= MAX_VERIFIER_COST_PER_1M &&
          // Reliability matters more than raw capability for judging.
          (m.capability?.reliability === "MEDIUM" || m.capability?.reliability === "HIGH") &&
          !/^openrouter\/auto/.test(m.openrouterModelId))
        .sort((a, b) => a.inputPrice - b.inputPrice);

      const independent = eligible.find((m) => m.openrouterModelId !== generationModel);
      if (independent) {
        return {
          modelId: independent.openrouterModelId,
          sameModel: false,
          reason: `Cheapest assessed, sufficiently reliable model independent of the generator.`,
        };
      }

      const fallback = eligible[0];
      if (fallback) {
        return {
          modelId: fallback.openrouterModelId,
          sameModel: fallback.openrouterModelId === generationModel,
          reason: "No independent verifier was available; the generator is checking its own work.",
        };
      }
    } catch (err) {
      console.error("[verifier] selection failed", err);
    }

    return { modelId: null, sameModel: false, reason: "No eligible verifier model." };
  }

  /**
   * Verifies claims against evidence.
   *
   * Every failure path returns VERIFICATION_UNAVAILABLE. A verifier that
   * cannot run is never treated as approval.
   */
  async verify(input: {
    requestId: string;
    prompt: string;
    claims: string[];
    evidence: EvidencePassage[];
    generationModel: string;
    profileId: string;
    anomalyScore?: number;
    anomalyBand?: string;
  }): Promise<VerifierResult> {
    const started = Date.now();
    const base = {
      judgements: [] as ClaimJudgement[],
      generationModel: input.generationModel,
      sameModel: false,
      costUsd: 0,
      latencyMs: 0,
      verifierModel: null as string | null,
    };

    if (input.claims.length === 0) {
      return {
        ...base, outcome: "UNVERIFIABLE", confidence: 0,
        latencyMs: Date.now() - started,
        note: "No checkable claims were extracted, so there was nothing to verify.",
      };
    }

    const selection = await this.selectVerifier(input.generationModel);
    if (!selection.modelId) {
      return this.record({
        ...base, outcome: "VERIFICATION_UNAVAILABLE", confidence: 0,
        latencyMs: Date.now() - started,
        failureReason: "NO_VERIFIER_AVAILABLE",
        note: "No eligible verifier model is available, so the claims remain unverified.",
      }, input);
    }

    // In mock mode there is no independent judge to call. Saying so is the
    // honest result; inventing verdicts would be worse than not verifying.
    if (isMockMode()) {
      return this.record({
        ...base,
        verifierModel: selection.modelId,
        sameModel: selection.sameModel,
        outcome: "VERIFICATION_UNAVAILABLE",
        confidence: 0,
        latencyMs: Date.now() - started,
        failureReason: "MOCK_MODE",
        note:
          "Running without a provider key, so no independent verifier could be " +
          "called. The claims are reported as unverified rather than assumed correct.",
      }, input);
    }

    try {
      const executable = await modelExecution.validateModel(selection.modelId, "TEXT");
      if (!executable.executable) {
        return this.record({
          ...base,
          verifierModel: selection.modelId,
          outcome: "VERIFICATION_UNAVAILABLE",
          confidence: 0,
          latencyMs: Date.now() - started,
          failureReason: executable.failureReason ?? "UNAVAILABLE",
          note: `The selected verifier could not be executed: ${executable.message}`,
        }, input);
      }

      const provider = getProvider();
      const result = await Promise.race([
        provider.generate({
          prompt: this.buildPrompt(input.prompt, input.claims, input.evidence),
          modelId: selection.modelId,
          effort: "low",
          attachments: [],
          history: [],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("verifier timeout")), VERIFIER_TIMEOUT_MS)),
      ]);

      const parsed = this.parse(result.text);
      if (!parsed.ok) {
        return this.record({
          ...base,
          verifierModel: selection.modelId,
          sameModel: selection.sameModel,
          outcome: "VERIFICATION_UNAVAILABLE",
          confidence: 0,
          costUsd: result.cost,
          latencyMs: Date.now() - started,
          failureReason: "INVALID_RESPONSE",
          note: `The verifier reply could not be trusted: ${parsed.error}`,
        }, input);
      }

      const judgements = parsed.value;
      const outcome = this.aggregate(judgements);
      const confidence = judgements.length
        ? judgements.reduce((n, j) => n + j.confidence, 0) / judgements.length
        : 0;

      return this.record({
        ...base,
        verifierModel: selection.modelId,
        sameModel: selection.sameModel,
        judgements,
        outcome,
        confidence: Math.round(confidence * 1e4) / 1e4,
        costUsd: result.cost,
        latencyMs: Date.now() - started,
        note: selection.sameModel
          ? "Verified by the same model that generated the answer, which is a weaker check than an independent verifier."
          : `Verified independently by ${selection.modelId}.`,
      }, input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timeout = /timeout|abort/i.test(message);
      return this.record({
        ...base,
        verifierModel: selection.modelId,
        sameModel: selection.sameModel,
        outcome: "VERIFICATION_UNAVAILABLE",
        confidence: 0,
        latencyMs: Date.now() - started,
        failureReason: timeout ? "TIMEOUT" : "PROVIDER_ERROR",
        note: `Verification could not complete (${message}); the claims remain unverified.`,
      }, input);
    }
  }

  /**
   * Per-claim verdicts are combined conservatively: one contradiction is
   * decisive, and a mix of supported and unverifiable is not "true".
   */
  aggregate(judgements: ClaimJudgement[]): VerifierVerdict {
    if (judgements.length === 0) return "UNVERIFIABLE";
    if (judgements.some((j) => j.verdict === "CONTRADICTED")) return "CONTRADICTED";
    if (judgements.some((j) => j.verdict === "UNVERIFIABLE")) return "UNVERIFIABLE";
    return "SUPPORTED";
  }

  private buildPrompt(prompt: string, claims: string[], evidence: EvidencePassage[]): string {
    const evidenceBlock = evidence.length
      ? evidence.map((e, i) => `[E${i + 1}] (${e.source}) ${e.text}`).join("\n")
      : "(no evidence retrieved)";
    const claimBlock = claims.map((c, i) => `${i + 1}. ${c}`).join("\n");
    return `${SYSTEM_PROMPT}

Original question:
"""${prompt.slice(0, 1000)}"""

Evidence:
${evidenceBlock.slice(0, 6000)}

Claims to verify:
${claimBlock.slice(0, 3000)}`;
  }

  parse(raw: string): { ok: true; value: ClaimJudgement[] } | { ok: false; error: string } {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return { ok: false, error: "no JSON object in reply" };

    let json: unknown;
    try {
      json = JSON.parse(cleaned.slice(start, end + 1));
    } catch (err) {
      return { ok: false, error: `malformed JSON (${err instanceof Error ? err.message : "parse failed"})` };
    }

    const parsed = JudgementSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, error: `field '${issue?.path.join(".")}' invalid` };
    }
    return { ok: true, value: parsed.data.claims };
  }

  private async record(result: VerifierResult, input: {
    requestId: string; profileId: string; anomalyScore?: number; anomalyBand?: string;
  }): Promise<VerifierResult> {
    try {
      await prisma.verifierCall.create({
        data: {
          requestId: input.requestId,
          verifierModel: result.verifierModel ?? "none",
          generationModel: result.generationModel,
          sameModel: result.sameModel,
          claimsVerified: result.judgements.length,
          supported: result.judgements.filter((j) => j.verdict === "SUPPORTED").length,
          contradicted: result.judgements.filter((j) => j.verdict === "CONTRADICTED").length,
          unverifiable: result.judgements.filter((j) => j.verdict === "UNVERIFIABLE").length,
          outcome: result.outcome,
          failureReason: result.failureReason ?? null,
          confidence: result.confidence,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          profileId: input.profileId,
          anomalyScore: input.anomalyScore ?? 0,
          anomalyBand: input.anomalyBand ?? "NORMAL",
        },
      });
    } catch (err) {
      console.error("[verifier] telemetry write failed", err);
    }
    return result;
  }
}

export const aiVerifier = new AIVerifier();
export { modelRegistry };
