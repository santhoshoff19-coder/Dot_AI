"use client";

import * as React from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusPill, toneForStatus } from "@/components/ui/status-pill";
import { formatCost } from "@/lib/utils";
import type { ControlEventData } from "@/types";

/**
 * Human review. Opened when the decision is HOLD. Shows everything the
 * reviewer needs: request, output, evidence, risk, and why it was flagged.
 */
export function ReviewModal({
  open, onOpenChange, event, prompt, heldAnswer, messageId, onResolved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  event: ControlEventData;
  prompt: string;
  heldAnswer: string;
  messageId: string;
  onResolved: (decision: string, content: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(heldAnswer);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => { setDraft(heldAnswer); }, [heldAnswer]);

  const resolve = async (humanDecision: "approve" | "reject" | "edit") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId,
          requestId: event.requestId,
          humanDecision,
          editedContent: humanDecision === "edit" ? draft : undefined,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; content?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Review failed.");
      onResolved(humanDecision, humanDecision === "reject" ? "" : (data.content ?? draft));
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,680px)]">
        <DialogTitle className="mb-1 text-[15px] font-semibold">Human review required</DialogTitle>
        <p className="mb-4 text-[12px] text-muted">
          This response was held by ControlPlane and has not been delivered.
        </p>

        <div className="space-y-4">
          <Block label="Why it was flagged">
            <p className="text-[13px] leading-relaxed text-ink/90">{event.decision.reason}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <StatusPill tone="warn">Risk: {event.riskLevel}</StatusPill>
              <StatusPill tone={toneForStatus(event.verification.status)}>
                Performance: {event.verification.status}
              </StatusPill>
              <StatusPill tone={toneForStatus(event.responsibility.status)}>
                Responsibility: {event.responsibility.status}
              </StatusPill>
              <StatusPill tone="neutral">{formatCost(event.actualCost)}</StatusPill>
            </div>
          </Block>

          <Block label="Original request">
            <p className="text-[13px] leading-relaxed text-ink/80">{prompt}</p>
          </Block>

          <Block label="Held output">
            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={6}
                className="w-full resize-y rounded-lg bg-canvas hairline p-2.5 text-[13px] leading-relaxed text-ink outline-none focus-ring"
              />
            ) : (
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink/80">
                {heldAnswer || "(empty)"}
              </p>
            )}
          </Block>

          {event.verification.verdicts.some((v) => v.evidence) && (
            <Block label="Evidence">
              {event.verification.verdicts.filter((v) => v.evidence).map((v, i) => (
                <div key={i} className="mb-2 border-l-2 border-accent/40 pl-2 last:mb-0">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-accent-soft">
                    {v.evidence?.source}
                  </p>
                  <p className="text-[12px] leading-relaxed text-muted">{v.evidence?.text}</p>
                  <p className="mt-0.5 text-[11px] text-warn">{v.detail}</p>
                </div>
              ))}
            </Block>
          )}

          {event.actionGate && (
            <Block label="Action Gate">
              <p className="text-[12px] text-ink/80">{event.actionGate.reason}</p>
            </Block>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </p>
        )}

        <footer className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)} disabled={busy}>
            {editing ? "Cancel edit" : "Edit"}
          </Button>
          <Button variant="danger" size="sm" onClick={() => void resolve("reject")} disabled={busy}>
            Reject
          </Button>
          {editing ? (
            <Button size="sm" onClick={() => void resolve("edit")} disabled={busy}>
              Save &amp; approve
            </Button>
          ) : (
            <Button size="sm" onClick={() => void resolve("approve")} disabled={busy}>
              Approve
            </Button>
          )}
        </footer>

        <p className="mt-3 text-[11px] text-muted/70">
          Every human decision is written to the audit log.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</h4>
      <div className="rounded-lg bg-elevated p-3">{children}</div>
    </div>
  );
}
