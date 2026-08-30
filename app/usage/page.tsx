import { PageHeader } from "@/components/layout/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { prisma } from "@/lib/db";
import { learningService } from "@/lib/learning/service";
import { curatedDataset, modelById } from "@/lib/intelligence/curated-dataset";
import { isMockMode } from "@/lib/providers";
import { formatCost } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * The display name for a model id recorded on a control event.
 *
 * Events store the OpenRouter id; the curated dataset keys models by its own
 * id, so the lookup is by `openrouterId`. Falls back to the raw id, which is
 * still meaningful, rather than showing nothing.
 */
function curatedName(
  models: ReturnType<typeof modelById>, openrouterId: string,
): string {
  for (const m of models.values()) {
    if (m.openrouterId === openrouterId) return m.name;
  }
  return openrouterId;
}

export default async function UsagePage() {
  const events = await prisma.controlEvent.findMany({
    orderBy: { createdAt: "desc" }, take: 500,
  });
  const stats = await learningService.stats();
  const simulated = isMockMode();

  const requests = events.length;
  const totalCost = events.reduce((n, e) => n + e.actualCost, 0);

  /*
   * The counterfactual: what this traffic would have cost on one fixed
   * high-capability model.
   *
   * This used to read the seed model registry, which no longer holds any
   * models — the fixed Swift/Balanced/Deep entries were removed. Reducing an
   * empty array with no initial value threw, and because this is a server
   * component the whole page failed to render rather than degrading.
   *
   * Models now come from the curated dataset, which is the same source the
   * router prices against, so the comparison is consistent with the routing
   * the events actually took.
   */
  const dataset = curatedDataset();
  const models = modelById();

  const premium = dataset.intelligence
    .filter((i) => models.has(i.modelId))
    .reduce<{ name: string; inputCost: number; outputCost: number; intelligence: number } | null>(
      (best, i) => {
        const candidate = {
          name: models.get(i.modelId)!.name,
          inputCost: i.inputCost,
          outputCost: i.outputCost,
          intelligence: i.intelligence,
        };
        return !best || candidate.intelligence > best.intelligence ? candidate : best;
      }, null);

  const counterfactual = premium
    ? events.reduce((n, e) =>
        n + (e.inputTokens / 1e6) * premium.inputCost
          + (e.outputTokens / 1e6) * premium.outputCost, 0)
    : 0;
  const savings = Math.max(0, counterfactual - totalCost);

  const byModel = new Map<string, { requests: number; cost: number }>();
  for (const e of events) {
    const row = byModel.get(e.selectedModel) ?? { requests: 0, cost: 0 };
    row.requests++; row.cost += e.actualCost;
    byModel.set(e.selectedModel, row);
  }

  const decisions = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.decision] = (acc[e.decision] ?? 0) + 1; return acc;
  }, {});

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Usage" subtitle="Spend, routing and control outcomes." />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mx-auto max-w-4xl space-y-6">
          {simulated && (
            <div className="rounded-xl border border-warn/25 bg-warn/5 px-4 py-3">
              <p className="text-[13px] font-medium text-warn">Simulated data (MOCK_MODE)</p>
              <p className="mt-0.5 text-[12px] text-muted">
                These figures come from the offline mock provider. They are not real
                spend and do not represent real savings.
              </p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Requests" value={String(requests)} />
            <Stat label="Total cost" value={formatCost(totalCost)} />
            <Stat
              label="Average / request"
              value={formatCost(requests ? totalCost / requests : 0)}
            />
            <Stat
              label={simulated ? "Estimated savings (simulated)" : "Estimated savings"}
              value={formatCost(savings)}
              hint={premium
                ? `vs routing everything to ${premium.name}`
                : "no rated model to compare against"}
            />
          </div>

          <section>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
              Model usage
            </h2>
            {byModel.size === 0 ? (
              <p className="text-[13px] text-muted">No requests yet.</p>
            ) : (
              <div className="space-y-1.5">
                {[...byModel.entries()].map(([modelId, row]) => {
                  const pct = requests ? (row.requests / requests) * 100 : 0;
                  return (
                    <div key={modelId} className="rounded-xl bg-surface hairline p-3">
                      <div className="mb-1.5 flex items-baseline justify-between gap-3">
                        <span className="text-[13px] text-ink">
                          {curatedName(models, modelId)}
                          <span className="ml-1.5 text-[11px] text-muted">{modelId}</span>
                        </span>
                        <span className="text-[12px] text-muted">
                          {row.requests} · {formatCost(row.cost)}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
              Decisions
            </h2>
            <div className="flex flex-wrap gap-2">
              {Object.keys(decisions).length === 0 && (
                <p className="text-[13px] text-muted">No decisions yet.</p>
              )}
              {Object.entries(decisions).map(([d, n]) => (
                <div key={d} className="rounded-xl bg-surface hairline px-3 py-2">
                  <p className="text-[11px] text-muted">{d}</p>
                  <p className="text-[16px] font-semibold text-ink">{n}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
              Learning signal
            </h2>
            <p className="mb-2 text-[12px] text-muted">
              Observed outcomes per model. Routing is only adjusted once a model
              has at least {learningService.minSampleSize} recorded runs.
            </p>
            {stats.length === 0 ? (
              <p className="text-[13px] text-muted">No recorded outcomes yet.</p>
            ) : (
              <div className="space-y-1.5">
                {stats.map((s) => (
                  <div key={s.modelId} className="flex flex-wrap items-center gap-2 rounded-xl bg-surface hairline px-3 py-2.5">
                    <span className="text-[13px] text-ink">
                      {curatedName(models, s.modelId)}
                    </span>
                    <span className="text-[11px] text-muted">{s.runs} run(s)</span>
                    {s.runs >= learningService.minSampleSize ? (
                      <StatusPill tone={s.reliability > 0.8 ? "ok" : "warn"}>
                        {(s.reliability * 100).toFixed(0)}% clean
                      </StatusPill>
                    ) : (
                      <StatusPill tone="neutral">below sample size</StatusPill>
                    )}
                    <span className="ml-auto text-[11px] text-muted">
                      avg {formatCost(s.avgCost)} · {s.avgLatencyMs.toFixed(0)} ms
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-surface hairline p-3.5">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-1 text-[20px] font-semibold tracking-tight text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted/70">{hint}</p>}
    </div>
  );
}
