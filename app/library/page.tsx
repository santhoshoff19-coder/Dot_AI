"use client";

import {
  ChevronDown, Loader2, MessageSquare, Paperclip, Pencil, Play, Plus,
  Search, Star, Trash2, X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { stageHandoff } from "@/lib/library/handoff";
import type { AttachmentRef } from "@/types";
import {
  categoryLabel, defaultSpecialization, EXPERIENCE_LEVELS, isValidSpecialization,
  ROLES, specializationsFor,
} from "@/lib/library/taxonomy";
import { cn } from "@/lib/utils";

interface Variable {
  id?: string;
  name: string;
  label: string;
  description: string;
  type: string;
  required: boolean;
  defaultValue: string;
  options: string;
  order: number;
}

interface Prompt {
  id: string;
  title: string;
  description: string;
  category: string;
  template: string;
  inputModality: string;
  outputModality: string;
  version: number;
  usageCount: number;
  isFavorite?: boolean;
  variables: Variable[];
  /** Present on recommended prompts: why this one is near the top. */
  whyRecommended?: string;
}

interface Profile {
  designation: string;
  specialization: string;
  experience: string;
}

interface LibraryData {
  prompts: Prompt[];
  recommended: Prompt[];
  profile: Profile | null;
  categories: string[];
  variableTypes: string[];
}

// The taxonomy lives in one module. Re-declaring it here is what let the UI
// offer specializations the ranking code had never heard of.
const DESIGNATIONS = [...ROLES];
const EXPERIENCE = [...EXPERIENCE_LEVELS];

export default function LibraryPage() {
  const router = useRouter();
  const [data, setData] = React.useState<LibraryData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState<"ALL" | "FAVORITES" | "RECENT">("ALL");
  const [category, setCategory] = React.useState("ALL");

  const [editing, setEditing] = React.useState<Prompt | "NEW" | null>(null);
  const [using, setUsing] = React.useState<Prompt | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, filter, category });
      const res = await fetch(`/api/library?${params}`);
      if (res.ok) setData((await res.json()) as LibraryData);
      else setError("Could not load the library.");
    } catch {
      setError("Could not load the library.");
    } finally {
      setLoading(false);
    }
  }, [q, filter, category]);

  React.useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const toggleFavorite = async (id: string) => {
    await fetch(`/api/library/${id}/favorite`, { method: "POST" });
    await load();
  };

  const remove = async (p: Prompt) => {
    if (!confirm(`Delete "${p.title}"? Past runs of it are kept.`)) return;
    await fetch(`/api/library/${p.id}`, { method: "DELETE" });
    await load();
  };

  const shown = filter === "ALL" && !q && category === "ALL" && data?.recommended.length
    ? data.recommended
    : data?.prompts ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Library"
        subtitle="Your prompts. Each one runs through the same checks as anything you type."
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mx-auto max-w-5xl space-y-5">
          <ProfileBar profile={data?.profile ?? null} onSaved={load} />

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg bg-elevated hairline px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search your prompts"
                className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-muted/70"
              />
            </div>
            <Button size="sm" onClick={() => setEditing("NEW")}>
              <Plus className="h-3.5 w-3.5" /> Create Prompt
            </Button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(["ALL", "FAVORITES", "RECENT"] as const).map((f) => (
              <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
                {f === "ALL" ? "All" : f === "FAVORITES" ? "Favorites" : "Recent"}
              </Chip>
            ))}
            <span className="mx-1 w-px bg-line" />
            <Chip active={category === "ALL"} onClick={() => setCategory("ALL")}>All categories</Chip>
            {(data?.categories ?? []).map((c) => (
              <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
                {categoryLabel(c)}
              </Chip>
            ))}
          </div>

          {error && <p className="text-[13px] text-danger">{error}</p>}

          {loading && !data && <p className="text-[13px] text-muted">Loading…</p>}

          {!loading && shown.length === 0 && (
            <div className="rounded-xl bg-surface hairline p-8 text-center">
              <p className="text-[14px] text-ink">No prompts yet.</p>
              <p className="mt-1 text-[12px] text-muted">
                Create one with placeholders like <code>{"{TOPIC}"}</code> and the
                fields appear automatically.
              </p>
              <Button size="sm" className="mt-3" onClick={() => setEditing("NEW")}>
                <Plus className="h-3.5 w-3.5" /> Create your first prompt
              </Button>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {shown.map((p) => (
              <div key={p.id} className="flex flex-col rounded-xl bg-surface hairline p-4">
                <div className="mb-1 flex items-start gap-2">
                  <span className="flex-1 text-[14px] font-medium text-ink">{p.title}</span>
                  <button
                    onClick={() => void toggleFavorite(p.id)}
                    title={p.isFavorite ? "Remove favorite" : "Add favorite"}
                    className="focus-ring rounded p-0.5"
                  >
                    <Star className={cn("h-4 w-4",
                      p.isFavorite ? "fill-warn text-warn" : "text-muted")} />
                  </button>
                </div>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <StatusPill tone="accent">{categoryLabel(p.category)}</StatusPill>
                  {p.variables.length > 0 && (
                    <StatusPill tone="neutral">
                      {p.variables.length} field{p.variables.length === 1 ? "" : "s"}
                    </StatusPill>
                  )}
                  {p.usageCount > 0 && (
                    <StatusPill tone="neutral">used {p.usageCount}×</StatusPill>
                  )}
                </div>
                <p className="mb-2 flex-1 text-[12px] leading-relaxed text-muted">
                  {p.description || "No description."}
                </p>
                {p.whyRecommended && (
                  <p className="mb-3 text-[11px] leading-relaxed text-accent-soft">
                    {p.whyRecommended}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => setUsing(p)}>
                    <Play className="h-3.5 w-3.5" /> Use Prompt
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void remove(p)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {editing && (
        <EditorModal
          prompt={editing === "NEW" ? null : editing}
          categories={data?.categories ?? []}
          variableTypes={data?.variableTypes ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}

      {using && (
        <RunModal
          prompt={using}
          onClose={() => setUsing(null)}
          onRun={(filled, attachments, conversationId) => {
            // Hand off to the normal chat pipeline - Library never executes a
            // model itself. The payload is staged rather than passed in the
            // URL: a query string cannot carry an uploaded file, and the old
            // `?prompt=` parameter was never read by chat, so the filled
            // prompt was silently dropped on arrival.
            stageHandoff({
              prompt: filled,
              attachments,
              libraryPromptId: using.id,
              outputModality: using.outputModality,
            });
            setUsing(null);
            router.push(conversationId ? `/chat?c=${conversationId}` : "/chat");
          }}
        />
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-lg px-2.5 py-1 text-[12px] transition-colors focus-ring hairline",
        active ? "border-accent/50 bg-accent/10 text-ink" : "bg-surface text-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function ProfileBar({ profile, onSaved }: {
  profile: Profile | null; onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(!profile);
  const [designation, setDesignation] = React.useState(profile?.designation ?? "Student");
  const [specialization, setSpecialization] = React.useState(
    profile?.specialization ?? defaultSpecialization(profile?.designation ?? "Student"));
  const [experience, setExperience] = React.useState(profile?.experience ?? "Beginner");
  const [saving, setSaving] = React.useState(false);

  const specializations = specializationsFor(designation);

  /**
   * Changing role rewrites the specialization list. A value that no longer
   * applies is replaced rather than left behind, so what is on screen is
   * always what will be saved.
   */
  const changeRole = (role: string) => {
    setDesignation(role);
    if (!isValidSpecialization(role, specialization)) {
      setSpecialization(defaultSpecialization(role));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/library/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ designation, specialization, experience }),
      });
      setOpen(false);
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface hairline px-3 py-2">
        <span className="text-[11px] text-muted">Recommendations tuned for</span>
        <StatusPill tone="accent">{profile?.designation}</StatusPill>
        <StatusPill tone="neutral">{profile?.specialization}</StatusPill>
        <StatusPill tone="neutral">{profile?.experience}</StatusPill>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(true)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-surface hairline p-3.5">
      <p className="mb-2 text-[13px] font-medium text-ink">Tell us who you are</p>
      <p className="mb-3 text-[12px] text-muted">
        This orders your recommendations and sets the level explanations are
        written at. It never changes what you ask for.
      </p>
      <div className="flex flex-wrap gap-2">
        <Field label="Role" value={designation} options={DESIGNATIONS} onChange={changeRole} />
        <Field label="Specialization" value={specialization}
          options={specializations} onChange={setSpecialization} />
        <Field label="Experience" value={experience} options={EXPERIENCE} onChange={setExperience} />
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Save
        </Button>
      </div>
    </div>
  );
}

function Field({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
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
          <option key={o} value={o} className="bg-surface text-ink">{o}</option>
        ))}
      </select>
    </label>
  );
}

function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="my-8 w-full max-w-2xl rounded-2xl bg-surface hairline p-5">
        <div className="mb-4 flex items-center">
          <h2 className="flex-1 text-[15px] font-medium text-ink">{title}</h2>
          <button onClick={onClose} className="focus-ring rounded p-1 text-muted hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EditorModal({ prompt, categories, variableTypes, onClose, onSaved }: {
  prompt: Prompt | null;
  categories: string[];
  variableTypes: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = React.useState(prompt?.title ?? "");
  const [description, setDescription] = React.useState(prompt?.description ?? "");
  const [category, setCategory] = React.useState(prompt?.category ?? "OTHER");
  const [template, setTemplate] = React.useState(prompt?.template ?? "");
  const [inputModality, setInputModality] = React.useState(prompt?.inputModality ?? "TEXT");
  const [outputModality, setOutputModality] = React.useState(prompt?.outputModality ?? "TEXT");
  const [detected, setDetected] = React.useState<{ name: string }[]>([]);
  const [issues, setIssues] = React.useState<{ detail: string }[]>([]);
  const [types, setTypes] = React.useState<Record<string, string>>({});
  const [options, setOptions] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Variables are parsed by the same server-side parser the pipeline uses, so
  // the preview cannot drift from what actually runs.
  React.useEffect(() => {
    const t = setTimeout(() => {
      void (async () => {
        const res = await fetch("/api/library", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ template }),
        });
        if (res.ok) {
          const parsed = await res.json();
          setDetected(parsed.variables ?? []);
          setIssues(parsed.issues ?? []);
        }
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [template]);

  React.useEffect(() => {
    if (!prompt) return;
    const t: Record<string, string> = {};
    const o: Record<string, string> = {};
    for (const v of prompt.variables) {
      t[v.name] = v.type;
      try {
        const parsed = JSON.parse(v.options) as string[];
        if (parsed.length) o[v.name] = parsed.join(", ");
      } catch { /* ignore */ }
    }
    setTypes(t);
    setOptions(o);
  }, [prompt]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const variables = detected.map((d) => ({
        name: d.name,
        type: types[d.name] ?? undefined,
        options: (options[d.name] ?? "")
          .split(",").map((s) => s.trim()).filter(Boolean),
      }));
      const body = {
        title, description, category, template,
        inputModality, outputModality, variables,
      };
      const res = await fetch(prompt ? `/api/library/${prompt.id}` : "/api/library", {
        method: prompt ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json();
        setError(e.error ?? "Could not save.");
        return;
      }
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={prompt ? "Edit prompt" : "Create prompt"} onClose={onClose}>
      <div className="space-y-3">
        <Input label="Title" value={title} onChange={setTitle} placeholder="Review My Code" />
        <Input label="Description" value={description} onChange={setDescription}
          placeholder="Review code for bugs, security and performance." />

        <div className="flex flex-wrap gap-2">
          <Field label="Category" value={category} options={categories} onChange={setCategory} />
          <Field label="Input" value={inputModality}
            options={["TEXT", "IMAGE", "DOCUMENT"]} onChange={setInputModality} />
          <Field label="Output" value={outputModality}
            options={["TEXT", "IMAGE", "DOCUMENT"]} onChange={setOutputModality} />
        </div>

        <label className="block">
          <span className="mb-1 block text-[11px] text-muted">
            Template — wrap any variable in braces, e.g. {"{TOPIC}"}
          </span>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={7}
            placeholder={"Explain {TOPIC} to a {AUDIENCE} using {STYLE}."}
            className="w-full rounded-lg bg-canvas hairline px-3 py-2 font-mono text-[12px] text-ink outline-none focus-ring"
          />
        </label>

        <div className="rounded-lg bg-elevated p-3">
          <p className="mb-2 text-[11px] uppercase tracking-wider text-muted">
            Detected variables ({detected.length})
          </p>
          {detected.length === 0 && (
            <p className="text-[12px] text-muted">
              None yet. Anything in braces becomes an input field.
            </p>
          )}
          <div className="space-y-2">
            {detected.map((d) => (
              <div key={d.name} className="flex flex-wrap items-center gap-2">
                <StatusPill tone="accent">{d.name}</StatusPill>
                <select
                  value={types[d.name] ?? ""}
                  onChange={(e) => setTypes({ ...types, [d.name]: e.target.value })}
                  className="rounded-lg bg-surface hairline px-2 py-1 text-[12px] text-ink outline-none"
                >
                  <option value="">auto</option>
                  {variableTypes.map((t) => (
                    <option key={t} value={t} className="bg-surface">{t}</option>
                  ))}
                </select>
                {types[d.name] === "SELECT" && (
                  <input
                    value={options[d.name] ?? ""}
                    onChange={(e) => setOptions({ ...options, [d.name]: e.target.value })}
                    placeholder="Beginner, Intermediate, Expert"
                    className="min-w-[200px] flex-1 rounded-lg bg-surface hairline px-2 py-1 text-[12px] text-ink outline-none"
                  />
                )}
              </div>
            ))}
          </div>
          {issues.length > 0 && (
            <p className="mt-2 text-[12px] text-danger">{issues[0].detail}</p>
          )}
        </div>

        {error && <p className="text-[12px] text-danger">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => void save()}
            disabled={saving || !title.trim() || !template.trim() || issues.length > 0}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {prompt ? "Save changes" : "Create prompt"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Variable types that need a file rather than typed text. */
const FILE_TYPES = ["FILE", "IMAGE", "DOCUMENT"];

const isFileVariable = (type: string) => FILE_TYPES.includes(type);

/** The accept filter for a variable, so an image field does not offer a PDF. */
function acceptFor(type: string): string {
  if (type === "IMAGE") return "image/*";
  if (type === "DOCUMENT") return ".pdf,.docx,.txt,.md,application/pdf";
  return "";
}

function RunModal({ prompt, onClose, onRun }: {
  prompt: Prompt;
  onClose: () => void;
  onRun: (filled: string, attachments: AttachmentRef[], conversationId: string | null) => void;
}) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  /** Uploaded files, keyed by variable name. */
  const [files, setFiles] = React.useState<Record<string, AttachmentRef>>({});
  const [uploading, setUploading] = React.useState<string | null>(null);

  const fileVariables = prompt.variables.filter((v) => isFileVariable(v.type));
  const hasFiles = Object.keys(files).length > 0;

  /**
   * Uploads through the same endpoint the chat composer uses, so a file
   * attached here is indistinguishable from one dragged into chat.
   */
  const upload = async (variableName: string, file: File) => {
    setUploading(variableName);
    setError(null);
    try {
      const form = new FormData();
      form.append("files", file);
      const res = await fetch("/api/attachments", { method: "POST", body: form });
      const body = await res.json() as {
        attachments?: AttachmentRef[]; errors?: string[]; error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Upload failed.");
      if (body.errors?.length) throw new Error(body.errors.join(" "));

      const saved = body.attachments?.[0];
      if (!saved) throw new Error("The file could not be read.");

      setFiles((prev) => ({ ...prev, [variableName]: saved }));
      // The filled prompt refers to the file by name; the file itself travels
      // as an attachment.
      setValues((prev) => ({ ...prev, [variableName]: saved.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  };

  const removeFile = (variableName: string) => {
    setFiles((prev) => {
      const next = { ...prev };
      delete next[variableName];
      return next;
    });
    setValues((prev) => ({ ...prev, [variableName]: "" }));
  };

  const run = async (conversationId: string | null) => {
    // A required file variable with no file is a missing value, and the
    // server cannot tell the difference between that and an empty string.
    const missingFile = fileVariables.find((v) => v.required && !files[v.name]);
    if (missingFile) {
      setError(`Please choose a file for ${missingFile.label || missingFile.name}.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/library/${prompt.id}/use`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const body = await res.json();
      if (!res.ok) {
        const missing = body.detail?.missing as string[] | undefined;
        setError(missing?.length
          ? `Please fill: ${missing.join(", ")}`
          : body.error ?? "Could not run this prompt.");
        return;
      }
      onRun(body.filledPrompt, Object.values(files), conversationId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={prompt.title} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-[12px] text-muted">{prompt.description}</p>

        {prompt.variables.length === 0 && (
          <p className="text-[12px] text-muted">
            This prompt has no variables — run it as is.
          </p>
        )}

        {/* Fields are generated from the stored variables, never hard-coded. */}
        {prompt.variables.map((v) => {
          const opts = safeParse(v.options);

          // A file variable needs a file. It used to render a text box with a
          // note telling the user to attach the file later in chat, which
          // meant the prompt ran against a filename typed as prose.
          if (isFileVariable(v.type)) {
            const chosen = files[v.name];
            return (
              <div key={v.name} className="block">
                <span className="mb-1 block text-[11px] text-muted">
                  {v.label || v.name}{v.required ? " *" : ""}
                  {v.description ? ` — ${v.description}` : ""}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      accept={acceptFor(v.type)}
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void upload(v.name, f);
                        e.target.value = "";
                      }}
                    />
                    <span className="flex items-center gap-1.5 rounded-lg bg-elevated hairline px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:border-accent/40">
                      {uploading === v.name
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Paperclip className="h-3.5 w-3.5" />}
                      {chosen ? "Choose a different file" : "Choose file"}
                    </span>
                  </label>

                  {chosen && (
                    <span className="flex min-w-0 items-center gap-1.5 rounded-lg bg-canvas hairline px-2.5 py-1.5 text-[12px]">
                      <span className="truncate text-ink">{chosen.name}</span>
                      <span className="shrink-0 text-[11px] text-muted">
                        {(chosen.size / 1024).toFixed(0)} KB
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFile(v.name)}
                        className="shrink-0 text-muted hover:text-danger focus-ring"
                        aria-label={`Remove ${chosen.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </div>
              </div>
            );
          }

          return (
            <label key={v.name} className="block">
              <span className="mb-1 block text-[11px] text-muted">
                {v.label || v.name}{v.required ? " *" : ""}
                {v.description ? ` — ${v.description}` : ""}
              </span>
              {v.type === "SELECT" && opts.length ? (
                <select
                  value={values[v.name] ?? v.defaultValue ?? ""}
                  onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
                  className="w-full rounded-lg bg-canvas hairline px-3 py-2 text-[13px] text-ink outline-none focus-ring"
                >
                  <option value="">Choose…</option>
                  {opts.map((o) => (
                    <option key={o} value={o} className="bg-surface">{o}</option>
                  ))}
                </select>
              ) : v.type === "LONG_TEXT" ? (
                <textarea
                  rows={5}
                  value={values[v.name] ?? v.defaultValue ?? ""}
                  onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
                  className="w-full rounded-lg bg-canvas hairline px-3 py-2 font-mono text-[12px] text-ink outline-none focus-ring"
                />
              ) : (
                <input
                  type={v.type === "NUMBER" ? "number" : "text"}
                  value={values[v.name] ?? v.defaultValue ?? ""}
                  onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
                  className="w-full rounded-lg bg-canvas hairline px-3 py-2 text-[13px] text-ink outline-none focus-ring"
                />
              )}
            </label>
          );
        })}

        {error && <p className="text-[12px] text-danger">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <span className="text-[11px] text-muted">
            {hasFiles
              ? "Opens in chat with the file attached. Nothing is sent until you press send."
              : "Opens in chat, filled in. Nothing is sent until you press send."}
          </span>

          {/*
            Once a file is attached the destination matters, so the chat is
            chosen explicitly. Choosing one navigates and prefills - it never
            sends, because picking a conversation is not consent to spend a
            model call.
          */}
          <ChatPicker
            busy={busy}
            label={fileVariables.length > 0 ? "Open in chat" : "Use prompt"}
            onPick={(conversationId) => void run(conversationId)}
          />
        </div>
      </div>
    </Modal>
  );
}

function Input({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg bg-canvas hairline px-3 py-2 text-[13px] text-ink outline-none placeholder:text-muted/60 focus-ring"
      />
    </label>
  );
}

function safeParse(raw: string): string[] {
  try {
    const p = JSON.parse(raw) as unknown;
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Chooses where a library prompt should land.
 *
 * Lists recent conversations plus a new chat. Selecting one navigates and
 * loads the prompt into the composer; it deliberately does not send. The
 * conversations are fetched when the menu opens rather than on mount, so a
 * user who never opens it costs nothing.
 */
function ChatPicker({ onPick, busy, label }: {
  onPick: (conversationId: string | null) => void;
  busy: boolean;
  label: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [chats, setChats] = React.useState<
    { id: string; title: string; updatedAt: string; messageCount: number }[]>([]);
  const [loading, setLoading] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;

    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);

    setLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/conversations");
        if (res.ok) {
          const d = await res.json() as { conversations?: typeof chats };
          setChats((d.conversations ?? []).slice(0, 8));
        }
      } catch {
        // A failed list is not a blocker: "New chat" always works.
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button size="sm" onClick={() => setOpen((v) => !v)} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
        {label}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </Button>

      {open && (
        <div className="absolute bottom-full right-0 z-20 mb-1 w-[280px] overflow-hidden rounded-xl bg-surface hairline shadow-lg">
          <button
            type="button"
            onClick={() => { setOpen(false); onPick(null); }}
            className="flex w-full items-center gap-2 border-b border-line px-3 py-2.5 text-left transition-colors hover:bg-elevated focus-ring"
          >
            <Plus className="h-3.5 w-3.5 text-accent-soft" />
            <span className="text-[12px] font-medium text-ink">New chat</span>
          </button>

          <p className="px-3 pt-2 text-[10px] uppercase tracking-wider text-muted">
            Recent chats
          </p>

          <div className="max-h-[220px] overflow-y-auto pb-1">
            {loading && (
              <p className="px-3 py-2 text-[12px] text-muted">Loading your chats…</p>
            )}
            {!loading && chats.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-muted">
                No previous chats yet.
              </p>
            )}
            {!loading && chats.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { setOpen(false); onPick(c.id); }}
                className="flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-elevated focus-ring"
              >
                <span className="w-full truncate text-[12px] text-ink">
                  {c.title || "Untitled chat"}
                </span>
                <span className="text-[10px] text-muted">
                  {c.messageCount} message{c.messageCount === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
