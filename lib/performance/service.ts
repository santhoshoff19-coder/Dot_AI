import { retrievalService } from "@/lib/retrieval/service";
import { anomalyDetector, type AnomalyResult } from "@/lib/verification/anomaly";
import { aiVerifier, type VerifierResult } from "@/lib/verification/judge";
import { decideEscalation } from "@/lib/verification/escalation";
import type { UseCaseProfile } from "@/lib/governance/profiles";
import type {
  Claim, ClaimVerdict, EvidencePassage, PerformanceResult, PerformanceStatus,
  VerificationDepth,
} from "@/types";

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?%?/g;
const SENTENCE = /(?<=[.!?])\s+/;

const HEDGES = ["i think", "probably", "i believe", "might be", "not sure", "could not verify"];
const CONFIDENT = ["confirmed", "certainly", "definitely", "guaranteed", "verified", "exactly"];

/** Identifiers must never be read as arithmetic operands. */
function looksLikeIdentifier(expr: string): boolean {
  const compact = expr.replace(/\s/g, "");
  if (compact.includes("-") && !/\s/.test(expr.trim())) return true;
  return /^\d{2,}(?:\s*-\s*\d{2,}){2,}$/.test(expr.trim());
}

const ARITHMETIC =
  /(?<expr>\d[\d\s,]*(?:[+\-*/]\s*[\d,.]+\s*)+)[^\d]{0,60}?(?:is|=|equals|totals?(?: is)?)\s*\$?\s*(?<claim>[\d,]+(?:\.\d+)?)/gi;

function normalise(n: string): string {
  return n.replace(/[$,]/g, "").replace(/\.0+$/, "").replace(/%$/, "");
}

export function extractClaims(text: string): Claim[] {
  return text
    .split(SENTENCE)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .map((s) => {
      const values = s.match(NUMBER) ?? [];
      return { text: s, values, checkable: values.length > 0 };
    });
}

/** Deterministic check: re-run any arithmetic the model asserted. */
export function checkArithmetic(text: string): { ok: boolean; detail: string }[] {
  const out: { ok: boolean; detail: string }[] = [];
  for (const m of text.matchAll(ARITHMETIC)) {
    const raw = m.groups?.expr ?? "";
    if (looksLikeIdentifier(raw)) continue;
    const expr = raw.replace(/,/g, "").trim().replace(/[+\-*/\s]+$/, "");
    if (!/^[\d\s+\-*/.]+$/.test(expr)) continue;
    let actual: number;
    try {
      // Arithmetic-only expression, validated by the guard above.
      actual = Function(`"use strict";return (${expr})`)() as number;
    } catch { continue; }
    const claimed = Number((m.groups?.claim ?? "").replace(/,/g, ""));
    if (!Number.isFinite(actual) || !Number.isFinite(claimed)) continue;
    if (Math.abs(actual - claimed) > Math.max(0.01, Math.abs(actual) * 1e-6)) {
      out.push({
        ok: false,
        detail: `Model asserted ${expr} = ${claimed}, calculator returns ${actual}.`,
      });
    } else {
      out.push({ ok: true, detail: `${expr} = ${actual} verified by calculator.` });
    }
  }
  return out;
}

const GENERIC = new Set(["this", "that", "with", "from", "have", "will", "your",
  "their", "which", "there", "these", "those", "been", "were", "also", "into",
  "current", "today", "please", "would", "could", "about"]);

/** Count distinctive words shared by a claim and a candidate evidence passage. */
function sharedSubjectTerms(claim: string, evidence: string): number {
  const words = (s: string) =>
    new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !GENERIC.has(w)));
  const a = words(claim);
  const b = words(evidence);
  let n = 0;
  a.forEach((w) => { if (b.has(w)) n++; });
  return n;
}

