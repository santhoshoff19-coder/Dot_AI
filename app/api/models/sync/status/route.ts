import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything the Sync status page needs, in one query set. */
export async function GET() {
  try {
    const [lastSuccess, lastAny, recent, total, active, byStatus, byCategory, execByStatus] =
      await Promise.all([
        prisma.modelSyncEvent.findFirst({
          where: { status: { in: ["SUCCESS", "PARTIAL"] } }, orderBy: { createdAt: "desc" },
        }),
        prisma.modelSyncEvent.findFirst({ orderBy: { createdAt: "desc" } }),
        prisma.modelSyncEvent.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
        prisma.model.count(),
        prisma.model.count({ where: { active: true } }),
        prisma.modelCapability.groupBy({ by: ["status"], _count: true }),
        prisma.modelCategoryLink.groupBy({ by: ["category"], _count: true }),
        prisma.modelExecutionStatus.groupBy({ by: ["status"], _count: true }),
      ]);

    const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count]));

    return Response.json({
      lastSuccessfulSync: lastSuccess,
      lastSync: lastAny,
      recent,
      totals: {
        total,
        active,
        inactive: total - active,
        assessed: counts.ASSESSED ?? 0,
        assessmentPending: counts.ASSESSMENT_PENDING ?? 0,
        assessmentFailed: counts.ASSESSMENT_FAILED ?? 0,
        unassessed: counts.UNASSESSED ?? 0,
      },
      byCategory: Object.fromEntries(byCategory.map((c) => [c.category, c._count])),
      execution: Object.fromEntries(execByStatus.map((e) => [e.status, e._count])),
    });
  } catch (err) {
    return Response.json({ error: "Could not load sync status.", detail: String(err) }, { status: 500 });
  }
}
