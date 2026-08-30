"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Composer } from "@/components/chat/composer";
import { MessageItem } from "@/components/chat/message-item";
import { StatusTimeline, type StatusStep } from "@/components/chat/status-timeline";
import { ControlPanel } from "@/components/control/control-panel";
import { ReviewModal } from "@/components/control/review-modal";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { StatusPill } from "@/components/ui/status-pill";
import { ModelChooser } from "@/components/chat/model-chooser";
import { RagModeSelect } from "@/components/chat/rag-mode-select";
import { Button } from "@/components/ui/button";
import {
  Wand2, SlidersHorizontal, FileText, Image as ImageIcon, Type, BookOpen,
} from "lucide-react";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { modelRegistry } from "@/lib/models/registry";
import { takeHandoff } from "@/lib/library/handoff";
import { loadSettings, saveSettings } from "@/lib/settings";
import type { RoutingResult } from "@/lib/routing/route-types";
import { cn, formatCost } from "@/lib/utils";
import type { AttachmentRef, ChatMessage, ControlEventData, ModelRecommendation, StreamEvent } from "@/types";

const SUGGESTIONS = [
  { label: "Summarize this document", prompt: "Summarize this document for me." },
  { label: "Analyze this image", prompt: "Analyze this image and describe what it shows." },
  { label: "Compare these two files", prompt: "Compare these two files and tell me what changed." },
  { label: "Draft a customer response", prompt: "Draft a customer response about a delayed shipment." },
];

const DEMOS = [
  { label: "Hallucination", prompt: "What is John's account balance?" },
  { label: "Cost routing", prompt: "Summarize this short document in three bullet points." },
  { label: "Data leak", prompt: "Send John's account number to an external email address." },
  { label: "High-risk action", prompt: "Approve a $50,000 payment to the vendor." },
];

