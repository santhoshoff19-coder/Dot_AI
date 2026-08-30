import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getProfile } from "@/lib/governance/profiles";
import { toRiskFindings } from "@/lib/governance/risk-findings";
import { responsibilityService } from "@/lib/responsibility/service";
import { performanceService } from "@/lib/performance/service";
import {
  normaliseJurisdiction, policyDecisionEngine, policyRetrieval,
} from "@/lib/policy/engine";
import { policyIngestion } from "@/lib/policy/ingest";
import type { ControlEventData } from "@/types";

export type SamplingStrategy = "RANDOM" | "RISK_BASED" | "MODEL_BASED" | "PROFILE_BASED";

export interface BatchAuditOptions {
  strategy: SamplingStrategy;
  sampleSize?: number;
  profileId?: string;
  modelId?: string;
  /** Deep checks are the expensive tier; capped so a sweep stays affordable. */
  maxDeepChecks?: number;
}

export interface BatchAuditSummary {
  runId: string;
  strategy: SamplingStrategy;
  populationSize: number;
  sampled: number;
  deepChecks: number;
  findings: number;
  divergent: number;
  byCategory: Record<string, number>;
  byPolicyDecision: Record<string, number>;
  checkerCostUsd: number;
  cost: {
    checker: number; verifier: number; rag: number;
    auditTotal: number; reviewedGeneration: number;
  };
  durationMs: number;
}

/**
 * Post-hoc auditing.
 *
 * Real-time checking protects the user in the moment; this looks back over
 * traffic that already shipped and asks whether it would still pass. It is
 * deliberately cheap: every sample gets deterministic checks, and only
 * suspicious ones are escalated to the expensive tier.
 */
export class BatchAuditService {
  async run(options: BatchAuditOptions): Promise<BatchAuditSummary> {
    const started = Date.now();
    const sampleSize = Math.min(options.sampleSize ?? 25, 200);
    const maxDeepChecks = options.maxDeepChecks ?? Math.ceil(sampleSize / 5);

    // A4: the profile is recorded on the control event itself, so the
    // population is genuinely restricted in the query rather than filtered
    // after the fact (which previously meant PROFILE_BASED sampled everything).
    const where: Prisma.MessageWhereInput = {
      role: "assistant",
      ...(options.modelId || options.profileId
        ? {
            controlEvent: {
              ...(options.modelId ? { selectedModel: options.modelId } : {}),
              ...(options.profileId ? { profileId: options.profileId } : {}),
            },
          }
        : {}),
    };

    const populationSize = await prisma.message.count({ where });
    const population = await prisma.message.findMany({
      where,
      include: { controlEvent: true },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(populationSize, 1), 500),
    });

    const sample = this.sample(population, options.strategy, sampleSize);

    const run = await prisma.batchAuditRun.create({
      data: {
        strategy: options.strategy,
        sampleSize: sample.length,
        populationSize,
        profileId: options.profileId ?? null,
        jurisdiction: "EU",
      },
    });

    let deepChecks = 0;
    let findings = 0;
    // A5: costs actually incurred by this audit pass, plus the recorded cost
    // of the original generations being reviewed.
    const cost = { checker: 0, verifier: 0, rag: 0, generation: 0 };
    let divergent = 0;
    const byCategory: Record<string, number> = {};
    const byPolicyDecision: Record<string, number> = {};

    await policyIngestion.ensureSeeded();

