"use client";

import {
  ArrowRight, Check, Cpu, DollarSign, Gavel, ShieldCheck, X,
} from "lucide-react";
import { StatusPill, toneForDecision, toneForStatus } from "@/components/ui/status-pill";
import { Button } from "@/components/ui/button";
import { cn, formatCost } from "@/lib/utils";
import type { ControlEventData, ResponsibilityCategory } from "@/types";

const CATEGORY_LABEL: Record<ResponsibilityCategory, string> = {
  privacy: "Privacy", safety: "Safety", fairness: "Fairness",
  policy: "Policy", security: "Security",
};

export function ControlPanel({
  event, onClose, embedded,
}: {
  event: ControlEventData;
  onClose?: () => void;
  embedded?: boolean;
}) {
  return (
    <div className={cn("flex h-full flex-col", embedded && "border-l border-line")}>
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">Control Details</h2>
          <p className="text-[11px] text-muted">
            {event.mock ? "Simulated run (MOCK_MODE)" : "Live run"} · {event.latencyMs} ms
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={toneForDecision(event.decision.decision)}>
            {event.decision.decision}
          </StatusPill>
          {onClose && (
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close control details">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* DECISION -------------------------------------------------------- */}
        <Section icon={<Gavel className="h-3.5 w-3.5" />} title="Decision">
          <p className="text-[13px] leading-relaxed text-ink/90">{event.decision.reason}</p>
          {event.decision.annotations.length > 0 && (
            <ul className="mt-2 space-y-1">
              {event.decision.annotations.map((a, i) => (
                <li key={i} className="text-[12px] text-muted">— {a}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusPill tone="neutral">Risk: {event.riskLevel}</StatusPill>
            <StatusPill tone="neutral">Verification: {event.verificationDepth}</StatusPill>
            {event.attempts > 1 && <StatusPill tone="warn">{event.attempts} attempts</StatusPill>}
          </div>
        </Section>

        {/* GOVERNANCE ------------------------------------------------------ */}
        {event.profileId && (
          <Section icon={<ShieldCheck className="h-3.5 w-3.5" />} title="Governance">
            <div className="mb-2 flex flex-wrap gap-1.5">
              <StatusPill tone="accent">{event.profileName ?? event.profileId}</StatusPill>
              {event.sessionRisk && (
                <StatusPill tone={
                  event.sessionRisk.level === "HIGH" ? "danger"
                  : event.sessionRisk.level === "MEDIUM" ? "warn" : "ok"}>
                  Session risk {event.sessionRisk.level}
                </StatusPill>
              )}
              {(event.riskCategories ?? []).map((c) => (
                <StatusPill key={c} tone="neutral">{c}</StatusPill>
              ))}
            </div>

            {event.verificationDepthReason && (
              <Row label="Verification depth" value={`${event.verificationDepth} — ${event.verificationDepthReason}`} />
            )}
            {typeof event.checkerLatencyMs === "number" && (
              <Row label="Checker latency" value={`${event.checkerLatencyMs} ms`} />
            )}
            {event.sessionRisk && (
              <Row
                label="Accumulated"
                value={`${event.sessionRisk.contradictions} contradiction(s), ${event.sessionRisk.unverifiedClaims} unverified, ${event.sessionRisk.highRiskActions} action(s) over ${event.sessionRisk.turns} turn(s)`}
              />
            )}

            {/*
              Risk → decision → confidence → reason → policy.

              Stated in that order and in one place, because a decision the
              user cannot trace is one they can only accept or ignore.
            */}
            {event.workflow && (
              <div className="mt-2 rounded-lg bg-canvas hairline p-2.5">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {event.workflow.profileName} workflow
                </p>
                <p className="mb-1.5 text-[11px] leading-relaxed text-muted">
                  {event.workflow.summary}
                </p>
                <div className="flex flex-wrap items-center gap-1">
                  {event.workflow.stages.map((stage, i) => (
                    <span key={stage} className="flex items-center gap-1">
                      <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-ink">
                        {stage.replace(/_/g, " ").toLowerCase()}
                      </span>
                      {i < event.workflow!.stages.length - 1 && (
                        <span className="text-[10px] text-muted">→</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {event.firewall && event.firewall.detected.length > 0 && (
              <div className="mt-2 rounded-lg bg-canvas hairline p-2.5">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Privacy firewall — before the request was sent
                </p>
                <dl className="space-y-1 text-[12px]">
                  <Row
                    label="Risk detected"
                    value={event.firewall.detected
                      .map((d) => `${d.cls.replace(/_/g, " ")}${d.count > 1 ? ` ×${d.count}` : ""}${d.critical ? " (critical)" : ""}`)
                      .join(", ")}
                  />
                  <Row label="Decision" value={event.firewall.decision} />
                  <Row
                    label="Confidence"
                    value={`${Math.round(event.firewall.confidence * 100)}% — from the weakest matching pattern`}
                  />
                  <Row label="Reason" value={event.firewall.reason} />
                  <Row label="Policy" value={event.firewall.policyBasis} />
                  {event.firewall.redactedClasses.length > 0 && (
                    <Row
                      label="Masked before sending"
                      value={event.firewall.redactedClasses.join(", ")}
                    />
                  )}
                </dl>
              </div>
            )}

            {(event.intersectionsApplied ?? []).length > 0 && (
              <p className="mt-2 rounded-lg border border-warn/25 bg-warn/5 px-2.5 py-2 text-[12px] text-warn">
                Overlapping risk raised the intervention: {(event.intersectionsApplied ?? []).join(", ")}
              </p>
            )}

            {(event.decisionTrace ?? []).length > 0 && (
              <ol className="mt-2 space-y-1">
                {(event.decisionTrace ?? []).map((t, i) => (
                  <li key={i} className="rounded-lg bg-elevated p-2">
                    <p className="text-[11px] font-medium text-accent-soft">
                      {t.rule} → {t.raisedTo}
                    </p>
                    <p className="text-[12px] leading-relaxed text-muted">{t.detail}</p>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        )}

        {/* MODEL ----------------------------------------------------------- */}
        <Section icon={<Cpu className="h-3.5 w-3.5" />} title="Routing">
          <div className="mb-2 flex flex-wrap gap-1.5">
            <StatusPill tone={event.caiUsed ? "accent" : "ok"}>
              {event.caiUsed ? "CAI used" : "CAI skipped"}
            </StatusPill>
            {event.routeSource && (
              <StatusPill tone="neutral">{event.routeSource.replace(/_/g, " ")}</StatusPill>
            )}
            {typeof event.fastRouterConfidence === "number" && (
              <StatusPill tone="neutral">
                Fast Router {Math.round(event.fastRouterConfidence * 100)}%
              </StatusPill>
            )}
          </div>
          {event.caiSkippedReason && (
            <p className="mb-2 text-[12px] leading-relaxed text-muted">{event.caiSkippedReason}</p>
          )}
          <Row label="Routing cost" value={formatCost(event.routingCostUsd ?? 0)} />
          {event.modelOptions && (
            <div className="mt-2 space-y-1">
              {[
                ["Recommended", event.modelOptions.recommendable],
                ["Best", event.modelOptions.best],
                ["Alternative", event.modelOptions.alternative],
              ].map(([label, opt]) =>
                opt && typeof opt !== "string" ? (
                  <div key={label as string} className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="text-muted">{label as string}</span>
                    <span className="truncate text-right text-ink/80">
                      {opt.name} · {formatCost(opt.estimatedCost)} · {Math.round(opt.expectedSuccess * 100)}%
                    </span>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </Section>

        <Section icon={<Cpu className="h-3.5 w-3.5" />} title="Model">
          <Row label="Recommended" value={event.recommendedModel} />
          <Row label="Selected" value={event.selectedModel} />
          <Row label="Provider" value={event.provider} />
          <Row label="Effort" value={event.effort} />
          <Row label="Task" value={event.taskClassification.replace(/_/g, " ")} />
          <p className="mt-2 rounded-lg bg-elevated px-2.5 py-2 text-[12px] leading-relaxed text-muted">
            {event.rationale}
          </p>
        </Section>

        {/* COST ------------------------------------------------------------ */}
        <Section icon={<DollarSign className="h-3.5 w-3.5" />} title="Cost">
          <div className="mb-2 flex items-center gap-2">
            <StatusPill tone={toneForStatus(event.cost.status)}>{event.cost.status}</StatusPill>
          </div>
          <Row label="Estimated" value={formatCost(event.cost.estimatedCost)} />
          <Row label="Actual" value={formatCost(event.cost.actualCost)} />
          <Row label="Input tokens" value={String(event.cost.inputTokens)} />
          <Row label="Output tokens" value={String(event.cost.outputTokens)} />
          {event.cost.reasoningTokens > 0 && (
            <Row label="Reasoning tokens" value={String(event.cost.reasoningTokens)} />
          )}
          <Row label="Cost per successful task" value={formatCost(event.cost.costPerSuccessfulTask)} />
          {event.cost.notes.map((n, i) => (
            <p key={i} className="mt-1.5 text-[12px] text-muted">— {n}</p>
          ))}
        </Section>

        {/* PERFORMANCE ------------------------------------------------------ */}
        <Section icon={<Check className="h-3.5 w-3.5" />} title="Performance">
          <div className="mb-2 flex items-center gap-2">
            <StatusPill tone={toneForStatus(event.verification.status)}>
              {event.verification.status}
            </StatusPill>
            <span className="text-[11px] text-muted">
              {event.verification.claimsChecked} claim(s) checked
            </span>
            {event.verification.earlyExit && <StatusPill tone="accent">early exit</StatusPill>}
          </div>

          {event.verification.note && (
            <p className="mb-2 text-[12px] text-muted">{event.verification.note}</p>
          )}

          <div className="space-y-2">
            {event.verification.verdicts.map((v, i) => (
              <div key={i} className="rounded-lg bg-elevated p-2.5">
                <div className="mb-1 flex items-start gap-2">
                  <StatusPill tone={toneForStatus(v.status)}>{v.status}</StatusPill>
                </div>
                <p className="text-[12px] leading-relaxed text-ink/80">{v.claim}</p>
                <p className="mt-1 text-[11px] text-muted">{v.detail}</p>
                {v.evidence && (
                  <div className="mt-2 border-l-2 border-accent/40 pl-2">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-accent-soft">
                      {v.evidence.source}
                    </p>
                    <p className="text-[11px] leading-relaxed text-muted">{v.evidence.text}</p>
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="mt-2 text-[11px] text-muted/70">
            Checks run: {event.verification.checksRun.join(" → ")}
          </p>
        </Section>

        {/* RESPONSIBILITY --------------------------------------------------- */}
        <Section icon={<ShieldCheck className="h-3.5 w-3.5" />} title="Responsibility">
          <div className="mb-2">
            <StatusPill tone={toneForStatus(event.responsibility.status)}>
              {event.responsibility.status}
            </StatusPill>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-1.5">
            {(Object.keys(CATEGORY_LABEL) as ResponsibilityCategory[]).map((c) => {
              const state = event.responsibility.categories[c];
              return (
                <div key={c} className="flex items-center gap-1.5 text-[12px]">
                  <span className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    state === "clear" ? "bg-ok" : state === "flagged" ? "bg-danger" : "bg-muted",
                  )} />
                  <span className="text-muted">{CATEGORY_LABEL[c]}</span>
                  <span className={cn(
                    "ml-auto text-[11px]",
                    state === "flagged" ? "text-danger" : "text-muted/70",
                  )}>
                    {state === "not_run" ? "not run" : state}
                  </span>
                </div>
              );
            })}
          </div>

          {event.responsibility.findings.map((f, i) => (
            <div key={i} className="mt-1.5 rounded-lg bg-elevated p-2.5">
              <div className="mb-1 flex items-center gap-2">
                <StatusPill tone={f.severity === "critical" || f.severity === "high" ? "danger" : "warn"}>
                  {CATEGORY_LABEL[f.category]} · {f.severity}
                </StatusPill>
                {f.deterministic && <span className="text-[10px] text-muted">deterministic</span>}
              </div>
              <p className="text-[12px] leading-relaxed text-ink/80">{f.message}</p>
              {f.evidence && (
                <p className="mt-1 font-mono text-[11px] text-muted">{f.evidence}</p>
              )}
            </div>
          ))}
        </Section>

        {/* ACTION GATE ------------------------------------------------------ */}
        {event.actionGate && (
          <Section icon={<ArrowRight className="h-3.5 w-3.5" />} title="Action Gate">
            <div className="mb-2 flex items-center gap-2">
              <StatusPill tone={toneForDecision(event.actionGate.decision)}>
                {event.actionGate.decision}
              </StatusPill>
              <span className="text-[11px] text-muted">settled at {event.actionGate.stage}</span>
            </div>
            <p className="mb-2 text-[12px] leading-relaxed text-ink/80">{event.actionGate.reason}</p>
            <ol className="space-y-1">
              {event.actionGate.checks.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-[12px]">
                  <span className={cn(
                    "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold",
                    c.passed ? "bg-ok/20 text-ok" : "bg-danger/20 text-danger",
                  )}>
                    {c.passed ? "✓" : "✕"}
                  </span>
                  <span>
                    <span className="text-ink/80">{c.label}</span>
                    <span className="ml-1 text-muted">— {c.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({
  icon, title, children,
}: {
  icon: React.ReactNode; title: string; children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="truncate text-right text-[12px] font-medium text-ink/90">{value}</span>
    </div>
  );
}
