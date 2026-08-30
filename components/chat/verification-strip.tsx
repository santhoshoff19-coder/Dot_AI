"use client";

import { AlertTriangle, Ban, Check, ChevronRight, Info } from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import {
  answerStatus, answerStatusDetail, ANSWER_STATUS_LABEL, ragLabel,
  type AnswerStatus,
} from "@/lib/ui/labels";
import { cn, formatCost } from "@/lib/utils";
import type { ControlEventData } from "@/types";

const ICON: Record<AnswerStatus, React.ReactNode> = {
  VERIFIED: <Check className="h-3.5 w-3.5 text-ok" />,
  UNVERIFIED: <Info className="h-3.5 w-3.5 text-muted" />,
  REVIEW: <AlertTriangle className="h-3.5 w-3.5 text-warn" />,
  BLOCKED: <Ban className="h-3.5 w-3.5 text-danger" />,
};

const TONE: Record<AnswerStatus, string> = {
  VERIFIED: "text-ok",
  UNVERIFIED: "text-muted",
  REVIEW: "text-warn",
  BLOCKED: "text-danger",
};

/**
 * The one line under every answer.
 *
 * This used to list Performance, Cost and Responsibility with their raw enum
 * values, which asked the reader to work out what "UNVERIFIABLE / WITHIN
 * TARGET / PERMITTED" added up to. It now states the conclusion, and the
 * three checker results move behind "Why?" for anyone who wants them.
 */
export function VerificationStrip({
  event, onOpen,
}: {
  event: ControlEventData;
  onOpen: () => void;
}) {
  const status = answerStatus({
    decision: event.decision.decision,
    verificationStatus: event.verification.status,
    claimsChecked: event.verification.claimsChecked,
  });

  const severe = status === "BLOCKED" || status === "REVIEW";
  const rag = ragLabel(event.rag);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group mt-3 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-surface/60 hairline px-3 py-2 text-left transition-colors hover:bg-surface focus-ring",
        severe && "border-warn/30 bg-warn/5",
      )}
    >
      <span className={cn("flex items-center gap-1.5 text-[12px] font-semibold", TONE[status])}>
        {ICON[status]}
        {ANSWER_STATUS_LABEL[status]}
      </span>

      <span className="hidden text-[11px] text-muted sm:inline">
        {answerStatusDetail(status, event.verification.claimsChecked)}
      </span>

      <span className="ml-auto flex items-center gap-2">
        {event.sessionRisk && event.sessionRisk.level !== "LOW" && (
          <StatusPill tone={event.sessionRisk.level === "HIGH" ? "danger" : "warn"}>
            Session risk {event.sessionRisk.level.toLowerCase()}
          </StatusPill>
        )}
        <span className="text-[11px] text-muted">{rag}</span>
        <span className="hidden text-[11px] text-muted sm:inline">
          {formatCost(event.actualCost)}
        </span>
        <span className="flex items-center gap-0.5 text-[11px] font-medium text-accent-soft">
          Why?
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </span>
    </button>
  );
}
