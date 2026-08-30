"use client";

import { AlertTriangle, Ban, Download, ShieldAlert, User } from "lucide-react";
import * as React from "react";
import { AttachmentChip } from "@/components/chat/attachment-chip";
import { AnswerWithCitations, Citations } from "@/components/chat/citations";
import { VerificationStrip } from "@/components/chat/verification-strip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types";

export function MessageItem({
  message, streaming, onOpenControl, onOpenReview,
}: {
  message: ChatMessage;
  streaming?: boolean;
  onOpenControl: (m: ChatMessage) => void;
  onOpenReview: (m: ChatMessage) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] space-y-2">
          {message.attachments.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {message.attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} compact />
              ))}
            </div>
          )}
          {message.content && (
            <div className="rounded-2xl rounded-br-md bg-accent/15 hairline border-accent/25 px-4 py-2.5">
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{message.content}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  const blocked = message.status === "blocked";
  const held = message.status === "held";
  const event = message.controlEvent;

  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 hairline border-accent/25">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      </span>

      <div className="min-w-0 flex-1">
        {blocked && (
          <Notice tone="danger" icon={<Ban className="h-4 w-4" />} title="Response blocked by ControlPlane">
            {event?.decision.reason ?? "This response violated a policy control."}
          </Notice>
        )}

        {held && (
          <Notice tone="warn" icon={<ShieldAlert className="h-4 w-4" />} title="Held for human review">
            <p>{event?.decision.reason ?? "This response requires human approval."}</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => onOpenReview(message)}
            >
              Open review
            </Button>
          </Notice>
        )}

        {message.status === "error" && (
          <Notice tone="danger" icon={<AlertTriangle className="h-4 w-4" />} title="Something went wrong">
            {message.content}
          </Notice>
        )}

        {message.document && !blocked && (
          <a
            href={message.document.url}
            download={message.document.fileName}
            className="mb-2 flex items-center gap-2.5 rounded-xl bg-elevated hairline px-3 py-2.5 transition-colors hover:border-accent/40 focus-ring"
          >
            <span className="rounded-lg bg-accent/10 p-2 text-accent-soft">DOCX</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">
                {message.document.fileName}
              </span>
              <span className="block text-[11px] text-muted">
                {(message.document.size / 1024).toFixed(0)} KB · click to download
                {message.document.simulated && " · simulated content"}
              </span>
            </span>
          </a>
        )}

        {message.image && !blocked && (
          <figure className="mb-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.image.url}
              alt="Generated image"
              className="max-w-full rounded-xl hairline"
              style={{ maxHeight: 420 }}
            />
            <figcaption className="mt-1.5 flex flex-wrap items-center gap-2">
              <DownloadImageButton
                url={message.image.url}
                mimeType={message.image.mimeType}
                simulated={message.image.simulated}
              />
              {message.image.simulated && (
                <span className="text-[11px] text-warn">
                  Simulated image — mock mode. Connect OpenRouter in Settings for real generation.
                </span>
              )}
            </figcaption>
          </figure>
        )}

        {/* While streaming, render plain text: claim alignment needs the
            finished answer, and a marker that moves as text arrives is worse
            than no marker. */}
        {!blocked && !held && message.status !== "error" && message.content && (
          streaming || !event ? (
            <div className={cn("prose-chat whitespace-pre-wrap", streaming && "caret")}>
              {message.content}
            </div>
          ) : (
            <AnswerWithCitations answer={message.content} event={event} />
          )
        )}

        {/* A held or blocked answer still shows what was checked. */}
        {event && !streaming && (blocked || held || !message.content) && (
          <Citations event={event} />
        )}

        {event && <VerificationStrip event={event} onOpen={() => onOpenControl(message)} />}
      </div>
    </div>
  );
}

function Notice({
  tone, icon, title, children,
}: {
  tone: "danger" | "warn";
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      "rounded-xl border px-3.5 py-3",
      tone === "danger" ? "border-danger/25 bg-danger/5" : "border-warn/25 bg-warn/5",
    )}>
      <div className={cn(
        "mb-1 flex items-center gap-2 text-[13px] font-semibold",
        tone === "danger" ? "text-danger" : "text-warn",
      )}>
        {icon}
        {title}
      </div>
      <div className="text-[13px] leading-relaxed text-ink/80">{children}</div>
    </div>
  );
}

/**
 * Downloads a generated image.
 *
 * A plain `<a download>` is not enough here: generated images arrive as
 * `data:` URLs, which some browsers refuse to download from an anchor, and a
 * remote URL on another origin ignores the `download` attribute entirely and
 * navigates away instead. Fetching to a Blob and revoking the object URL
 * afterwards works for both, and gives the file a real name and extension.
 */
function DownloadImageButton({ url, mimeType, simulated }: {
  url: string; mimeType: string; simulated: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const extension = (() => {
    const fromMime = mimeType?.split("/")[1]?.split("+")[0];
    return fromMime && /^[a-z0-9]+$/i.test(fromMime) ? fromMime : "png";
  })();

  const download = async () => {
    setBusy(true);
    setFailed(false);
    let objectUrl: string | null = null;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const blob = await res.blob();

      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `dotai-image-${Date.now()}.${extension}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setFailed(true);
    } finally {
      // Revoked on the next tick so the click has taken the URL first.
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 1000);
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-lg bg-elevated hairline px-2 py-1 text-[11px] text-muted transition-colors hover:text-ink focus-ring disabled:opacity-60"
      >
        <Download className="h-3 w-3" />
        {busy ? "Downloading…" : simulated ? "Download (simulated)" : "Download"}
      </button>
      {failed && (
        <span className="text-[11px] text-danger">
          Could not download that image. Try right-click and save instead.
        </span>
      )}
    </>
  );
}
