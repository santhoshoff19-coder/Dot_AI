import { prisma } from "@/lib/db";
import type { UseCaseProfile } from "@/lib/governance/profiles";
import type { RiskFinding } from "@/lib/governance/risk-findings";
import type { VerificationDepth } from "@/types";

export type SessionRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface SessionRiskState {
  sessionId: string;
  profileId: string;
  riskScore: number;
  riskLevel: SessionRiskLevel;
  unverifiedClaimCount: number;
  contradictionCount: number;
  responsibilityFindingCount: number;
  highRiskActionCount: number;
  turnCount: number;
}

/**
 * Weights are deliberately small integers rather than a tuned model. The point
 * is to notice accumulation across a conversation, not to be precise: one
 * hedged answer is noise, four unsupported claims and a payment request is a
 * pattern.
 */
const WEIGHTS = {
  unverifiedClaim: 1,
  contradiction: 3,
  responsibilityFinding: 2,
  highRiskAction: 4,
};

const MEDIUM_AT = Number(process.env.SESSION_RISK_MEDIUM_AT ?? 3);
const HIGH_AT = Number(process.env.SESSION_RISK_HIGH_AT ?? 7);

export function levelFor(score: number): SessionRiskLevel {
  if (score >= HIGH_AT) return "HIGH";
  if (score >= MEDIUM_AT) return "MEDIUM";
  return "LOW";
}

const EMPTY = (sessionId: string, profileId: string): SessionRiskState => ({
  sessionId, profileId, riskScore: 0, riskLevel: "LOW",
  unverifiedClaimCount: 0, contradictionCount: 0,
  responsibilityFindingCount: 0, highRiskActionCount: 0, turnCount: 0,
});

/**
 * SessionRiskService.
 *
 * Tracks how risk accumulates within one conversation. This is strictly a
 * property of the conversation: it never writes to model capability,
 * reliability or execution health, because a risky conversation says nothing
 * about whether the model is any good.
 */
export class SessionRiskService {
  async get(sessionId: string, profileId: string): Promise<SessionRiskState> {
    if (!sessionId) return EMPTY(sessionId, profileId);
    const row = await prisma.sessionRisk.findUnique({ where: { sessionId } });
    if (!row) return EMPTY(sessionId, profileId);
    return {
      sessionId: row.sessionId,
      profileId: row.profileId,
      riskScore: row.riskScore,
      riskLevel: row.riskLevel as SessionRiskLevel,
      unverifiedClaimCount: row.unverifiedClaimCount,
      contradictionCount: row.contradictionCount,
      responsibilityFindingCount: row.responsibilityFindingCount,
      highRiskActionCount: row.highRiskActionCount,
      turnCount: row.turnCount,
    };
  }

  /** Folds this turn's findings into the running conversation risk. */
  async record(
    sessionId: string,
    profileId: string,
    findings: RiskFinding[],
  ): Promise<SessionRiskState> {
    const current = await this.get(sessionId, profileId);
    if (!sessionId) return current;

    let unverified = 0, contradictions = 0, responsibility = 0, actions = 0;
    for (const f of findings) {
      if (f.categories.includes("HALLUCINATION")) contradictions++;
      else if (f.categories.includes("UNVERIFIABLE")) unverified++;
      if (f.categories.some((c) =>
        ["PRIVACY", "SENSITIVE_DATA", "SAFETY", "FAIRNESS", "SECURITY", "POLICY_VIOLATION"]
          .includes(c))) responsibility++;
      if (f.categories.includes("HIGH_CONSEQUENCE_ACTION")) actions++;
    }

    const next: SessionRiskState = {
      ...current,
      profileId,
      unverifiedClaimCount: current.unverifiedClaimCount + unverified,
      contradictionCount: current.contradictionCount + contradictions,
      responsibilityFindingCount: current.responsibilityFindingCount + responsibility,
      highRiskActionCount: current.highRiskActionCount + actions,
      turnCount: current.turnCount + 1,
    };

    next.riskScore =
      next.unverifiedClaimCount * WEIGHTS.unverifiedClaim +
      next.contradictionCount * WEIGHTS.contradiction +
      next.responsibilityFindingCount * WEIGHTS.responsibilityFinding +
      next.highRiskActionCount * WEIGHTS.highRiskAction;
    next.riskLevel = levelFor(next.riskScore);

    try {
      await prisma.sessionRisk.upsert({
        where: { sessionId },
        create: {
          sessionId, profileId,
          riskScore: next.riskScore, riskLevel: next.riskLevel,
          unverifiedClaimCount: next.unverifiedClaimCount,
          contradictionCount: next.contradictionCount,
          responsibilityFindingCount: next.responsibilityFindingCount,
          highRiskActionCount: next.highRiskActionCount,
          turnCount: next.turnCount,
        },
        update: {
          profileId,
          riskScore: next.riskScore, riskLevel: next.riskLevel,
          unverifiedClaimCount: next.unverifiedClaimCount,
          contradictionCount: next.contradictionCount,
          responsibilityFindingCount: next.responsibilityFindingCount,
          highRiskActionCount: next.highRiskActionCount,
          turnCount: next.turnCount,
        },
      });
    } catch (err) {
      console.error("[session-risk] write failed", err);
    }
    return next;
  }

  async reset(sessionId: string): Promise<void> {
    await prisma.sessionRisk.deleteMany({ where: { sessionId } }).catch(() => undefined);
  }
}

const DEPTHS: VerificationDepth[] = ["light", "standard", "deep"];

/**
 * Verification depth is the profile's floor, raised by whichever of the
 * response-level or session-level signals demands more. It is never lowered:
 * a permissive profile cannot talk the system out of checking a dangerous
 * request, and a calm session cannot relax a regulated one.
 */
export function resolveVerificationDepth(
  profile: UseCaseProfile,
  responseDepth: VerificationDepth,
  sessionRisk: SessionRiskLevel,
): { depth: VerificationDepth; reason: string } {
  const base = DEPTHS.indexOf(profile.baseVerificationDepth);
  const response = DEPTHS.indexOf(responseDepth);
  const session = sessionRisk === "HIGH" ? 2 : sessionRisk === "MEDIUM" ? 1 : 0;

  const chosen = Math.max(base, response, session);
  const reasons: string[] = [];
  if (chosen === base && base >= response && base >= session) {
    reasons.push(`profile floor (${profile.baseVerificationDepth})`);
  }
  if (response === chosen && response > base) reasons.push("this response's risk");
  if (session === chosen && session > base) reasons.push(`session risk ${sessionRisk}`);

  return {
    depth: DEPTHS[chosen],
    reason: reasons.length ? `Raised by ${reasons.join(" and ")}.` : `Profile floor.`,
  };
}

export const sessionRiskService = new SessionRiskService();