export class PerformanceService {
  /**
   * Verification ladder, cheapest rung first: calculator -> evidence ->
   * calibration. Stops as soon as the answer is settled (early exit).
   */
  async check(
    prompt: string,
    answer: string,
    depth: VerificationDepth,
    /**
     * Optional context enabling the anomaly and verifier rungs. Without it the
     * ladder behaves exactly as before, so every existing caller is unaffected.
     */
    context?: {
      profile: UseCaseProfile;
      requestId: string;
      generationModel: string;
      taskType: string;
    },
  ): Promise<PerformanceResult> {
    const ladderStarted = Date.now();
    const checksRun: string[] = [];
    const verdicts: ClaimVerdict[] = [];

    // --- Rung 1: calculator (always, always cheap) -------------------------
    checksRun.push("calculator");
    const arithmetic = checkArithmetic(answer);
    for (const a of arithmetic) {
      if (!a.ok) {
        verdicts.push({
          claim: a.detail, status: "CONTRADICTED",
          detail: "Disproved by deterministic calculation.", evidence: null,
        });
      }
    }
    if (verdicts.some((v) => v.status === "CONTRADICTED")) {
      return {
        status: "CONTRADICTED", claimsChecked: arithmetic.length, verdicts,
        checksRun, earlyExit: true,
        note: "A deterministic check settled this, so no verifier model was called.",
      };
    }

    const claims = extractClaims(answer);
    const checkable = claims.filter((c) => c.checkable);

    // --- Light depth: no retrieval on low-risk traffic ---------------------
    if (depth === "light") {
      const status: PerformanceStatus = checkable.length ? "UNVERIFIABLE" : "SUPPORTED";
      return {
        status,
        claimsChecked: 0,
        verdicts: checkable.length
          ? [{
              claim: `${checkable.length} factual claim(s) present`,
              status: "UNVERIFIABLE",
              detail: "Low-risk request: deterministic checks only, no evidence retrieval.",
              evidence: null,
            }]
          : [],
        checksRun,
        earlyExit: false,
        note: checkable.length
          ? "Verification depth was LIGHT. Claims were not grounded against sources."
          : "No checkable factual claims were made.",
      };
    }

    // --- Rung 2: evidence grounding ----------------------------------------
    checksRun.push("retrieval", "evidence_comparison");
    let contradicted = 0;
    let supported = 0;
    let uncertain = 0;

    for (const claim of checkable) {
      const passages = await retrievalService.retrieve(claim.text, undefined, 3);
      const best: EvidencePassage | null = passages[0] ?? null;

      if (!best) {
        uncertain++;
        verdicts.push({
          claim: claim.text, status: "UNCERTAIN",
          detail: "No supporting source was retrieved.", evidence: null,
        });
        continue;
      }

      const evidenceNumbers = new Set((best.text.match(NUMBER) ?? []).map(normalise));
      const claimNumbers = claim.values.map(normalise);
      const overlap = claimNumbers.filter((n) => evidenceNumbers.has(n));

      // Only compare like with like: currency claims against currency evidence.
      const currencyClaim = claim.values.filter((v) => v.includes("$")).map(normalise);
      const currencyEvidence = new Set(
        (best.text.match(NUMBER) ?? []).filter((v) => v.includes("$")).map(normalise));

      // Two different amounts only contradict each other if they describe the
      // same thing. Without this, "$50,000 payment" would be reported as
      // contradicting an unrelated "$10,000" approval threshold.
      const sameSubject = sharedSubjectTerms(claim.text, best.text) >= 2;

      if (overlap.length > 0) {
        supported++;
        verdicts.push({
          claim: claim.text, status: "SUPPORTED",
          detail: `Value matches ${best.source}.`, evidence: best,
        });
      } else if (currencyClaim.length > 0 && currencyEvidence.size > 0 && sameSubject) {
        contradicted++;
        verdicts.push({
          claim: claim.text, status: "CONTRADICTED",
          detail: `Stated ${currencyClaim.map((c) => "$" + c).join(", ")}; ${best.source} records ${[...currencyEvidence].map((c) => "$" + c).join(", ")}.`,
          evidence: best,
        });
      } else {
        uncertain++;
        verdicts.push({
          claim: claim.text, status: "UNCERTAIN",
          detail: `${best.source} contains no comparable value.`, evidence: best,
        });
      }
    }

    // --- Rung 3: calibration ------------------------------------------------
    checksRun.push("calibration");
    const low = answer.toLowerCase();
    const overconfident = CONFIDENT.some((c) => low.includes(c)) && uncertain > 0;
    const hedged = HEDGES.some((h) => low.includes(h));

    if (depth === "deep") checksRun.push("deep_review");

    let status: PerformanceStatus = "SUPPORTED";
    if (contradicted > 0) status = "CONTRADICTED";
    else if (checkable.length === 0) status = "SUPPORTED";
    else if (uncertain > 0 && supported === 0) status = "UNCERTAIN";
    else if (uncertain > 0) status = "UNCERTAIN";

    const notes: string[] = [];
    if (overconfident) notes.push("Confident phrasing on claims the evidence does not support.");
    if (hedged) notes.push("The model hedged; the answer may be incomplete.");

    // --- Rungs 4 and 5: anomaly detection and AI verification ---------------
    // Both are optional and gated. Deterministic-first: if a calculator or the
    // source of record already settled this, neither rung runs.
    let anomaly: AnomalyResult | undefined;
    let verification: VerifierResult | undefined;

    if (context) {
      const escalation = decideEscalation({
        profile: context.profile,
        depth,
        deterministicStatus: status,
        settledDeterministically: contradicted > 0 && verdicts.some((v) => v.evidence?.authoritative),
        anomalyBand: "NORMAL",
        checkableClaims: checkable.length,
        elapsedMs: Date.now() - ladderStarted,
      });

      const slice = {
        profileId: context.profile.id,
        taskType: context.taskType,
        modelId: context.generationModel,
      };

      if (escalation.runAnomaly) {
        checksRun.push("anomaly");
        anomaly = await anomalyDetector.score(answer, slice, context.profile);
        if (anomaly.band !== "NORMAL") notes.push(anomaly.explanation);
      }

      // Re-evaluate now that the anomaly band is known: an unusual response
      // can justify a verifier call that a typical one would not.
      const second = decideEscalation({
        profile: context.profile,
        depth,
        deterministicStatus: status,
        settledDeterministically: contradicted > 0 && verdicts.some((v) => v.evidence?.authoritative),
        anomalyBand: anomaly?.band ?? "NORMAL",
        checkableClaims: checkable.length,
        elapsedMs: Date.now() - ladderStarted,
      });

      if (second.runVerifier) {
        checksRun.push("ai_verifier");
        const evidencePool = verdicts
          .map((v) => v.evidence)
          .filter((e): e is NonNullable<typeof e> => Boolean(e));

        verification = await aiVerifier.verify({
          requestId: context.requestId,
          prompt,
          claims: checkable.map((c) => c.text),
          evidence: evidencePool,
          generationModel: context.generationModel,
          profileId: context.profile.id,
          anomalyScore: anomaly?.score,
          anomalyBand: anomaly?.band,
        });

        // A verifier may raise doubt but never clear a contradiction found
        // deterministically - a model opinion does not overrule the ledger.
        if (verification.outcome === "CONTRADICTED" && status !== "CONTRADICTED") {
          status = "CONTRADICTED";
        } else if (
          verification.outcome === "VERIFICATION_UNAVAILABLE" && status === "SUPPORTED"
        ) {
          status = "UNVERIFIABLE";
        } else if (verification.outcome === "UNVERIFIABLE" && status === "SUPPORTED") {
          status = "UNCERTAIN";
        }
        notes.push(verification.note);
      } else if (escalation.runVerifier === false) {
        notes.push(second.reason);
      }
    }

    return {
      status,
      claimsChecked: checkable.length,
      verdicts,
      checksRun,
      earlyExit: false,
      anomaly,
      verification,
      checkerLatencyMs: Date.now() - ladderStarted,
      note: notes.join(" ") || undefined,
    };
  }
}

export const performanceService = new PerformanceService();
