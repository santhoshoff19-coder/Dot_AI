"use client";

import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { StatusPill, type Tone } from "@/components/ui/status-pill";
import { CuratedView } from "@/components/models/curated-view";
import { taskLabel } from "@/lib/intelligence/taxonomy";
import { cn, formatCost } from "@/lib/utils";

interface ModelRow {
  openrouterModelId: string;
  name: string;
  provider: string;
  active: boolean;
  contextLength: number;
  inputPrice: number;
  outputPrice: number;
  latencyClass: string;
  categories: string[];
  inputModalities: string[];
  outputModalities: string[];
  status: string;
  unassessedReason: string | null;
  capabilityConfidence: number;
  capability: {
    effort: string; reasoning: string; contextHandling: string;
    instructionComplexity: string; reliability: string; toolCapability: string;
  } | null;
  execution: { modality: string; status: string; attempts: number; successes: number }[];
}

interface PageData {
  models: ModelRow[]; total: number; page: number; pages: number; providers: string[];
}

interface SyncStatus {
  lastSuccessfulSync: { createdAt: string; fetched: number } | null;
  totals: {
    total: number; active: number; inactive: number; assessed: number;
    assessmentPending: number; assessmentFailed: number; unassessed: number;
  };
  byCategory: Record<string, number>;
  execution: Record<string, number>;
}

const CATEGORIES = ["ALL", "TEXT", "IMAGE", "VIDEO", "AUDIO", "SPEECH",
  "TRANSCRIPTION", "EMBEDDINGS", "RERANK"];
const MODALITIES = ["ALL", "TEXT", "IMAGE", "AUDIO", "VIDEO", "FILE", "EMBEDDING"];
const ASSESSMENTS = ["ALL", "ASSESSED", "ASSESSMENT_PENDING", "ASSESSMENT_FAILED", "UNASSESSED"];
const EXECUTIONS = ["ALL", "EXECUTION_VERIFIED", "METADATA_COMPATIBLE",
  "UNAVAILABLE", "TEMPORARILY_UNAVAILABLE", "UNSUPPORTED", "FAILED", "UNCHECKED"];
const SORT_LABELS: Record<string, string> = {
  inputCost: "Input cost \u2191", inputCostDesc: "Input cost \u2193",
  outputCost: "Output cost \u2191", contextLength: "Context \u2193",
  name: "Name", provider: "Provider", newest: "Newest",
};

const LEVEL_TONE: Record<string, Tone> = {
  HIGH: "ok", MEDIUM: "warn", LOW: "neutral",
  ADVANCED: "ok", BASIC: "warn", NONE: "neutral",
};

const EXEC_TONE: Record<string, Tone> = {
  EXECUTION_VERIFIED: "ok", METADATA_COMPATIBLE: "warn", TEMPORARILY_UNAVAILABLE: "warn",
  UNAVAILABLE: "danger", FAILED: "danger", UNSUPPORTED: "neutral", UNKNOWN: "neutral",
};

const STATUS_TONE: Record<string, Tone> = {
  ASSESSED: "ok", ASSESSMENT_PENDING: "warn",
  ASSESSMENT_FAILED: "danger", UNASSESSED: "neutral",
};

interface Champion {
  taskType: string; championType: string; modelId: string; name: string;
  provider: string; inputPrice: number; pricingKnown: boolean;
  latencyClass: string; score: number; confidence: string; reason: string;
}

interface Intelligence {
  totals: { total: number; active: number; assessed: number; execVerified: number; execFailed: number };
  champions: Champion[];
  pools: Record<string, number>;
  tasks: string[];
  lastRecalculated: string | null;
  notice: string;
}

const CHAMPION_LABEL: Record<string, string> = {
  QUALITY: "Best quality", VALUE: "Best value", SPEED: "Fastest",
  RELIABILITY: "Most reliable", DEFAULT: "Best overall",
};

