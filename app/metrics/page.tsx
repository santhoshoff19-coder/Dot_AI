"use client";

import { Activity, Loader2, RefreshCw } from "lucide-react";
import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { StatusPill, type Tone } from "@/components/ui/status-pill";
import { cn, formatCost } from "@/lib/utils";

interface ProfileMetrics {
  profileId: string;
  profileName: string;
  interactions: number;
  interventionRate: number;
  escalationRate: number;
  blockRate: number;
  verificationCoverage: number;
  p50CheckerLatencyMs: number | null;
  p95CheckerLatencyMs: number | null;
  byDecision: Record<string, number>;
  cost: {
    generation: number; cai: number; rag: number; verification: number;
    retry: number; total: number; controlPlaneOverhead: number;
    avgTotalPerRequest: number; avgCheckerPerRequest: number;
    estimateDrift: number | null;
  };
  labelledCount: number;
  truePositives: number | null;
  falsePositives: number | null;
  trueNegatives: number | null;
  falseNegatives: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  riskEscapeRate: number | null;
  groundTruthNote: string;
  feedback: Record<string, number>;
  disputedFeedback: number;
}

interface ModelHealth {
  modelId: string;
  name: string;
  runs: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  avgCostUsd: number | null;
  executionAttempts: number;
  executionSuccessRate: number | null;
  executionFailures: { reason: string; count: number }[];
  lastSuccessfulExecution: string | null;
  responsibilityFailures: number;
  performanceFailures: number;
  verifierAgreementRate: number | null;
  sufficientEvidence: boolean;
  note: string;
}

interface Dashboard {
  profiles: ProfileMetrics[];
  modelHealth: ModelHealth[];
  thresholds: { minLabelled: number; minHealthRuns: number };
  notice: string;
}

const DECISIONS = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"] as const;

const DECISION_TONE: Record<string, Tone> = {
  ALLOW: "ok", ANNOTATE: "info", REGENERATE: "warn",
  HOLD: "warn", BLOCK: "danger",
};

const UNAVAILABLE = "NOT ENOUGH GROUND TRUTH";

