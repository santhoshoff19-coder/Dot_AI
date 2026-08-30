# dotAI

**Which AI should handle this?**

dotAI finds the right model, verifies the result, and controls what happens next.

It is a model-agnostic chat interface with a control layer between the model's
output and its consequence. The chat stays simple; the control layer appears
progressively and only when it has something to say.

---

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. It redirects to `/chat`.

No API key is needed. `MOCK_MODE=true` is the default and the whole application —
routing, generation, verification, decisions, the Action Gate — runs offline.

`npm run dev` runs `prisma db push` first, so the SQLite database creates itself.

---

## Environment

`.env` (already present; copy from `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | SQLite location |
| `MOCK_MODE` | `true` | Run without any provider |
| `OPENROUTER_API_KEY` | *(empty)* | Required only in real mode |

The key is read **server-side only** and never reaches the browser.

### Mock mode (default)

```env
MOCK_MODE=true
```

Generation, cost and verification are simulated. Usage figures are labelled
*simulated* in the UI and no real savings are claimed.

### Real mode

```env
MOCK_MODE=false
OPENROUTER_API_KEY=sk-or-v1-...
```

Requests go to OpenRouter using the model IDs in `lib/models/registry.ts`
(`openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `openai/o1`). Cost comes
from the gateway's own usage figures where available, falling back to registry
pricing. If `MOCK_MODE=false` but no key is set, dotAI stays in mock mode rather
than failing at request time.

---

## Commands

```bash
npm run dev        # dev server (auto-creates the database)
npm run build      # production build
npm start          # serve the production build
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest — 52 tests
npm run db:push    # re-sync the schema
```

---

## Demo scenarios

Four buttons under the composer on the empty chat screen run these directly.

| # | Prompt | What happens | Decision |
|---|---|---|---|
| **A** | *What is John's account balance?* | Model says **$8,420**; the ledger says **$6,420**. Regenerates, escalates model, still conflicts. | `HOLD` |
| **B** | *Summarize this short document…* | Fast Router recognises summarisation — **CAI skipped**, cheapest capable model. | `ALLOW` |
| **C** | *Send John's account number to an external email* | PII + external destination + policy. | `BLOCK` |
| **D** | *Approve a $50,000 payment* | **High-risk policy route** — CAI skipped, deep verification forced, Action Gate stops at the policy stage. | `HOLD` → human review |
| **E** | *Analyze this acquisition proposal, compare assumptions and recommend…* | Fast Router confidence ~0.48 → **CAI used** → complex reasoning → strongest model. | `ALLOW` |
| **F** | *Translate this paragraph to French* | Fast Router confidence ~0.96 → **CAI skipped**. | `ALLOW` |

Click the **ControlPlane** strip under any answer to open Control Details.
For **A** and **D**, click **Open review** to approve, edit or reject — every
human decision is written to the audit log.

---

## Architecture

```
USER
 ↓
FAST ROUTER                    lib/routing/fast-router.ts     (free, deterministic)
 ├── obvious + ordinary   → DIRECT ROUTE          CAI skipped
 ├── obvious + dangerous  → HIGH-RISK POLICY      CAI skipped
 └── ambiguous            → CAI                   lib/cai/service.ts
 ↓                             seven controlled fields, Zod-validated
MODEL INTELLIGENCE DB          lib/models/intelligence.ts
 ↓                             OpenRouter facts + dotAI capability, kept apart
CAPABILITY FILTER              lib/capability/matching.ts
 ↓                             input + output modality are HARD constraints
MODEL SCORING ENGINE           lib/models/scoring.ts
 ↓                             RECOMMENDED · BEST · ALTERNATIVE
USER CHOICE / AUTO MODE
 ↓
GENERATION                     lib/providers/    (OpenRouter | Mock)
 ↓                             output is UNVERIFIED
CONTROLPLANE CHECKER
 ├── PERFORMANCE               lib/performance/  calculator → retrieval → evidence → calibration
 ├── COST                      lib/cost/         actual vs CAI estimate
 └── RESPONSIBILITY            lib/responsibility/ privacy · safety · fairness · policy · security
 ↓
DECISION ENGINE                lib/decision/     ALLOW · ANNOTATE · REGENERATE · HOLD · BLOCK
 ↓
ACTION GATE                    lib/action-gate/  intent → permission → risk → policy → parameters → execute
 ↓
USER / EXTERNAL ACTION
 ↓
AUDIT + LEARNING               lib/audit/  lib/learning/
```

