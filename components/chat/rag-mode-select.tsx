"use client";

import { BookOpen, Check, ChevronDown } from "lucide-react";
import * as React from "react";
import { RAG_MODES, type RagModeValue } from "@/lib/ui/labels";
import { cn } from "@/lib/utils";

/**
 * Retrieval mode, as a small labelled menu.
 *
 * It replaced a button that cycled AUTO -> ON -> OFF on click: the current
 * value was visible but the available values were not, so the only way to
 * find out what the control did was to change it. Each option carries the one
 * sentence that explains it, and nothing about how retrieval works is exposed.
 */
export function RagModeSelect({
  value, onChange,
}: {
  value: RagModeValue;
  onChange: (v: RagModeValue) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const current = RAG_MODES.find((m) => m.value === value) ?? RAG_MODES[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current.hint}
        className={cn(
          "flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors focus-ring hairline",
          value === "ON" ? "border-accent/50 bg-accent/10 text-ink"
          : value === "OFF" ? "border-warn/40 bg-warn/5 text-warn"
          : "bg-elevated text-muted hover:text-ink",
        )}
      >
        <BookOpen className="h-3 w-3" />
        RAG: {current.label}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-20 mt-1 w-[228px] overflow-hidden rounded-xl bg-surface hairline shadow-lg"
        >
          {RAG_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="option"
              aria-selected={m.value === value}
              onClick={() => { onChange(m.value); setOpen(false); }}
              className={cn(
                "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-elevated focus-ring",
                m.value === value && "bg-elevated",
              )}
            >
              <Check className={cn(
                "mt-0.5 h-3 w-3 shrink-0",
                m.value === value ? "text-accent-soft" : "text-transparent",
              )} />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-ink">{m.label}</span>
                <span className="block text-[11px] leading-relaxed text-muted">{m.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
