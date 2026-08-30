import { PageHeader } from "@/components/layout/page-header";
import { StatusPill, toneForDecision, toneForStatus } from "@/components/ui/status-pill";
import { prisma } from "@/lib/db";
import { formatCost, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ControlPage() {
  const events = await prisma.controlEvent.findMany({
    orderBy: { createdAt: "desc" }, take: 60,
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Control"
        subtitle="Every decision ControlPlane has made, newest first."
      />
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {events.length === 0 ? (
          <p className="text-[13px] text-muted">
            No control events yet. Send a message to generate one.
          </p>
        ) : (
          <div className="mx-auto max-w-4xl space-y-2">
            {events.map((e) => (
              <div key={e.id} className="rounded-xl bg-surface hairline p-3.5">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <StatusPill tone={toneForDecision(e.decision)}>{e.decision}</StatusPill>
                  <StatusPill tone={toneForStatus(e.performanceResult)}>
                    {e.performanceResult}
                  </StatusPill>
                  <StatusPill tone={toneForStatus(e.responsibilityResult)}>
                    {e.responsibilityResult}
                  </StatusPill>
                  <StatusPill tone={toneForStatus(e.costResult)}>{e.costResult}</StatusPill>
                  <span className="ml-auto text-[11px] text-muted">
                    {relativeTime(e.createdAt.toISOString())}
                  </span>
                </div>
                <p className="mb-1.5 text-[13px] leading-relaxed text-ink/85">{e.reason}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                  <span>Task: {e.taskType.replace(/_/g, " ")}</span>
                  <span>Model: {e.selectedModel}</span>
                  <span>Risk: {e.riskLevel}</span>
                  <span>Depth: {e.verificationDepth}</span>
                  <span>Cost: {formatCost(e.actualCost)}</span>
                  <span>{e.latencyMs} ms</span>
                  {e.attempts > 1 && <span>{e.attempts} attempts</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
