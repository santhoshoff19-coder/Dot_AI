import { prisma } from "@/lib/db";
import type { PolicyDecisionResult, RetrievalResult } from "@/lib/policy/engine";
import type { Jurisdiction } from "@/lib/policy/taxonomy";

export interface PolicyOutcome {
  retrieval: RetrievalResult;
  verdict: PolicyDecisionResult;
  jurisdictions: Jurisdiction[];
}

/**
 * Preserves the evidence behind a policy decision so it stays explainable
 * even after the underlying policy is superseded.
 */
export async function recordPolicyDecision(
  requestId: string, profileId: string, outcome: PolicyOutcome,
  riskCategories: string[],
): Promise<void> {
  try {
    await prisma.policyDecisionRecord.create({
      data: {
        requestId,
        profileId,
        jurisdiction: outcome.jurisdictions.join(","),
        decision: outcome.verdict.decision,
        reason: outcome.verdict.reason,
        conflict: outcome.verdict.conflict,
        retrievalMode: outcome.retrieval.mode,
        evidence: JSON.stringify(outcome.verdict.citedEvidence),
        riskCategories: JSON.stringify(riskCategories),
      },
    });
  } catch (err) {
    console.error("[policy] audit write failed", err);
  }
}

export async function policyDecisionsFor(requestId: string) {
  return prisma.policyDecisionRecord.findMany({
    where: { requestId }, orderBy: { createdAt: "desc" },
  });
}