export default function MetricsPage() {
  const [data, setData] = React.useState<Dashboard | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard");
      if (res.ok) setData((await res.json()) as Dashboard);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const profiles = data?.profiles ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Checker metrics"
        subtitle="How each use case is behaving, what it caught, and what it cost."
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mx-auto max-w-6xl space-y-6">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
            {data && (
              <span className="text-[11px] text-muted">
                FP/FN need {data.thresholds.minLabelled} labelled decisions;
                model health needs {data.thresholds.minHealthRuns} runs.
              </span>
            )}
          </div>

          {data?.notice && (
            <div className="rounded-xl border border-warn/25 bg-warn/5 px-4 py-3">
              <p className="text-[12px] leading-relaxed text-warn">{data.notice}</p>
            </div>
          )}

          {/* per-profile comparison */}
          <section>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">
              By use case
            </h2>

            {profiles.length === 0 && !loading && (
              <p className="text-[13px] text-muted">No checker runs recorded yet.</p>
            )}

            <div className="grid gap-3 lg:grid-cols-3">
              {profiles.map((p) => (
                <div key={p.profileId} className="rounded-xl bg-surface hairline p-4">
                  <div className="mb-3">
                    <p className="text-[13px] font-medium text-ink">{p.profileName}</p>
                    <p className="text-[11px] text-muted">{p.interactions} requests</p>
                  </div>

                  {/* decisions */}
                  <div className="mb-3 flex flex-wrap gap-1">
                    {DECISIONS.map((d) => (
                      <StatusPill key={d} tone={DECISION_TONE[d]}>
                        {d} {p.byDecision[d] ?? 0}
                      </StatusPill>
                    ))}
                  </div>

                  <Row label="Intervention" value={pct(p.interventionRate)} />
                  <Row label="Escalation" value={pct(p.escalationRate)} />
                  <Row label="Coverage" value={pct(p.verificationCoverage)} />
                  <Row label="P50 latency" value={ms(p.p50CheckerLatencyMs)} />
                  <Row label="P95 latency" value={ms(p.p95CheckerLatencyMs)} />

                  <div className="mt-3 border-t border-line pt-2">
                    <p className="mb-1 text-[10px] uppercase tracking-wider text-muted">Cost</p>
                    <Row label="Generation" value={formatCost(p.cost.generation)} />
                    <Row label="CAI / routing" value={formatCost(p.cost.cai)} />
                    <Row label="RAG / embedding" value={formatCost(p.cost.rag)} />
                    <Row label="Verification" value={formatCost(p.cost.verification)} />
                    <Row label="Retry" value={formatCost(p.cost.retry)} />
                    <Row label="ControlPlane added" value={formatCost(p.cost.controlPlaneOverhead)} strong />
                    <Row label="Total" value={formatCost(p.cost.total)} strong />
                    <Row label="Avg / request" value={formatCost(p.cost.avgTotalPerRequest)} />
                  </div>

                  <div className="mt-3 border-t border-line pt-2">
                    <p className="mb-1 text-[10px] uppercase tracking-wider text-muted">
                      Accuracy
                    </p>
                    {p.falsePositiveRate === null ? (
                      <div>
                        <StatusPill tone="neutral">{UNAVAILABLE}</StatusPill>
                        <p className="mt-1 text-[11px] leading-relaxed text-muted/80">
                          {p.groundTruthNote}
                        </p>
                      </div>
                    ) : (
                      <>
                        <Row label="TP / TN" value={`${p.truePositives} / ${p.trueNegatives}`} />
                        <Row label="FP / FN" value={`${p.falsePositives} / ${p.falseNegatives}`} />
                        <Row label="FPR" value={pct(p.falsePositiveRate)} />
                        <Row label="FNR" value={pct(p.falseNegativeRate)} />
                        <Row label="Escape rate" value={pct(p.riskEscapeRate)} />
                      </>
                    )}
                  </div>

                  {Object.keys(p.feedback).length > 0 && (
                    <div className="mt-3 border-t border-line pt-2">
                      <p className="mb-1 text-[10px] uppercase tracking-wider text-muted">
                        Human feedback
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(p.feedback).map(([v, n]) => (
                          <StatusPill key={v} tone="neutral">{v} {n}</StatusPill>
                        ))}
                        {p.disputedFeedback > 0 && (
                          <StatusPill tone="warn">{p.disputedFeedback} disputed</StatusPill>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* model health */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted">
              <Activity className="h-3.5 w-3.5" /> Model health
            </h2>

            {(data?.modelHealth.length ?? 0) === 0 ? (
              <p className="text-[13px] text-muted">No model activity recorded yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl bg-surface hairline">
                <table className="w-full min-w-[820px] text-left">
                  <thead>
                    <tr className="border-b border-line text-[10px] uppercase tracking-wider text-muted">
                      <Th>Model</Th><Th>Runs</Th><Th>Success</Th><Th>Exec</Th>
                      <Th>Latency</Th><Th>Avg cost</Th><Th>Resp. fails</Th>
                      <Th>Perf. fails</Th><Th>Last success</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.modelHealth.map((m) => (
                      <tr key={m.modelId} className="border-b border-line/60 last:border-0">
                        <td className="px-3 py-2.5">
                          <p className="text-[13px] text-ink">{m.name}</p>
                          <p className="text-[11px] text-muted">{m.modelId}</p>
                        </td>
                        <Td>{m.runs}</Td>
                        <Td>
                          {m.successRate === null
                            ? <span title={m.note} className="text-muted/60">n/a</span>
                            : pct(m.successRate)}
                        </Td>
                        <Td>
                          {m.executionAttempts === 0
                            ? <span className="text-muted/60">unproven</span>
                            : `${pct(m.executionSuccessRate)} of ${m.executionAttempts}`}
                        </Td>
                        <Td>{ms(m.avgLatencyMs)}</Td>
                        <Td>{m.avgCostUsd === null ? "—" : formatCost(m.avgCostUsd)}</Td>
                        <Td>{m.responsibilityFailures}</Td>
                        <Td>{m.performanceFailures}</Td>
                        <Td>
                          {m.lastSuccessfulExecution
                            ? new Date(m.lastSuccessfulExecution).toLocaleString()
                            : "never"}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function ms(v: number | null): string {
  return v === null ? "—" : `${v} ms`;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className={cn("text-[12px]", strong ? "font-semibold text-ink" : "text-ink/80")}>
        {value}
      </span>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2.5 text-[12px] text-muted">{children}</td>;
}