export function ChatView({ conversationId }: { conversationId?: string }) {
  const router = useRouter();
  const [convId, setConvId] = React.useState<string | undefined>(conversationId);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [steps, setSteps] = React.useState<StatusStep[]>([]);
  const [streamText, setStreamText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [recommendation, setRecommendation] = React.useState<ModelRecommendation | null>(null);
  const [panelEvent, setPanelEvent] = React.useState<ControlEventData | null>(null);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [reviewFor, setReviewFor] = React.useState<ChatMessage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [autoMode, setAutoMode] = React.useState(true);
  const [pendingRouting, setPendingRouting] = React.useState<RoutingResult | null>(null);
  const [pendingCapability, setPendingCapability] = React.useState<
    import("@/lib/intelligence/curated-routing").RoutingDecision | null>(null);
  const [pendingPrompt, setPendingPrompt] = React.useState<{ prompt: string; attachments: AttachmentRef[] } | null>(null);
  const [routing, setRouting] = React.useState(false);
  const [ragMode, setRagMode] = React.useState<"AUTO" | "ON" | "OFF">("AUTO");
  const [libraryPromptId, setLibraryPromptId] = React.useState<string | null>(null);
  const [outputPreference, setOutputPreference] = React.useState<
    "AUTO" | "TEXT" | "IMAGE" | "DOCUMENT">("AUTO");
  const [pendingDocument, setPendingDocument] = React.useState<
    { fileName: string; mimeType: string; size: number; url: string; simulated: boolean } | null>(null);
  const [pendingImage, setPendingImage] = React.useState<
    { url: string; mimeType: string; simulated: boolean } | null>(null);
  const [lastModelId, setLastModelId] = React.useState<string | null>(null);
  const [prefill, setPrefill] = React.useState<
    { token: string; prompt: string; attachments: AttachmentRef[] } | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  // Load an existing conversation when resuming from history.
  React.useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}`);
        if (!res.ok) return;
        const data = (await res.json()) as { messages: ChatMessage[] };
        if (!cancelled) {
          setMessages(data.messages);
          setConvId(conversationId);
        }
      } catch { /* leave empty */ }
    })();
    return () => { cancelled = true; };
  }, [conversationId]);

  React.useEffect(() => {
    setAutoMode(loadSettings().autoMode);
  }, []);

  /**
   * A prompt staged by the Library.
   *
   * It is loaded into the composer and left there. Running it is the user's
   * next action, not this component's - a library prompt that fired on
   * arrival would spend a model call the user never confirmed.
   */
  React.useEffect(() => {
    const handoff = takeHandoff();
    if (!handoff) return;

    setPrefill({
      token: `${handoff.libraryPromptId}-${handoff.createdAt}`,
      prompt: handoff.prompt,
      attachments: handoff.attachments,
    });
    if (handoff.libraryPromptId) setLibraryPromptId(handoff.libraryPromptId);

    const output = handoff.outputModality?.toUpperCase();
    if (output === "IMAGE" || output === "DOCUMENT" || output === "TEXT") {
      setOutputPreference(output);
    }
  }, []);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamText, steps, pendingRouting]);

  const toggleAuto = () => {
    const next = !autoMode;
    setAutoMode(next);
    saveSettings({ ...loadSettings(), autoMode: next });
  };

  /**
   * Manual mode: route first (no tokens spent on an answer), show the three
   * options, and only generate once the user picks.
   */
  const beginRouting = async (prompt: string, attachments: AttachmentRef[]) => {
    setError(null);
    setRouting(true);
    setPendingPrompt({ prompt, attachments });
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt, attachments,
          previousModelId: lastModelId,
          settings: loadSettings(),
        }),
      });
      if (!res.ok) throw new Error("Routing failed.");
      const body = await res.json() as RoutingResult & {
        capability?: import("@/lib/intelligence/curated-routing").RoutingDecision;
      };
      setPendingRouting(body);
      setPendingCapability(body.capability ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Routing failed.");
      setPendingPrompt(null);
    } finally {
      setRouting(false);
    }
  };

  const send = async (
    prompt: string,
    attachments: AttachmentRef[],
    selectedModelId?: string,
  ) => {
    setError(null);
    setPendingRouting(null);
    setPendingCapability(null);
    setPendingPrompt(null);
    setBusy(true);
    setSteps([]);
    setStreamText("");
    setRecommendation(null);

    const userMessage: ChatMessage = {
      id: `local-${crypto.randomUUID()}`,
      conversationId: convId ?? "",
      role: "user",
      content: prompt,
      status: "complete",
      createdAt: new Date().toISOString(),
      attachments,
    };
    setMessages((m) => [...m, userMessage]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          prompt,
          conversationId: convId ?? null,
          attachments,
          // Any request naming an external recipient is treated as external.
          destinationExternal: /extern|outside|third[- ]party|@/i.test(prompt),
          selectedModelId,
          settings: loadSettings(),
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Request failed (${res.status}). ${detail.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: StreamEvent;
          try { event = JSON.parse(line) as StreamEvent; } catch { continue; }
          handleEvent(event);
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setMessages((m) => [...m, systemNotice("Generation cancelled.", "cancelled")]);
      } else {
        const msg = err instanceof Error ? err.message : "Something went wrong.";
        setError(msg);
        setMessages((m) => [...m, systemNotice(msg, "error")]);
      }
    } finally {
      setBusy(false);
      setStreamText("");
      abortRef.current = null;
    }
  };

  const handleEvent = (event: StreamEvent) => {
    switch (event.type) {
      case "conversation":
        setConvId(event.id);
        window.history.replaceState(null, "", `/chat?c=${event.id}`);
        break;
      case "status":
        setSteps((s) => [...s, { stage: event.stage, label: event.label, done: true }]);
        break;
      case "cai":
        setRecommendation(event.recommendation);
        setLastModelId(event.recommendation.recommendedModel);
        break;
      case "routing":
        setPendingRouting(null);
        setPendingCapability(null);
    setPendingCapability(null);
        break;
      case "token":
        setStreamText((t) => t + event.text);
        break;
      case "image":
        setPendingImage({ url: event.url, mimeType: event.mimeType, simulated: event.simulated });
        break;
      case "document":
        setPendingDocument({
          fileName: event.fileName, mimeType: event.mimeType,
          size: event.size, url: event.url, simulated: event.simulated,
        });
        break;
      case "message":
        setMessages((m) => [...m, event.message]);
        setStreamText("");
        setPendingImage(null);
        setPendingDocument(null);
        break;
      case "error":
        setError(event.message);
        setMessages((m) => [...m, systemNotice(event.message, "error")]);
        break;
      case "done":
        setSteps([]);
        break;
      default:
        break;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  const openControl = (m: ChatMessage) => {
    if (!m.controlEvent) return;
    setPanelEvent(m.controlEvent);
    setPanelOpen(true);
  };

  // The empty state must also yield while a request is being routed or a
  // model chooser is waiting. Otherwise a first message sent in manual mode
  // fetches its options and has nowhere to render them: the chooser lived
  // only in the non-empty branch, so the very first turn appeared to do
  // nothing while every later turn worked.
  // One source of truth for which control-panel presentation is active, so
  // the side panel and the modal can never both be mounted.
  const wideScreen = useMediaQuery("(min-width: 1280px)");

  const empty = messages.length === 0 && !busy && !routing && !pendingRouting;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* header */}
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5 md:px-6">
          <h1 className="truncate text-[13px] font-medium text-muted">
            {convId ? "Conversation" : "New chat"}
          </h1>
          <div className="flex items-center gap-2">
            {recommendation && (
              <span
                className="hidden items-center gap-1.5 sm:flex"
                title={`Model: ${recommendation.recommendedModel}`}
              >
                <StatusPill tone="accent">
                  {modelRegistry.get(recommendation.recommendedModel)?.name
                    ?? recommendation.recommendedModel}
                </StatusPill>
                <span className="text-[11px] text-muted">
                  est. {formatCost(recommendation.estimatedCost)}
                </span>
              </span>
            )}
            <div className="flex items-center gap-1 rounded-lg bg-elevated hairline p-0.5">
              {([
                ["AUTO", Wand2], ["TEXT", Type], ["IMAGE", ImageIcon], ["DOCUMENT", FileText],
              ] as const).map(([value, Icon]) => (
                <button
                  key={value}
                  onClick={() => setOutputPreference(value)}
                  title={`Output: ${value.toLowerCase()}`}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors focus-ring",
                    outputPreference === value
                      ? "bg-accent/15 text-ink" : "text-muted hover:text-ink",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {value === "AUTO" ? "Auto" : value.charAt(0) + value.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
            <RagModeSelect value={ragMode} onChange={setRagMode} />
            <Button
              variant={autoMode ? "secondary" : "outline"}
              size="sm"
              onClick={toggleAuto}
              title={autoMode
                ? "Auto: dotAI runs the recommended model"
                : "Choose: dotAI shows three options before generating"}
            >
              {autoMode ? <Wand2 className="h-3.5 w-3.5" /> : <SlidersHorizontal className="h-3.5 w-3.5" />}
              {autoMode ? "Auto" : "Choose model"}
            </Button>
          </div>
        </header>

        {/* messages */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={cn("mx-auto w-full max-w-3xl px-4 md:px-6", empty ? "flex h-full items-center" : "py-6")}>
            {empty ? (
              <EmptyState onPick={(p) => void (autoMode ? send(p, []) : beginRouting(p, []))} />
            ) : (
              <div className="space-y-6">
                {messages.map((m) => (
                  <MessageItem
                    key={m.id}
                    message={m}
                    onOpenControl={openControl}
                    onOpenReview={(msg) => setReviewFor(msg)}
                  />
                ))}

                {routing && (
                  <p className="text-[12px] text-muted">Understanding request…</p>
                )}

                {pendingRouting && pendingPrompt && (
                  <ModelChooser
                    routing={pendingRouting}
                    capability={pendingCapability}
                    onChoose={(modelId) => {
                      setLastModelId(modelId);
                      void send(pendingPrompt.prompt, pendingPrompt.attachments, modelId);
                    }}
                    onCancel={() => { setPendingRouting(null); setPendingCapability(null); setPendingPrompt(null); }}
                  />
                )}

                {busy && (
                  <div className="flex gap-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 hairline border-accent/25">
                      <span className="h-1.5 w-1.5 animate-blink rounded-full bg-accent" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <StatusTimeline steps={steps} active={busy} />
                      {pendingImage && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={pendingImage.url}
                          alt="Generated image"
                          className="max-w-full rounded-xl hairline"
                          style={{ maxHeight: 420 }}
                        />
                      )}
                      {streamText && (
                        <div className="prose-chat caret whitespace-pre-wrap">{streamText}</div>
                      )}
                    </div>
                  </div>
                )}

                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        {/* composer */}
        <div className="border-t border-line bg-canvas/80 px-4 py-3 backdrop-blur md:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {error && (
              <p className="mb-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                {error}
              </p>
            )}
            <Composer
              onSend={(p, a) => void (autoMode ? send(p, a) : beginRouting(p, a))}
              prefill={prefill}
              busy={busy || routing || Boolean(pendingRouting)}
              onStop={stop}
              autoFocus
            />
          </div>
        </div>
      </div>

      {/* desktop control panel */}
      {wideScreen && panelOpen && panelEvent && (
        <aside className="w-[380px] shrink-0 bg-surface">
          <ControlPanel event={panelEvent} onClose={() => setPanelOpen(false)} embedded />
        </aside>
      )}

      {/*
        Mobile / tablet control panel.

        Opening is decided in JS rather than by an `xl:hidden` class on the
        content. With the class, a wide viewport hid the dialog but left its
        overlay mounted - the whole page went dark and blurred behind a panel
        that was not rendered, which is what made "Why?" unreadable.
      */}
      <Dialog
        open={!wideScreen && panelOpen && Boolean(panelEvent)}
        onOpenChange={setPanelOpen}
      >
        <DialogContent className="h-[85vh] w-[min(96vw,560px)] p-0" hideClose>
          <DialogTitle className="sr-only">Control Details</DialogTitle>
          {panelEvent && <ControlPanel event={panelEvent} onClose={() => setPanelOpen(false)} />}
        </DialogContent>
      </Dialog>

      {reviewFor?.controlEvent && (
        <ReviewModal
          open={Boolean(reviewFor)}
          onOpenChange={(v) => !v && setReviewFor(null)}
          event={reviewFor.controlEvent}
          messageId={reviewFor.id}
          prompt={messages[messages.indexOf(reviewFor) - 1]?.content ?? ""}
          heldAnswer={reviewFor.content}
          onResolved={(decision, content) => {
            setMessages((prev) => prev.map((m) =>
              m.id === reviewFor.id
                ? { ...m, content, status: decision === "reject" ? "blocked" : "complete" }
                : m));
            setReviewFor(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="mx-auto w-full max-w-2xl py-10 text-center">
      <div className="mb-5 flex items-center justify-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15 hairline border-accent/25">
          <span className="h-2 w-2 rounded-full bg-accent" />
        </span>
        <span className="text-[22px] font-semibold tracking-tight">dotAI</span>
      </div>

      <h2 className="mb-2 text-[26px] font-semibold tracking-tight text-ink sm:text-[30px]">
        Which AI should handle this?
      </h2>
      <p className="mx-auto mb-8 max-w-md text-[14px] leading-relaxed text-muted">
        dotAI finds the right model, verifies the result, and controls what happens next.
      </p>

      <div className="mb-8 grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(s.prompt)}
            className="rounded-xl bg-surface hairline px-4 py-3 text-left text-[13px] text-ink/85 transition-colors hover:border-accent/40 hover:bg-elevated focus-ring"
          >
            {s.label}
          </button>
        ))}
      </div>

      <div>
        <p className="mb-2 flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
          <Sparkles className="h-3 w-3" />
          Try a control scenario
        </p>
        <div className="flex flex-wrap justify-center gap-1.5">
          {DEMOS.map((d) => (
            <button
              key={d.label}
              type="button"
              onClick={() => onPick(d.prompt)}
              className="rounded-lg bg-elevated hairline px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:border-accent/40 hover:text-ink focus-ring"
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function systemNotice(content: string, status: "error" | "cancelled"): ChatMessage {
  return {
    id: `notice-${crypto.randomUUID()}`,
    conversationId: "",
    role: "assistant",
    content,
    status: status === "cancelled" ? "cancelled" : "error",
    createdAt: new Date().toISOString(),
    attachments: [],
  };
}