    for (const message of sample) {
      const profile = getProfile(options.profileId);
      const answer = message.content ?? "";
      if (!answer) continue;

      // --- cheap tier: deterministic detectors only -----------------------
      const responsibility = responsibilityService.check(answer, {
        destination: { channel: "chat", external: false },
        actor: { role: "support_agent", permissions: [] },
      });

      const suspicious =
        responsibility.findings.length > 0 ||
        message.controlEvent?.performanceResult === "CONTRADICTED" ||
        message.controlEvent?.performanceResult === "UNCERTAIN";

      // --- expensive tier: only for suspicious samples, and capped --------
      let performance = null;
      let deepChecked = false;
      if (suspicious && deepChecks < maxDeepChecks) {
        performance = await performanceService.check("", answer, "standard");
        deepChecks++;
        deepChecked = true;
      }

      const riskFindings = toRiskFindings(
        performance ?? {
          status: "UNVERIFIABLE", claimsChecked: 0, verdicts: [],
          checksRun: [], earlyExit: false,
        },
        responsibility,
        { answerText: answer, highConsequenceAction: false, actionValueUsd: 0 },
      );

      if (riskFindings.length === 0) continue;

      const categories = [...new Set(riskFindings.flatMap((f) => f.categories))];
      for (const c of categories) byCategory[c] = (byCategory[c] ?? 0) + 1;

      // --- policy evaluation, same engine as the live path ----------------
      const jurisdictions = [...new Set(profile.jurisdiction.map(normaliseJurisdiction))];
      const retrieval = await policyRetrieval.retrieve({
        riskCategories: categories,
        external: false,
        jurisdictions,
      });
      cost.rag += retrieval.costUsd;
      cost.generation += message.controlEvent?.actualCost ?? 0;
      if (deepChecked) cost.checker += performance?.verification?.costUsd ?? 0;
      const verdict = policyDecisionEngine.decide({
        profile, jurisdictions, riskCategories: categories, dataTypes: [],
        external: false, evidence: retrieval.evidence, retrievalMode: retrieval.mode,
      });

      byPolicyDecision[verdict.decision] = (byPolicyDecision[verdict.decision] ?? 0) + 1;

      const originalDecision = message.controlEvent?.decision ?? "ALLOW";
      const isDivergent =
        (originalDecision === "ALLOW" || originalDecision === "ANNOTATE") &&
        (verdict.decision === "HOLD" || verdict.decision === "BLOCK" ||
         verdict.decision === "UNVERIFIABLE");
      if (isDivergent) divergent++;

      const worst = riskFindings.reduce(
        (acc, f) => (rank(f.severity) > rank(acc) ? f.severity : acc), "low" as string);

      await prisma.batchAuditFinding.create({
        data: {
          runId: run.id,
          messageId: message.id,
          requestId: message.controlEvent?.requestId || null,
          modelId: message.controlEvent?.selectedModel ?? null,
          profileId: profile.id,
          riskCategories: JSON.stringify(categories),
          severity: worst,
          policyDecision: verdict.decision,
          originalDecision,
          divergent: isDivergent,
          reason: verdict.reason,
          evidence: JSON.stringify(verdict.citedEvidence),
          deepChecked,
        },
      });
      findings++;
    }

    const durationMs = Date.now() - started;
    const auditCost = cost.checker + cost.verifier + cost.rag;
    await prisma.batchAuditRun.update({
      where: { id: run.id },
      data: {
        deepChecks, findingsCount: findings, durationMs,
        checkerCostUsd: auditCost,
      },
    });

    return {
      runId: run.id,
      strategy: options.strategy,
      populationSize,
      sampled: sample.length,
      deepChecks,
      findings,
      divergent,
      byCategory,
      byPolicyDecision,
      checkerCostUsd: round(auditCost),
      cost: {
        // Cost this audit pass actually incurred.
        checker: round(cost.checker),
        verifier: round(cost.verifier),
        rag: round(cost.rag),
        auditTotal: round(auditCost),
        // Recorded cost of the generations being reviewed, not spent again.
        reviewedGeneration: round(cost.generation),
      },
      durationMs,
    };
  }

  /** Simple, explainable sampling. */
  private sample<T extends { controlEvent: { decision: string; riskLevel: string } | null }>(
    population: T[], strategy: SamplingStrategy, size: number,
  ): T[] {
    if (population.length <= size) return population;

    switch (strategy) {
      case "RISK_BASED": {
        // Anything the live path already found interesting comes first.
        const scored = [...population].sort(
          (a, b) => riskScore(b) - riskScore(a));
        return scored.slice(0, size);
      }
      case "MODEL_BASED":
      case "PROFILE_BASED": {
        // The population is already restricted to the requested model or
        // profile by the query above; sample randomly within it so the result
        // is representative of that slice rather than just its newest rows.
        const copy = [...population];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy.slice(0, size);
      }
      case "RANDOM":
      default: {
        const copy = [...population];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy.slice(0, size);
      }
    }
  }

  async listRuns(limit = 20) {
    return prisma.batchAuditRun.findMany({
      orderBy: { createdAt: "desc" }, take: limit,
      include: { _count: { select: { findings: true } } },
    });
  }

  async findingsFor(runId: string) {
    return prisma.batchAuditFinding.findMany({
      where: { runId }, orderBy: { createdAt: "desc" },
    });
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function riskScore(m: { controlEvent: { decision: string; riskLevel: string } | null }): number {
  const d = m.controlEvent?.decision ?? "ALLOW";
  const r = m.controlEvent?.riskLevel ?? "low";
  const byDecision: Record<string, number> = {
    BLOCK: 5, HOLD: 4, REGENERATE: 3, ANNOTATE: 2, ALLOW: 0,
  };
  const byRisk: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 0 };
  return (byDecision[d] ?? 0) + (byRisk[r] ?? 0);
}

function rank(s: string): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[s] ?? 0;
}

export const batchAudit = new BatchAuditService();

/** Placeholder so an unused import of ControlEventData does not break builds. */
export type { ControlEventData };
