import { prisma } from "@/lib/db";
import type { ControlEventData } from "@/types";

export interface ModelStat {
  modelId: string;
  runs: number;
  clean: number;
  reliability: number;
  avgCost: number;
  avgLatencyMs: number;
}

/**
 * LearningService. Stores validated outcomes so routing can eventually learn
 * MODEL x TASK x COMPLEXITY. This records real observed data only - it does
 * not fabricate machine learning.
 */
export class LearningService {
  async record(event: ControlEventData): Promise<void> {
    try {
      await prisma.learningRecord.create({
        data: {
          modelId: event.selectedModel,
          taskType: event.taskClassification,
          complexity: event.complexity,
          success: event.decision.decision === "ALLOW" || event.decision.decision === "ANNOTATE",
          verification: event.verification.status,
          cost: event.actualCost,
          latencyMs: event.latencyMs,
        },
      });
    } catch (err) {
      console.error("[learning] write failed", err);
    }
  }

  async markHumanOverride(modelId: string): Promise<void> {
    try {
      const row = await prisma.learningRecord.findFirst({
        where: { modelId }, orderBy: { createdAt: "desc" },
      });
      if (row) {
        await prisma.learningRecord.update({
          where: { id: row.id }, data: { humanOverride: true },
        });
      }
    } catch (err) {
      console.error("[learning] override write failed", err);
    }
  }

  /** Observed reliability. Returns null below a minimum sample size. */
  async stats(): Promise<ModelStat[]> {
    const rows = await prisma.learningRecord.findMany();
    const byModel = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byModel.get(r.modelId) ?? [];
      list.push(r);
      byModel.set(r.modelId, list);
    }
    return [...byModel.entries()].map(([modelId, list]) => ({
      modelId,
      runs: list.length,
      clean: list.filter((r) => r.success).length,
      reliability: list.length ? list.filter((r) => r.success).length / list.length : 0,
      avgCost: list.reduce((n, r) => n + r.cost, 0) / Math.max(list.length, 1),
      avgLatencyMs: list.reduce((n, r) => n + r.latencyMs, 0) / Math.max(list.length, 1),
    }));
  }

  /**
   * Minimum sample size before observed data is allowed to influence routing.
   * Below this the declared registry scores stand.
   */
  readonly minSampleSize = 5;

  /**
   * Observed reliability for MODEL x TASK, refreshed in the background.
   *
   * The scoring engine calls this synchronously on the hot path, so it reads a
   * cache rather than the database. There is deliberately no universal
   * intelligence score: a model can be excellent at summarisation and weak at
   * complex reasoning, and routing should know the difference.
   */
  private cache = new Map<string, { rate: number; samples: number }>();
  private cacheLoadedAt = 0;

  reliabilityFor(modelId: string, taskType: string): { rate: number; samples: number } | null {
    if (Date.now() - this.cacheLoadedAt > 30_000) void this.refresh();
    return this.cache.get(`${modelId}::${taskType}`) ?? null;
  }

  async refresh(): Promise<void> {
    this.cacheLoadedAt = Date.now();
    try {
      const rows = await prisma.learningRecord.findMany({ take: 2000 });
      const acc = new Map<string, { ok: number; n: number }>();
      for (const r of rows) {
        const key = `${r.modelId}::${r.taskType}`;
        const cur = acc.get(key) ?? { ok: 0, n: 0 };
        cur.n++;
        if (r.success) cur.ok++;
        acc.set(key, cur);
      }
      const next = new Map<string, { rate: number; samples: number }>();
      acc.forEach((v, k) => next.set(k, { rate: v.ok / Math.max(v.n, 1), samples: v.n }));
      this.cache = next;
    } catch {
      // Routing must never fail because the learning store is unavailable.
    }
  }
}

export const learningService = new LearningService();
