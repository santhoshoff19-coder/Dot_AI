"use client";

import { FileAudio, FileText, ImageIcon, Loader2, X } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import type { AttachmentRef, AttachmentStatus } from "@/types";

export function AttachmentChip({
  attachment, status = "ready", onRemove, compact,
}: {
  attachment: AttachmentRef;
  status?: AttachmentStatus;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const Icon =
    attachment.type === "image" ? ImageIcon
    : attachment.type === "audio" ? FileAudio
    : FileText;

  return (
    <div
      className={cn(
        "group flex items-center gap-2.5 rounded-lg bg-elevated hairline px-2.5 py-2",
        compact && "py-1.5",
      )}
    >
      {attachment.type === "image" && attachment.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.previewUrl}
          alt={attachment.name}
          className="h-9 w-9 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-canvas text-muted">
          {status === "uploading"
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <Icon className="h-4 w-4" />}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">{attachment.name}</p>
        <p className="text-[11px] text-muted">
          {status === "uploading" ? "Uploading…" : (
            <>
              {attachment.type}
              {attachment.size > 0 && ` · ${formatBytes(attachment.size)}`}
            </>
          )}
        </p>
      </div>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          className="rounded p-1 text-muted opacity-0 transition-opacity hover:bg-line hover:text-ink focus-ring group-hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
