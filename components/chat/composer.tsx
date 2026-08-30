"use client";

import { ArrowUp, Loader2, Mic, Paperclip, Square, Send } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { AttachmentChip } from "@/components/chat/attachment-chip";
import { VoiceService, type VoiceState } from "@/lib/voice/service";
import { cn, formatDuration } from "@/lib/utils";
import type { AttachmentRef } from "@/types";

interface PendingAttachment extends AttachmentRef {
  _status: "uploading" | "ready" | "error";
}

export function Composer({
  onSend, busy, onStop, autoFocus, placeholder, prefill,
}: {
  onSend: (prompt: string, attachments: AttachmentRef[]) => void;
  busy: boolean;
  onStop: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  /**
   * Text and attachments staged by another part of the app, loaded into the
   * composer without sending. `token` changes when a new handoff arrives, so
   * the same payload is never reapplied over something the user has since
   * typed.
   */
  prefill?: { token: string; prompt: string; attachments: AttachmentRef[] } | null;
}) {
  const [value, setValue] = React.useState("");
  const [attachments, setAttachments] = React.useState<PendingAttachment[]>([]);
  const appliedPrefill = React.useRef<string | null>(null);

  // Loaded, not sent. A staged prompt is an offer the user can edit or
  // discard; sending it for them would be the app acting on its own.
  React.useEffect(() => {
    if (!prefill || appliedPrefill.current === prefill.token) return;
    appliedPrefill.current = prefill.token;
    setValue(prefill.prompt);
    setAttachments(prefill.attachments.map((a) => ({ ...a, _status: "ready" as const })));
    // Focus the composer so the send button is the obvious next step.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [prefill]);
  const [dragging, setDragging] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [voiceState, setVoiceState] = React.useState<VoiceState>("idle");
  const [recordMs, setRecordMs] = React.useState(0);
  const voiceRef = React.useRef<VoiceService | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Auto-grow the textarea up to a ceiling.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  React.useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    voiceRef.current?.cancel();
  }, []);

  const uploadFiles = React.useCallback(async (files: File[]) => {
    if (!files.length) return;
    setError(null);

    const optimistic: PendingAttachment[] = files.map((f) => ({
      id: `tmp-${crypto.randomUUID()}`,
      name: f.name,
      mimeType: f.type,
      size: f.size,
      type: f.type.startsWith("image/") ? "image"
        : f.type.startsWith("audio/") ? "audio"
        : "document",
      previewUrl: null,
      storageRef: null,
      _status: "uploading",
    }));
    setAttachments((prev) => [...prev, ...optimistic]);

    const form = new FormData();
    files.forEach((f) => form.append("files", f));

    try {
      const res = await fetch("/api/attachments", { method: "POST", body: form });
      const data = (await res.json()) as { attachments?: AttachmentRef[]; errors?: string[]; error?: string };

      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      if (data.errors?.length) setError(data.errors.join(" "));

      setAttachments((prev) => {
        const ids = new Set(optimistic.map((o) => o.id));
        const kept = prev.filter((a) => !ids.has(a.id));
        const saved: PendingAttachment[] = (data.attachments ?? []).map((a) => ({ ...a, _status: "ready" }));
        return [...kept, ...saved];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setAttachments((prev) => prev.filter((a) => !optimistic.some((o) => o.id === a.id)));
    }
  }, []);

  const submit = () => {
    const prompt = value.trim();
    if (!prompt || busy) return;
    if (attachments.some((a) => a._status === "uploading")) return;
    onSend(prompt, attachments.map(({ _status, ...rest }) => rest));
    setValue("");
    setAttachments([]);
    setError(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      void uploadFiles(files);
    }
  };

  // ---- voice --------------------------------------------------------------
  const startRecording = async () => {
    setError(null);
    if (!VoiceService.isSupported()) {
      setError("Microphone recording is not supported in this browser.");
      return;
    }
    try {
      voiceRef.current = new VoiceService();
      await voiceRef.current.start();
      setVoiceState("recording");
      setRecordMs(0);
      timerRef.current = setInterval(() => setRecordMs((m) => m + 200), 200);
    } catch {
      setVoiceState("error");
      setError("Microphone access was denied. Check your browser permissions.");
    }
  };

  const stopRecording = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    const svc = voiceRef.current;
    if (!svc) return;
    setVoiceState("processing");
    try {
      const { blob, durationMs } = await svc.stop();
      const result = await svc.transcribe(blob, durationMs);
      setValue((v) => (v ? `${v} ${result.text}` : result.text));
      setVoiceState("ready");
      if (result.mock) setError("Simulated transcript (MOCK_MODE). No speech-to-text provider is configured.");
      textareaRef.current?.focus();
    } catch (err) {
      setVoiceState("error");
      setError(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      voiceRef.current = null;
      setTimeout(() => setVoiceState("idle"), 1200);
    }
  };

  const uploading = attachments.some((a) => a._status === "uploading");
  const canSend = value.trim().length > 0 && !busy && !uploading;

  return (
    <div className="w-full">
      {error && (
        <div className="mb-2 rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          {error}
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void uploadFiles(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          "rounded-2xl bg-surface hairline transition-colors",
          dragging && "border-accent/60 bg-accent/5",
        )}
      >
        {attachments.length > 0 && (
          <div className="grid gap-2 border-b border-line p-2.5 sm:grid-cols-2">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                status={a._status}
                onRemove={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              />
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 p-2.5">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            accept="image/*,.pdf,.txt,.md,.csv,.json,.docx,audio/*"
            onChange={(e) => {
              void uploadFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </Button>

          <textarea
            ref={textareaRef}
            value={value}
            autoFocus={autoFocus}
            rows={1}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={
              voiceState === "recording" ? "Listening…"
              : voiceState === "processing" ? "Transcribing…"
              : placeholder ?? "Ask anything, attach a file, or speak"
            }
            className="max-h-[220px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-relaxed text-ink outline-none placeholder:text-muted/70"
          />

          {voiceState === "recording" ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger">
                <span className="h-1.5 w-1.5 animate-blink rounded-full bg-danger" />
                {formatDuration(recordMs)}
              </span>
              <Button type="button" variant="secondary" size="icon" onClick={() => void stopRecording()} aria-label="Stop recording">
                <Square className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={voiceState === "processing"}
              onClick={() => void startRecording()}
              aria-label="Record voice input"
              title="Record voice input"
            >
              {voiceState === "processing"
                ? <Loader2 className="h-[18px] w-[18px] animate-spin" />
                : <Mic className="h-[18px] w-[18px]" />}
            </Button>
          )}

          {busy ? (
            <Button type="button" variant="secondary" size="icon" onClick={onStop} aria-label="Stop generating" title="Stop generating">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              disabled={!canSend}
              onClick={submit}
              aria-label="Send message"
              title="Send"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-[18px] w-[18px]" />}
            </Button>
          )}
        </div>
      </div>

      <p className="mt-2 px-1 text-center text-[11px] text-muted/70">
        Enter to send · Shift+Enter for a new line · drag, paste or attach files
      </p>
    </div>
  );
}
