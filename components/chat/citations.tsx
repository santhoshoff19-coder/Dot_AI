"use client";

import { AlertTriangle, BookOpen, ChevronDown, Scale } from "lucide-react";
import * as React from "react";
import { StatusPill, type Tone } from "@/components/ui/status-pill";
import { buildCitations, type Citation } from "@/lib/citations/build";
import { alignCitations, type AnswerSegment } from "@/lib/citations/inline";
import { cn } from "@/lib/utils";
import type { ControlEventData } from "@/types";

const STATUS_TONE: Record<string, Tone> = {
  SUPPORTED: "ok",
  CONTRADICTED: "danger",
  UNCERTAIN: "warn",
  UNVERIFIABLE: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  SUPPORTED: "supported",
  CONTRADICTED: "contradicted",
  UNCERTAIN: "uncertain",
  UNVERIFIABLE: "unverified",
};

/**
 * Sources shown beneath an answer.
 *
 * Deliberately shows what was NOT grounded as well as what was. A reader who
 * only sees supporting citations will over-trust the parts that have none.
 */
const RELATIONSHIP_TONE: Record<string, Tone> = {
  SUPPORTS: "ok", CONTRADICTS: "danger", POLICY: "accent",
};

/**
 * Renders the answer with inline citation markers where a claim could be
 * matched to its evidence, and the source list beneath it.
 */
export function AnswerWithCitations({
  answer, event,
}: { answer: string; event: ControlEventData }) {
  const set = React.useMemo(() => buildCitations(event), [event]);
  const alignment = React.useMemo(() => alignCitations(answer, set), [answer, set]);
  const [focus, setFocus] = React.useState<number | null>(null);

  return (
    <div>
      <div className="prose-chat whitespace-pre-wrap">
        {alignment.segments.map((seg, i) => (
          <Segment key={i} segment={seg} onSelect={setFocus} />
        ))}
      </div>
      <Citations event={event} focus={focus} onFocusHandled={() => setFocus(null)}
        heading={alignment.inline ? undefined : "Sources supporting this response"}
        note={alignment.note} />
    </div>
  );
}

function Segment({
  segment, onSelect,
}: { segment: AnswerSegment; onSelect: (n: number) => void }) {
  if (segment.kind === "text") return <>{segment.text}</>;
  return (
    <>
      {segment.text}
      <button
        onClick={() => onSelect(segment.citationIndex)}
        title="Show the evidence for this statement"
        className={cn(
          "mx-0.5 rounded px-1 align-super font-mono text-[10px] transition-colors focus-ring",
          segment.relationship === "CONTRADICTS"
            ? "bg-danger/15 text-danger hover:bg-danger/25"
            : "bg-accent/15 text-accent-soft hover:bg-accent/25",
        )}
      >
        [{segment.citationIndex}]
      </button>
    </>
  );
}

export function Citations({
  event, focus, onFocusHandled, heading, note,
}: {
  event: ControlEventData;
  focus?: number | null;
  onFocusHandled?: () => void;
  heading?: string;
  note?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const set = React.useMemo(() => buildCitations(event), [event]);

  // Clicking a marker opens the list and highlights that source.
  React.useEffect(() => {
    if (focus != null) setOpen(true);
  }, [focus]);

  const nothingToShow =
    set.citations.length === 0 &&
    set.ungroundedClaims.length === 0 &&
    !set.retrievalDisabled;

  if (nothingToShow) return null;

  return (
    <div className="mt-2 rounded-xl bg-elevated hairline">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left focus-ring rounded-xl"
      >
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="flex-1 text-[12px] text-muted">
          {heading ?? set.summary}
        </span>
        {set.retrievalMode && (
          <StatusPill tone={set.retrievalMode.startsWith("SEMANTIC") ? "ok" : "warn"}>
            {set.retrievalMode === "SEMANTIC_LOCAL" ? "semantic"
              : set.retrievalMode === "SEMANTIC" ? "semantic"
              : "keyword"}
          </StatusPill>
        )}
        <ChevronDown className={cn(
          "h-3.5 w-3.5 shrink-0 text-muted transition-transform",
          open && "rotate-180",
        )} />
      </button>

      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          {note && <p className="text-[11px] text-muted/80">{note}</p>}

          {set.citations.map((c) => (
            <CitationRow key={c.index} citation={c}
              highlighted={focus === c.index} onSeen={onFocusHandled} />
          ))}

          {set.ungroundedClaims.length > 0 && (
            <div className="rounded-lg border border-warn/25 bg-warn/5 p-2.5">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-warn">
                <AlertTriangle className="h-3 w-3" />
                Not grounded in any source
              </p>
              <ul className="space-y-1">
                {set.ungroundedClaims.map((u, i) => (
                  <li key={i} className="text-[11px] leading-relaxed text-muted">
                    “{u.claim}” — {u.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {set.retrievalDisabled && (
            <p className="text-[11px] leading-relaxed text-warn">
              Knowledge search was off for this request. The response was still
              checked, but nothing was verified against a document or policy.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CitationRow({
  citation, highlighted, onSeen,
}: { citation: Citation; highlighted?: boolean; onSeen?: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!highlighted) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const t = setTimeout(() => onSeen?.(), 2000);
    return () => clearTimeout(t);
  }, [highlighted, onSeen]);

  return (
    <div
      ref={ref}
      className={cn(
        "rounded-lg bg-surface p-2.5 transition-colors",
        highlighted && "ring-1 ring-accent/60",
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent-soft">
          [{citation.index}]
        </span>
        {citation.kind === "POLICY" && <Scale className="h-3 w-3 text-muted" />}
        <span className="text-[11px] font-medium text-ink">{citation.source}</span>
        {citation.isDemo && <StatusPill tone="warn">DEMO</StatusPill>}
        {citation.jurisdiction && (
          <StatusPill tone="neutral">{citation.jurisdiction}</StatusPill>
        )}
        <StatusPill tone={RELATIONSHIP_TONE[citation.relationship] ?? "neutral"}>
          {citation.relationship}
        </StatusPill>
        {citation.status === "CONTRADICTED" && (
          <StatusPill tone="danger">
            {STATUS_LABEL[citation.status]}
          </StatusPill>
        )}
        {typeof citation.score === "number" && (
          <span className="ml-auto text-[10px] text-muted">
            relevance {citation.score.toFixed(2)}
          </span>
        )}
      </div>

      <p className="mb-1 text-[11px] leading-relaxed text-muted">{citation.text}</p>

      {(citation.page != null || citation.sourceUrl) && (
        <p className="mb-1 text-[10px] text-muted">
          {citation.page != null && <>page {citation.page}</>}
          {citation.page != null && citation.sourceUrl && " · "}
          {citation.sourceUrl && (
            <a href={citation.sourceUrl} target="_blank" rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-ink">
              source
            </a>
          )}
        </p>
      )}

      {citation.claim && (
        <p className="border-t border-line pt-1 text-[10px] leading-relaxed text-muted/80">
          Checked against: “{citation.claim}”
        </p>
      )}
    </div>
  );
}
