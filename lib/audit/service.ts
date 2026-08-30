import { prisma } from "@/lib/db";
import type { ControlEventData } from "@/types";

/**
 * AuditService. Every request writes exactly one audit row.
 * Never stores hidden chain-of-thought - only the final answer metadata.
 */
export class AuditService {
  async record(event: ControlEventData, userId = "local-user"): Promise<void> {
    try {
      await prisma.auditEvent.create({
        data: {
          requestId: event.requestId,
          userId,
          taskType: event.taskClassification,
          selectedModel: event.selectedModel,
          provider: event.provider,
          estimatedCost: event.estimatedCost,
          actualCost: event.actualCost,
          performanceResult: event.verification.status,
          responsibilityResult: event.responsibility.status,
          riskLevel: event.riskLevel,
          decision: event.decision.decision,
          action: event.actionGate ? `${event.actionGate.decision}:${event.actionGate.stage}` : "none",
          payload: JSON.stringify({
            reason: event.decision.reason,
            claimsChecked: event.verification.claimsChecked,
            latencyMs: event.latencyMs,
            attempts: event.attempts,
            mock: event.mock,
          }),
        },
      });
    } catch (err) {
      console.error("[audit] write failed", err);
    }
  }

  async recordHumanDecision(requestId: string, humanDecision: string): Promise<void> {
    try {
      const row = await prisma.auditEvent.findFirst({ where: { requestId } });
      if (row) {
        await prisma.auditEvent.update({ where: { id: row.id }, data: { humanDecision } });
      }
    } catch (err) {
      console.error("[audit] human decision write failed", err);
    }
  }

  async recent(limit = 50) {
    return prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  }
}

export const auditService = new AuditService();