### Routing: three levels of intelligence

**"Do not spend money to decide something the system already knows."**

CAI is an intelligence *fallback*, not a mandatory step.

| Level | What runs | Cost |
|---|---|---|
| **1. Fast Router** | Deterministic patterns, modality detection, risk detection, confidence score | free |
| **2. CAI** | Cheap classifier model (`CAI_MODEL`) — only when confidence is low | ~$0.0001 |
| **3. Model Scoring** | Ranks candidates by expected value; returns three options | free |

Thresholds live in `lib/routing/routing-config.ts` and are overridable by env
var — they are prototype defaults, not universal truths.

**CAI never selects the model.** It answers *"what does this task require?"*;
the ModelScoringEngine decides *"which model should run it"*.

### The three options

- **RECOMMENDED** — the lowest-cost model with a high enough probability of
  succeeding. Not the cheapest: a cheap model that fails is paid for twice.
- **BEST** — the highest-capability model suitable for the task.
- **ALTERNATIVE** — a third viable option, preferring the user's previous pick.

Scoring is `success × taskValue − cost − expectedRetryCost`, in
`lib/models/scoring.ts`, deliberately modular so the formula can improve.
Reliability is tracked per **MODEL × TASK**, never as one universal
intelligence score, and only influences routing past `RELIABILITY_MIN_SAMPLE`
observed runs.

### Auto mode

**Auto** (default) runs the recommended model immediately. Toggle it off in the
chat header or Settings and dotAI shows the three options and generates nothing
until you choose. The active mode is always visible in the header.

### Four design decisions

**1. Detection is separate from decision.** Detectors report *what* was found;
the Decision Engine decides what happens. The same finding produces a different
outcome depending on consequence — an account number is `PERMITTED` internally
and `PROHIBITED` to an external recipient.

**2. Risk sets verification depth.** `light` runs deterministic checks only and
never retrieves or calls a second model. `standard` adds evidence grounding.
`deep` adds review and can route to a human. Ordinary chat costs nothing extra.

**3. Deterministic first, with early exit.** A calculator or a DLP rule settles
most questions outright. When a deterministic check is decisive, the ladder
stops immediately.

**4. The gate only ever escalates.** The Action Gate can make an outcome
stricter, never softer — a `BLOCK` from the checker is not relaxed to a `HOLD`.

---

## Routes

`/chat` · `/control` · `/history` · `/usage` · `/settings`

**API:** `/api/chat` (NDJSON stream) · `/api/cai` · `/api/attachments` ·
`/api/transcribe` · `/api/control` · `/api/action` · `/api/audit` · `/api/usage` ·
`/api/conversations[/:id]`

---

## Composer

Multi-line input, **Enter** to send, **Shift+Enter** for a newline, file
attachment, drag-and-drop, paste-an-image, voice input, and stop-generation.
Attachments show name, type and size with a remove button; images show a
thumbnail.

Uploads are capped at **15 MB**, restricted to an explicit MIME allowlist,
written with sanitised filenames, and never executed.

---

## Voice

`lib/voice/service.ts` wraps `MediaRecorder`. States: idle → recording →
processing → ready, with a live duration counter.

In **mock mode** the server returns a simulated transcript and the UI says so.
In **real mode** with no speech-to-text provider configured, `/api/transcribe`
returns an explicit `501` — dotAI never converts *"transcription unavailable"*
into invented text.

---

## Data model

SQLite via Prisma: `Conversation`, `Message`, `Attachment`, `ControlEvent`,
`AuditEvent`, `LearningRecord`.

