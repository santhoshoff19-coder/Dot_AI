"use client";

import { Check, Loader2, Plug, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";

interface Status {
  connected: boolean;
  source: "stored" | "env" | "none";
  hint: string | null;
  createdAt: string | null;
}

/**
 * Connect OpenRouter without editing .env.
 *
 * The key is posted once, validated against OpenRouter, then encrypted at rest
 * server-side. It is never returned to this component - only a four-character
 * hint is ever displayed.
 */
export function OpenRouterConnect() {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/settings/openrouter");
      if (res.ok) setStatus((await res.json()) as Status);
    } catch {
      /* leave status unknown rather than guessing */
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/openrouter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      const data = (await res.json()) as Status & { error?: string; detail?: string };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? "Could not connect." });
      } else {
        setStatus(data);
        setKey("");
        setMessage({ ok: true, text: data.detail ?? "OpenRouter connected." });
      }
    } catch (err) {
      setMessage({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/openrouter/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(key.trim() ? { key: key.trim() } : {}),
      });
      const data = (await res.json()) as { ok: boolean; detail: string; error?: string };
      setMessage({ ok: Boolean(data.ok), text: data.detail ?? data.error ?? "" });
    } catch (err) {
      setMessage({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/settings/openrouter", { method: "DELETE" });
      setStatus((await res.json()) as Status);
      setMessage({ ok: true, text: "Disconnected." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="text-[13px] font-semibold text-ink">OpenRouter</h2>
      <p className="mb-2.5 mt-0.5 text-[12px] text-muted">
        Connect your own key to use real models. Without one, dotAI runs in mock mode.
      </p>

      <div className="rounded-xl bg-surface hairline p-3.5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {status?.connected ? (
            <>
              <StatusPill tone="ok" icon={<Check className="h-3 w-3" />}>
                Connected
              </StatusPill>
              <span className="text-[12px] text-muted">
                key ending ····{status.hint}
                {status.source === "env" && " (from .env)"}
              </span>
            </>
          ) : (
            <StatusPill tone="neutral" icon={<Plug className="h-3 w-3" />}>
              Not connected
            </StatusPill>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-or-..."
            autoComplete="off"
            spellCheck={false}
            className="min-w-[220px] flex-1 rounded-lg bg-canvas hairline px-3 py-2 text-[13px] text-ink outline-none placeholder:text-muted/60 focus-ring"
          />
          <Button size="sm" onClick={() => void connect()} disabled={busy || key.trim().length < 10}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {status?.connected ? "Replace key" : "Connect"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void test()} disabled={busy}>
            Test connection
          </Button>
          {status?.connected && status.source === "stored" && (
            <Button size="sm" variant="danger" onClick={() => void disconnect()} disabled={busy}>
              <X className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          )}
        </div>

        {message && (
          <p className={`mt-2 text-[12px] ${message.ok ? "text-ok" : "text-danger"}`}>
            {message.text}
          </p>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-muted/70">
          Your key is validated, then encrypted at rest on this machine. It is
          never sent to the browser, never written to logs, and never included
          in a prompt or sent to the CAI classifier.
        </p>
      </div>
    </section>
  );
}
