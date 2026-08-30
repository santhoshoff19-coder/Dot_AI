"use client";

import { Loader2 } from "lucide-react";
import * as React from "react";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";

/**
 * Model Intelligence, read from the curated dataset.
 *
 * The live OpenRouter catalogue is not consulted here. Everything shown —
 * which models exist, what they cost, how well they perform a sub-task and
 * which mini-tasks they are verified for — comes from the static workbook, so
 * the set a user sees is stable and auditable rather than shifting between
 * page loads.
 */

interface Option { id: string; label: string }

interface Row {
  modelId: string;
  name: string;
  company: string;
  openrouterId: string;
  trusted: boolean;
  inputCost: number;
  outputCost: number;
  intelligence: number;
  blendedCost: number;
  verifiedCount: number;
  tradeoff: string;
}

interface Payload {
  inputs: Option[];
  outputsByInput: Record<string, Option[]>;
  subTasksByPair: Record<string, Option[]>;
  rows: Row[];
  meta: { workbook: string; built: string; evaluator: string; corrections?: string[] };
  notice: string;
}

const money = (n: number) =>
  n === 0 ? "Free"
  : n < 0.001 ? `$${n.toFixed(6).replace(/0+$/, "")}`
  : n < 1 ? `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`
  : `$${n.toFixed(2)}`;

const tone = (n: number) =>
  n >= 85 ? "text-ok" : n >= 70 ? "text-ink" : n >= 50 ? "text-warn" : "text-muted";

export function CuratedView() {
  const [data, setData] = React.useState<Payload | null>(null);
  const [input, setInput] = React.useState("Text");
  const [output, setOutput] = React.useState("Text");
  const [subTask, setSubTask] = React.useState("ST01");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const outputs = React.useMemo(
    () => data?.outputsByInput[input] ?? [], [data, input]);
  const subTasks = React.useMemo(
    () => data?.subTasksByPair[`${input}>${output}`] ?? [], [data, input, output]);

  // Each dropdown constrains the next, so the three together always describe
  // a combination the taxonomy actually defines.
  React.useEffect(() => {
    if (outputs.length && !outputs.some((o) => o.id === output)) setOutput(outputs[0].id);
  }, [outputs, output]);

  React.useEffect(() => {
    if (subTasks.length && !subTasks.some((s) => s.id === subTask)) setSubTask(subTasks[0].id);
  }, [subTasks, subTask]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const params = new URLSearchParams({ input, output, subTask });
        const res = await fetch(`/api/intelligence/curated?${params}`);
        if (!res.ok) throw new Error("Could not load model intelligence.");
        const body = (await res.json()) as Payload;
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Load failed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [input, output, subTask]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-xl bg-surface hairline p-3.5">
        <Picker label="Input" value={input} options={data?.inputs ?? []} onChange={setInput} />
        <Picker label="Output" value={output} options={outputs} onChange={setOutput} />
        <Picker label="Task" value={subTask} options={subTasks} onChange={setSubTask} />
        {data && (
          <span className="ml-auto text-[11px] text-muted">
            {data.meta.workbook} · built {data.meta.built}
          </span>
        )}
      </div>

      {loading && (
        <p className="flex items-center gap-1.5 rounded-xl bg-surface hairline p-4 text-[13px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading the curated model set…
        </p>
      )}

      {error && !loading && (
        <div className="rounded-xl border border-danger/25 bg-danger/5 p-4">
          <p className="text-[13px] text-danger">{error}</p>
        </div>
      )}

      {!loading && data && (
        <div className="rounded-xl bg-surface hairline">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
            <span className="text-[12px] font-medium text-ink">
              {data.rows.length} rated model{data.rows.length === 1 ? "" : "s"}
            </span>
            <span className="text-[11px] text-muted">{data.notice}</span>
          </div>

          {data.rows.length === 0 ? (
            <p className="p-6 text-center text-[13px] text-muted">
              The dataset rates no model for this combination.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[12px]">
                <thead>
                  <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-muted">
                    <th className="px-3 py-2 font-semibold">#</th>
                    <th className="px-3 py-2 font-semibold">Model</th>
                    <th className="px-3 py-2 text-right font-semibold">Input cost</th>
                    <th className="px-3 py-2 text-right font-semibold">Output cost</th>
                    <th className="px-3 py-2 text-right font-semibold">Intelligence</th>
                    <th className="px-3 py-2 text-right font-semibold">Verified tasks</th>
                    <th className="px-3 py-2 font-semibold">Trade-off</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={r.modelId} className="border-b border-line/60 hover:bg-elevated">
                      <td className="px-3 py-2 tabular-nums text-muted">{i + 1}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-ink" title={r.openrouterId}>{r.name}</span>
                          {r.trusted && <StatusPill tone="ok">trusted</StatusPill>}
                        </div>
                        <div className="text-[10px] text-muted">{r.company}</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-ink">
                        {money(r.inputCost)}<span className="text-muted">/M</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-ink">
                        {money(r.outputCost)}<span className="text-muted">/M</span>
                      </td>
                      <td className={cn("px-3 py-2 text-right tabular-nums", tone(r.intelligence))}>
                        {r.intelligence}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">
                        {r.verifiedCount}
                      </td>
                      <td className="px-3 py-2 text-[11px] leading-relaxed text-muted">
                        {r.tradeoff}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Picker({ label, value, options, onChange }: {
  label: string; value: string; options: Option[]; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 rounded-lg bg-elevated hairline px-2.5 py-1.5">
      <span className="text-[11px] text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={options.length === 0}
        className="bg-transparent text-[12px] text-ink outline-none disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id} className="bg-surface">{o.label}</option>
        ))}
      </select>
    </label>
  );
}