function IntelligenceView() {
  const [intel, setIntel] = React.useState<Intelligence | null>(null);

  React.useEffect(() => {
    void (async () => {
      const res = await fetch("/api/intelligence");
      if (res.ok) setIntel((await res.json()) as Intelligence);
    })();
  }, []);

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-surface hairline p-4">
        <p className="text-[14px] font-medium text-ink">
          Which model should dotAI use for this task?
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          Pick an input, an output and a task. Every model that can perform
          that exact combination is listed, cheapest first, with its input
          cost, output cost and how well it performs that specific task — so a
          cheap model that is good enough is easy to find.
        </p>
      </div>

      {/* Input → Output → Task is the primary view. */}
      <CuratedView />


    </div>
  );
}

export default function ModelIntelligencePage() {
  const [level, setLevel] = React.useState<"INTELLIGENCE" | "CATALOG">("INTELLIGENCE");
  const [data, setData] = React.useState<PageData | null>(null);
  const [status, setStatus] = React.useState<SyncStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [syncing, setSyncing] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const [q, setQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [category, setCategory] = React.useState("ALL");
  const [outputModality, setOutputModality] = React.useState("ALL");
  const [assessment, setAssessment] = React.useState("ALL");
  const [activity, setActivity] = React.useState("ACTIVE");
  const [provider, setProvider] = React.useState("ALL");
  const [execution, setExecution] = React.useState("ALL");
  const [sort, setSort] = React.useState("inputCost");
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(q); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page), pageSize: "25", q: debouncedQ,
        category, outputModality, assessment, activity, sort, provider, execution,
      });
      const [res, st] = await Promise.all([
        fetch(`/api/models?${params}`),
        fetch("/api/models/sync/status"),
      ]);
      if (res.ok) setData((await res.json()) as PageData);
      if (st.ok) setStatus((await st.json()) as SyncStatus);
    } catch {
      setMessage("Could not load the catalog.");
    } finally {
      setLoading(false);
    }
  }, [page, debouncedQ, category, outputModality, assessment, activity, sort, provider, execution]);

  React.useEffect(() => { void load(); }, [load]);

  const sync = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/models/sync", { method: "POST" });
      const r = (await res.json()) as {
        status: string; fetched: number; created: number; updated: number;
        deactivated: number; assessed?: number; error?: string;
        bySource?: Record<string, number | string>;
      };
      setMessage(
        r.status === "FAILED"
          ? `Sync failed: ${r.error ?? "unknown"}. The existing catalog is unchanged and routing is unaffected.`
          : `${r.status}: ${r.fetched} models across catalogs \u2014 ${r.created} new, ${r.updated} updated, ${r.deactivated} deactivated, ${r.assessed ?? 0} assessed.  ${
              r.bySource ? Object.entries(r.bySource).map(([k, v]) => `${k}:${v}`).join("  ") : ""}`,
      );
      await load();
    } catch (err) {
      setMessage(`Sync failed: ${String(err)}. Routing is unaffected.`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Model Intelligence"
        subtitle="Curated model intelligence: which models can perform a task, what they cost, and how well."
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-4">
          <IntelligenceView />
        </div>
      </div>
    </div>
  );
}

function Select({
  label, value, options, labels, onChange,
}: {
  label: string; value: string; options: string[];
  labels?: Record<string, string>; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 rounded-lg bg-surface hairline px-2.5 py-1.5">
      <span className="text-[11px] text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-[12px] text-ink outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-surface text-ink">
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-semibold">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2.5 text-[12px] text-muted">{children}</td>;
}

function Lvl({ v }: { v?: string }) {
  return (
    <td className="px-3 py-2.5">
      {v ? <StatusPill tone={LEVEL_TONE[v] ?? "neutral"}>{v.slice(0, 4)}</StatusPill>
        : <span className="text-[12px] text-muted/50">—</span>}
    </td>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="rounded-xl bg-surface hairline p-3">
      <p className="text-[11px] text-muted">{label}</p>
      <p className={cn(
        "mt-0.5 text-[18px] font-semibold tracking-tight",
        tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn"
        : tone === "danger" ? "text-danger" : "text-ink",
      )}>
        {value}
      </p>
    </div>
  );
}
