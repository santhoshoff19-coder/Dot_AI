"use client";

import {
  AlertTriangle, ChevronDown, FileText, Loader2, Trash2, Upload,
} from "lucide-react";
import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { StatusPill, type Tone } from "@/components/ui/status-pill";
import {
  APPLIES_TO_LABEL, appliesToLabel, POLICY_TYPE_LABEL, policyTypeLabel,
} from "@/lib/ui/labels";
import { cn } from "@/lib/utils";

interface PolicyDoc {
  id: string; name: string; jurisdiction: string; regulation: string;
  version: string; status: string; isDemo: boolean;
  _count: { chunks: number };
}

interface IndexedSection {
  id: string; section: string; text: string; category: string;
  embeddingModel: string;
}

/** ACTIVE means indexed and retrievable; anything else is not. */
const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "ok", PROCESSING: "warn", FAILED: "danger", SUPERSEDED: "neutral",
};

// Display labels come from the shared vocabulary; the stored values are
// unchanged. Retrieval filters, the policy engine and every recorded decision
// depend on them, and renaming them would invalidate historical evidence.

export default function PolicyPage() {
  const [docs, setDocs] = React.useState<PolicyDoc[]>([]);
  const [notice, setNotice] = React.useState("");
  // Three distinct states. Without them an empty list looked identical to a
  // list that had failed to load, and to one still loading.
  const [loadState, setLoadState] = React.useState<"loading" | "ready" | "error">("loading");

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/policy/documents");
      if (!res.ok) { setLoadState("error"); return; }
      const d = (await res.json()) as { documents: PolicyDoc[]; notice: string };
      setDocs(d.documents);
      setNotice(d.notice);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Policy & Governance"
        subtitle="Your policy documents become a searchable knowledge source ControlPlane checks requests and responses against."
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mx-auto max-w-5xl space-y-6">
          {notice && (
            <div className="rounded-xl border border-warn/25 bg-warn/5 px-4 py-3">
              <p className="text-[12px] leading-relaxed text-warn">{notice}</p>
            </div>
          )}

          {/* policy packs */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted">
              <FileText className="h-3.5 w-3.5" /> Policy documents
            </h2>
            <ReindexBar />
            <div className="space-y-2">
              {loadState === "loading" && (
                <p className="flex items-center gap-1.5 rounded-xl bg-surface hairline p-4 text-[13px] text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading your policy documents…
                </p>
              )}

              {loadState === "error" && (
                <div className="rounded-xl border border-danger/25 bg-danger/5 p-4">
                  <p className="text-[13px] text-danger">
                    We couldn’t load your policy documents.
                  </p>
                  <Button size="sm" variant="secondary" className="mt-2"
                    onClick={() => void refresh()}>
                    Try again
                  </Button>
                </div>
              )}

              {loadState === "ready" && docs.map((d) => (
                <PolicyCard key={d.id} doc={d} onChanged={refresh} />
              ))}
              {loadState === "ready" && docs.length === 0 && (
                <EmptyState onRestored={refresh} />
              )}
            </div>
          </section>

          {/* upload */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted">
              <Upload className="h-3.5 w-3.5" /> Add policy document
            </h2>
            <UploadPanel onDone={refresh} />
          </section>
        </div>
      </div>
    </div>
  );
}

function Select({
  label, value, options, labels, onChange,
}: {
  label: string; value: string; options: string[];
  labels?: Record<string, string>; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 rounded-lg bg-elevated hairline px-2.5 py-1.5">
      <span className="text-[11px] text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-[12px] text-ink outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-surface text-ink">
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Ingests a real policy document. The same extractor the chat pipeline uses
 * reads it, so an unreadable file is rejected rather than stored empty.
 */
function UploadPanel({ onDone }: { onDone: () => Promise<void> }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [regulation, setRegulation] = React.useState("INTERNAL");
  const [jurisdiction, setJurisdiction] = React.useState("GLOBAL");
  const [version, setVersion] = React.useState("1.0");
  // Distinct phases, because "uploading" and "indexing" fail for different
  // reasons and a single spinner tells the user nothing about which.
  const [phase, setPhase] = React.useState<
    "idle" | "uploading" | "indexing" | "done" | "error">("idle");
  const [message, setMessage] = React.useState<string | null>(null);
  const busy = phase === "uploading" || phase === "indexing";

  const upload = async () => {
    if (!file) return;
    setPhase("uploading");
    setMessage(null);

    try {
      const form = new FormData();
      form.set("file", file);
      form.set("regulation", regulation);
      form.set("jurisdiction", jurisdiction);
      form.set("version", version);
      form.set("name", file.name);

      // Extraction and embedding both happen server-side in this call.
      setPhase("indexing");
      const res = await fetch("/api/policy/upload", { method: "POST", body: form });
      const body = await res.json();

      if (!res.ok) {
        setPhase("error");
        setMessage(errorFor(res.status, body));
        return;
      }

      setPhase("done");
      setMessage(
        `Policy document uploaded and indexed — ${body.fileName} became ${
          body.chunks} indexed section(s).`);
      setFile(null);
      await onDone();
    } catch {
      setPhase("error");
      setMessage("The upload could not be completed. Check your connection and try again.");
    }
  };

  return (
    <div className="rounded-xl bg-surface hairline p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".pdf,.docx,.txt,.md,text/plain,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="max-w-[240px] text-[12px] text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-elevated file:px-2.5 file:py-1.5 file:text-[12px] file:text-ink"
        />
        <Select label="Policy type" value={regulation}
          options={["INTERNAL", "GDPR", "DPDP", "HIPAA", "SOX", "OTHER"]}
          labels={POLICY_TYPE_LABEL}
          onChange={setRegulation} />
        <Select label="Applies to" value={jurisdiction}
          options={["GLOBAL", "EU", "IN", "US"]}
          labels={APPLIES_TO_LABEL}
          onChange={setJurisdiction} />
        <label className="flex items-center gap-1.5 rounded-lg bg-elevated hairline px-2.5 py-1.5">
          <span className="text-[11px] text-muted">Policy version</span>
          <input value={version} onChange={(e) => setVersion(e.target.value)}
            className="w-16 bg-transparent text-[12px] text-ink outline-none" />
        </label>
        <Button size="sm" onClick={() => void upload()} disabled={busy || !file}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Upload &amp; Index
        </Button>
      </div>
      {busy && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {phase === "uploading" ? "Uploading the file…"
            : "Extracting text and building indexed sections…"}
        </p>
      )}

      {!busy && message && (
        <p className={`mt-2 text-[12px] ${phase === "done" ? "text-ok" : "text-danger"}`}>
          {message}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-muted/70">
        PDF, DOCX, TXT and MD are read with the same extractor the chat pipeline uses.
        A scanned document with no text layer is rejected rather than stored empty.
      </p>
    </div>
  );
}

/**
 * Shows which embedding model the corpus is indexed with, and allows a
 * re-index. Vectors from different models are not comparable, so a mixed
 * corpus quietly degrades retrieval until it is rebuilt.
 */
function ReindexBar() {
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<
    { reindexed: number; model: string; mode: string } | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/policy/reindex", { method: "POST" });
      if (res.ok) setResult(await res.json());
    } finally { setBusy(false); }
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-elevated px-3 py-2">
      <span className="text-[11px] text-muted">
        Upload a document → text is extracted → split into sections → indexed →
        relevant sections are retrieved when a request needs them.
      </span>
      <Button size="sm" variant="ghost" className="ml-auto"
        onClick={() => void run()} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Re-index embeddings
      </Button>
      {result && (
        <span className="text-[11px] text-ok">
          {result.reindexed} chunks with {result.model} ({result.mode})
        </span>
      )}
    </div>
  );
}

/**
 * One policy document, with its indexed sections viewable in place and a
 * delete that genuinely removes it from retrieval.
 */
function PolicyCard({ doc, onChanged }: {
  doc: PolicyDoc; onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [sections, setSections] = React.useState<IndexedSection[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const view = async () => {
    const next = !open;
    setOpen(next);
    if (!next || sections) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/policy/documents/${doc.id}`);
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not load the indexed sections.");
        return;
      }
      setSections(body.document.chunks as IndexedSection[]);
    } catch {
      setError("Could not load the indexed sections.");
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/policy/documents/${doc.id}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not delete this policy.");
        return;
      }
      await onChanged();
    } catch {
      setError("Could not delete this policy.");
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="rounded-xl bg-surface hairline p-3.5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-[200px] flex-1">
          <p className="text-[13px] font-medium text-ink">{doc.name}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusPill tone="accent">{policyTypeLabel(doc.regulation)}</StatusPill>
            <StatusPill tone="neutral">{appliesToLabel(doc.jurisdiction)}</StatusPill>
            <StatusPill tone={doc.isDemo ? "warn" : "ok"}>
              {doc.isDemo ? "DEMO" : "YOUR POLICY"}
            </StatusPill>
            <StatusPill tone={STATUS_TONE[doc.status] ?? "neutral"}>{doc.status}</StatusPill>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => void view()}>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
            View
          </Button>
          <Button size="sm" variant="danger"
            onClick={() => setConfirming(true)} disabled={deleting}>
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Trash2 className="h-3.5 w-3.5" />}
            Delete
          </Button>
        </div>
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-2.5 sm:grid-cols-4">
        <Detail label="Policy type" value={policyTypeLabel(doc.regulation)} />
        <Detail label="Applies to" value={appliesToLabel(doc.jurisdiction)} />
        <Detail label="Policy version" value={doc.version} />
        <Detail label="Indexed sections" value={String(doc._count.chunks)} />
      </dl>

      {confirming && (
        <div className="mt-2.5 rounded-lg border border-danger/30 bg-danger/5 p-2.5">
          <p className="mb-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Delete “{doc.name}”? This removes the policy document and its{" "}
            {doc._count.chunks} indexed section(s) from Policy RAG, and cannot
            be undone. Decisions already made keep the evidence they recorded.
          </p>
          <div className="flex gap-1.5">
            <Button size="sm" variant="danger" onClick={() => void remove()} disabled={deleting}>
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Delete permanently
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}

      {open && (
        <div className="mt-2.5 space-y-1.5 border-t border-line pt-2.5">
          {loading && (
            <p className="flex items-center gap-1.5 text-[12px] text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading indexed sections…
            </p>
          )}
          {!loading && sections?.length === 0 && (
            <p className="text-[12px] text-muted">
              This document has no indexed sections, so it cannot be retrieved.
            </p>
          )}
          {sections?.map((sec) => (
            <div key={sec.id} className="rounded-lg bg-elevated p-2.5">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] font-medium text-ink">{sec.section}</span>
                <StatusPill tone="neutral">{sec.category}</StatusPill>
                <span className="ml-auto text-[10px] text-muted">{sec.embeddingModel}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted">{sec.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="text-[12px] text-ink">{value}</dd>
    </div>
  );
}

/** Shown when nothing is indexed - retrieval has nothing to draw on. */
function EmptyState({ onRestored }: { onRestored: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);

  // Deleting the demo packs is permanent, so bringing them back has to be
  // something the user asks for rather than something that happens to them.
  const restore = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/policy/reseed", { method: "POST" });
      if (res.ok) await onRestored();
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl bg-surface hairline p-6 text-center">
      <FileText className="mx-auto mb-2 h-6 w-6 text-muted" />
      <p className="text-[14px] text-ink">No policy documents have been added yet.</p>
      <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-muted">
        Upload your company’s policies, compliance documents or internal
        guidelines to make them searchable by Policy RAG. Until something is
        indexed, governed actions are held rather than approved.
      </p>
      <Button size="sm" variant="ghost" className="mt-3"
        onClick={() => void restore()} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Restore demo policy packs
      </Button>
    </div>
  );
}

/** Turns a failed upload into something the user can act on. */
function errorFor(status: number, body: { error?: string; detail?: string }): string {
  if (status === 413) return "That file is larger than the 10 MB limit.";
  if (status === 415) return "That file type cannot be read. Use PDF, DOCX, TXT or MD.";
  if (status === 422) {
    return body.detail ??
      "No text could be extracted. A scanned document needs OCR before it can be indexed.";
  }
  if (status === 400) return body.error ?? "The upload was rejected. Check the fields and try again.";
  return body.error ?? "Indexing failed. The file was not added.";
}
