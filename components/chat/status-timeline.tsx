"use client";

import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StatusStep { stage: string; label: string; done: boolean }

/**
 * The progressive control sequence: analysing -> CAI -> generating ->
 * checking -> decision. Deliberately understated, not theatrical.
 */
export function StatusTimeline({ steps, active }: { steps: StatusStep[]; active: boolean }) {
  if (!steps.length) return null;

  return (
    <div className="mb-3 space-y-1.5">
      {steps.map((s, i) => {
        const isLast = i === steps.length - 1;
        const spinning = active && isLast;
        return (
          <div
            key={`${s.stage}-${i}`}
            className={cn(
              "flex items-center gap-2 text-[12px] animate-fade-up",
              spinning ? "text-ink/80" : "text-muted",
            )}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {spinning
                ? <Loader2 className="h-3 w-3 animate-spin text-accent" />
                : <Check className="h-3 w-3 text-ok" />}
            </span>
            <span>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}