Hidden chain-of-thought is never stored or displayed. The UI shows *"Generating"*
and *"ControlPlane checking"*, never internal reasoning.

---

## Model intelligence

`/models` shows the catalog: OpenRouter facts on the left, dotAI's learned data
on the right, never mixed.

**Seven controlled fields** — effort, reasoning, context handling, instruction
complexity, reliability, tool capability, output capability. CAI produces them
directly under a strict Zod schema; an invented value such as `VERY_HIGH` is
rejected, retried once, then replaced by the deterministic classifier. Nothing
malformed reaches model selection.

**Capability filter** — ordered fields qualify on `capability >= requirement`.
Input *and* output modality are hard constraints evaluated first: a text-only
model is eliminated for a vision task, and never appears as a recommendation
for image generation regardless of price.

**Automatic assessment** — newly synced models are assessed from provider
metadata (modalities, context window, supported parameters) and marked
`DIRECT_PROVIDER_DATA`. Reasoning is only claimed HIGH when the provider
exposes reasoning controls, and **reliability is never inferred from metadata**
— it starts MEDIUM and moves only on observed outcomes. Where evidence is too
sparse the model stays `UNASSESSED` and out of recommendation rather than
being guessed at.

**Feedback** — every generation writes a `ModelOutcome` with an explicit
category. Capability changes require `MIN_CAPABILITY_UPDATE_SAMPLES` (5) of
evidence and are written to `ModelCapabilityRevision`, so the history is
auditable. A provider outage records `PROVIDER_FAILURE` and never downgrades a
model's reasoning.

## Modality-aware generation

The required output modality selects the provider method:

| Task | Route |
|---|---|
| Text out | `generateText()` — streaming chat completions |
| Image in, text out | `generateText()` on a vision-capable model |
| Image out | `generateImage()` — OpenRouter `POST /api/v1/images`, falling back to `chat/completions` with `modalities: ["image","text"]` |
| Audio / video out | Detected, filtered, then an explicit `UnsupportedModalityError` — never a silent fall back to text |

## CAI benchmark

`POST /api/cai/benchmark` runs 20 representative cases against candidate
models and persists the run. The cheapest candidate clearing every threshold
(`MIN_CAI_ACCURACY`, `MIN_CAI_SCHEMA_SUCCESS`, `MAX_CAI_LATENCY`,
`MAX_CAI_COST_PER_REQUEST`) wins — cost alone never does. Without a key the run
is labelled `MOCK` and measures the deterministic classifier, which is not
evidence about any provider model.

## Known limitations

- **The verifier model rung is not wired.** The performance ladder runs
  calculator → retrieval → evidence → calibration. An independent verifier LLM
  is a designed rung but is not implemented; `deep` currently adds a review pass
  rather than a second model.
- **Retrieval is keyword overlap**, not embeddings. `RetrievalService` is an
  interface with a local implementation and a small seed corpus; a vector store
  drops in behind it.
- **Comparative fairness is text-only.** Stereotype detection works; comparing
  outcomes across equivalent cases needs historical decision data.
- **Image generation is unproven against a live provider.** The OpenRouter
  request shape follows the current documented API, but with no key only the
  mock path has run. Mock output is a generated SVG, always flagged
  `simulated: true` — never passed off as a provider image.
- **The CAI benchmark has only run in mock mode**, so its numbers describe the
  fallback classifier, not any model.
- **Audio and video generation are not implemented.** They are classified and
  filtered correctly, then rejected with a clear error.
- **Actions are simulated.** The Action Gate evaluates fully and reports the
  stage that settled it, but no external system is contacted.
- **Single local user.** No authentication; the actor is a fixed
  `support_agent` with a fixed permission set.
- **Learning records outcomes but does not yet retrain routing.** Reliability is
  tracked per model and surfaced on `/usage`; routing weights are not adjusted
  until a model passes the minimum sample size, and that step is not built.
- **Documents are read as plain text.** PDF and DOCX upload and store correctly
  but their text is not extracted for grounding.
