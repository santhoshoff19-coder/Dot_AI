"use client";

import { Check, Gauge, Sparkles, Zap } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { modelRegistry } from "@/lib/models/registry";
import { MODEL_ROLE_LABEL, executionLabel, taskLabel } from "@/lib/ui/labels";
import { cn, formatCost } from "@/lib/utils";
import type { ModelOption, RoutingResult } from "@/lib/routing/route-types";

type Kind = "recommended" | "best" | "alternative";

const KIND_META: Record<Kind, { label: string; icon: React.ReactNode; tone: string }> = {
  recommended: { label: MODEL_ROLE_LABEL.RECOMMENDED, icon: <Check className="h-3 w-3" />, tone: "text-ok" },
  best: { label: MODEL_ROLE_LABEL.BEST, icon: <Sparkles className="h-3 w-3" />, tone: "text-accent-soft" },
  alternative: { label: MODEL_ROLE_LABEL.ALTERNATIVE, icon: <Zap className="h-3 w-3" />, tone: "text-info" },
};

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-ink/80">{value}</dd>
    </div>
  );
}

/**
 * Shown after routing completes and before generation starts, whenever Auto
 * mode is off. Nothing is generated until the user picks.
 */
function Step({ label }: { label: string }) {
  return (
    <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-ink">{label}</span>
  );
}

const Arrow = () => <span className="text-[10px] text-muted">→</span>;

export function ModelChooser({
  routing, capability, onChoose, onCancel,
}: {
  routing: RoutingResult;
  /** CAI's analysis, so the routing path can be shown alongside the cards. */
  capability?: import("@/lib/intelligence/curated-routing").RoutingDecision | null;
  onChoose: (modelId: string) => void;
  onCancel: () => void;
}) {
  const [custom, setCustom] = React.useState(false);
  const [detail, setDetail] = React.useState(false);

  const rows: { kind: Kind; option: ModelOption }[] = [
    { kind: "recommended", option: routing.options.recommendable },
    { kind: "best", option: routing.options.best },
    ...(routing.options.alternative
      ? [{ kind: "alternative" as Kind, option: routing.options.alternative }]
      : []),
  ];

  const shown = new Set(rows.map((r) => r.option.modelId));
  const others = routing.options.all.filter((o) => !shown.has(o.modelId));

  return (
    <div className="animate-fade-up rounded-2xl bg-surface hairline p-4">
      {/* What dotAI worked out, before what it picked. */}
      <div className="mb-3 border-b border-line pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Task
          </span>
          <span className="text-[13px] font-medium text-ink">
            {routing.subTaskLabel ?? taskLabel(routing.taskType)}
          </span>
          {(routing.riskLevel === "high" || routing.riskLevel === "critical") && (
            <StatusPill tone="warn">{routing.riskLevel} risk</StatusPill>
          )}
          <span className="ml-auto text-[11px] text-muted">
            {routing.qualifiedCount ?? routing.options.all.length} model(s) can do this
          </span>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
          {routing.rationale}
        </p>

        {/*
          The routing path, compactly. The user can see how a query became a
          shortlist: what CAI read it as, which atomic capabilities it needs,
          and how many models can do all of them.
        */}
        {capability && (
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]">
            <Step label={capability.analysis.input} />
            <Arrow />
            <Step label={capability.analysis.output} />
            <Arrow />
            <Step label={capability.analysis.subTaskName} />
            <Arrow />
            <span className="text-muted">
              needs{" "}
              <span className="text-ink">
                {capability.analysis.listANames.join(", ")}
              </span>
            </span>
            <Arrow />
            <span className="text-muted">
              <span className="text-ink">{capability.eligible.length}</span> eligible
            </span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {rows.map(({ kind, option }) => (
          <OptionRow
            key={option.modelId}
            kind={kind}
            option={option}
            onChoose={() => onChoose(option.modelId)}
          />
        ))}
      </div>

      {others.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setCustom((v) => !v)}
            className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline focus-ring"
          >
            {custom ? "Hide other models" : `Custom — ${others.length} other model${others.length === 1 ? "" : "s"}`}
          </button>
          {custom && (
            <div className="mt-2 space-y-2">
              {others.map((o) => (
                <OptionRow key={o.modelId} kind="alternative" option={o} custom
                  onChoose={() => onChoose(o.modelId)} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="text-[11px] text-muted">
          Nothing is generated until you choose.
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDetail((v) => !v)}
            className="text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline focus-ring"
          >
            {detail ? "Hide routing detail" : "How was this decided?"}
          </button>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </div>

      {/* Progressive disclosure: the routing internals stay available, but a
          reader who just wants to pick a model never has to read them. */}
      {detail && (
        <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-lg bg-elevated px-3 py-2.5 text-[11px] sm:grid-cols-2">
          <Detail label="Classified by"
            value={routing.caiUsed ? "Classifier model" : "Pattern match (no model called)"} />
          <Detail label="Reason"
            value={routing.caiSkippedReason ?? "Classification needed a model."} />
          <Detail label="Effort" value={routing.recommendedEffort} />
          <Detail label="Verification depth" value={routing.verificationDepth} />
          <Detail label="Routing cost" value={formatCost(routing.routingCostUsd ?? 0)} />
          <Detail label="Confidence"
            value={`${Math.round((routing.fastRouter?.confidence ?? routing.confidence) * 100)}%`} />
        </dl>
      )}
    </div>
  );
}

function OptionRow({
  kind, option, onChoose, custom,
}: {
  kind: Kind;
  option: ModelOption;
  onChoose: () => void;
  custom?: boolean;
}) {
  const meta = KIND_META[kind];
  const spec = modelRegistry.get(option.modelId);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-xl bg-elevated hairline px-3 py-2.5",
        kind === "recommended" && !custom && "border-ok/30",
      )}
    >
      <div className="min-w-0 flex-1">
        {/*
          The model's own name is the primary line. The role and trade-off sit
          above and below it: a card that leads with "Balanced" tells the user
          nothing about what will actually run.
        */}
        {!custom && (
          <span className={cn("flex items-center gap-1 text-[10px] font-bold tracking-wider", meta.tone)}>
            {meta.icon}
            {meta.label}
          </span>
        )}
        <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
          <span className="text-[15px] font-semibold text-ink">{option.name}</span>
          <span className="text-[10px] text-muted" title={option.modelId}>
            {option.modelId}
          </span>
          {option.executionStatus && (
            <span className="text-[10px] text-muted">
              {executionLabel(option.executionStatus)}
            </span>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          {option.whyThisModel ?? option.rationale}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div className="text-right">
          <p className="text-[13px] font-semibold text-ink">{formatCost(option.estimatedCost)}</p>
          <p className="text-[10px] text-muted">estimated</p>
        </div>
        <div className="text-right">
          <p className={cn(
            "text-[13px] font-semibold",
            option.fit === "high" ? "text-ok" : option.fit === "medium" ? "text-warn" : "text-muted",
          )}>
            {Math.round(option.expectedSuccess * 100)}%
          </p>
          <p className="text-[10px] text-muted">expected</p>
        </div>
        <div className="hidden text-right sm:block">
          <p className="flex items-center gap-1 text-[12px] text-muted">
            <Gauge className="h-3 w-3" />
            {spec?.latencyClass ?? option.latencyClass}
          </p>
          <p className="text-[10px] text-muted">{option.fit} fit</p>
        </div>
        <Button
          size="sm"
          variant={kind === "recommended" && !custom ? "default" : "secondary"}
          onClick={onChoose}
        >
          Use
        </Button>
      </div>
    </div>
  );
}
