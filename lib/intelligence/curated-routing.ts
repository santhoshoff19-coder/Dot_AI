import {
  allListB, curatedDataset, eqForm, intelligenceFor, miniTaskById, modelById,
  inputForms, normaliseForm, outputFormsFor, subTasksForForms, CAPABILITY_PROVENANCE,
  type CuratedModel, type CuratedSubTask,
} from "@/lib/intelligence/curated-dataset";
import { CAI_MODEL, caiTimeoutMs } from "@/lib/cai/config";

/**
 * The mandatory routing path.
 *
 *   query → CAI → input + output + sub-task → LIST A
 *         → LIST A ⊆ LIST B → eligible → Recommended / Best / Alternative
 *
 * CAI runs for every query, including trivial ones. There is no fast path
 * that skips it: a "simple" query that turns out to need JSON output or
 * arithmetic would otherwise be routed to a model that cannot do either, and
 * the point of capability matching is that this cannot happen.
 *
 * Selection draws only from the eligible set. A cheaper model that is missing
 * one required mini-task is not an economy — it is a model that will fail the
 * request — so it is never offered.
 */

export interface AnalysedQuery {
  input: string;
  output: string;
  subTaskId: string;
  subTaskName: string;
  /** LIST A: the atomic capabilities this query requires. */
  listA: string[];
  listANames: string[];
  /** CAI when the analyser answered; HEURISTIC when it could not be reached. */
  source: "CAI" | "HEURISTIC";
  /**
   * What the analysis actually cost.
   *
   * CAI runs on every request, so its spend is real and recurring. Leaving it
   * out of the ledger understated the cost of every turn.
   */
  telemetry: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    costUsd: number;
  };
  /** The model that performed the analysis, so the path is auditable. */
  analyser: string;
  /**
   * 0-100. How capable a model must be rated for THIS query, over and above
   * carrying the required capabilities.
   *
   * "Cheapest eligible" alone made every query in a sub-task return the same
   * model: a throwaway greeting and a rigorous multi-document comparison both
   * got the cheapest thing that could technically hold a conversation. The
   * capability set says what a model can do; this says how well this
   * particular request needs it done.
   */
  requiredIntelligence: number;
  reason: string;
}

export interface EligibleModel {
  modelId: string;
  name: string;
  openrouterId: string;
  company: string;
  trusted: boolean;
  inputCost: number;
  outputCost: number;
  intelligence: number;
  /** Blended magnitude used to order by cost. */
  blendedCost: number;
  /** LIST B restricted to this sub-task's members, for display. */
  listB: string[];
  tradeoff: string;
}

export interface RoutingDecision {
  analysis: AnalysedQuery;
  eligible: EligibleModel[];
  /** Models excluded, and exactly which capabilities they lacked. */
  rejected: { modelId: string; name: string; missing: string[] }[];
  recommended: EligibleModel | null;
  best: EligibleModel | null;
  alternative: EligibleModel | null;
  /** ANALYTIC — the dataset's labels are evaluator judgements, not probes. */
  provenance: typeof CAPABILITY_PROVENANCE;
  notice: string;
}

/** Blended cost, weighted toward input since most requests read more than they write. */
export function blendedCost(inputCost: number, outputCost: number): number {
  return inputCost * 0.7 + outputCost * 0.3;
}

/**
 * Chooses the sub-task from the forms the query actually uses.
 *
 * Only sub-tasks the dataset lists for that input/output pair are candidates,
 * so routing can never land outside the taxonomy.
 */
export function resolveSubTask(
  input: string, output: string, hint?: string | null,
): CuratedSubTask | null {
  const candidates = subTasksForForms(input, output);
  if (candidates.length === 0) return null;
  if (hint) {
    const byId = candidates.find((c) => c.id === hint);
    if (byId) return byId;
    const byName = candidates.find(
      (c) => c.name.toLowerCase() === hint.toLowerCase());
    if (byName) return byName;
  }
  return candidates[0];
}

/**
 * Whether a query's wording matches a mini-task.
 *
 * Drawn from the mini-task's own name and definition rather than a private
 * keyword list, so the fallback stays tied to the dataset and cannot drift
 * away from it.
 */
function miniTaskScore(prompt: string, mt: {
  name: string; definition: string; examples: string[];
}): number {
  // The mini-task's three example queries are included deliberately: they are
  // the dataset's own phrasings of what this capability looks like when a
  // user asks for it, and are far closer to real query wording than a formal
  // definition. Without them every query scored zero and fell to the first
  // sub-task in the list.
  const terms = new Set(
    `${mt.name} ${mt.definition} ${mt.examples.join(" ")}`
      .toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 4));

  const words = new Set(prompt.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 4));
  let hits = 0;
  for (const w of words) if (terms.has(w)) hits++;
  return hits;
}


/**
 * How capable a model must be for this specific query.
 *
 * Deliberately coarse and readable: a handful of signals anyone can check
 * against the prompt, rather than a score nobody can audit. It never rises
 * above the point where a reasonable model still qualifies, because a bar no
 * model clears would silently fall back to the strongest and most expensive.
 */
export function requiredIntelligenceFor(
  prompt: string, subTask: CuratedSubTask | null, listA: string[],
): number {
  const p = prompt.toLowerCase();
  const words = p.trim().split(/\s+/).filter(Boolean).length;

  // Base expectation per sub-task: analysis and coding demand more of a model
  // than small talk does.
  const byTask: Record<string, number> = {
    "Reasoning & Analysis": 78,
    Coding: 72,
    "Document Intelligence": 70,
    "Data Intelligence": 70,
    "Text Processing": 55,
    "General Chat & Writing": 45,
  };
  let bar = byTask[subTask?.name ?? ""] ?? 60;

  // Explicit demands for rigour or depth.
  // Adverb and participle forms count: "thoroughly" and "comprehensively"
  // are the same demand as "thorough" and "comprehensive", and a word
  // boundary alone would miss both.
  if (/\b(rigorous|in ?depth|thorough|detailed|comprehensive|production|prove|deriv|justif)/.test(p)) bar += 12;
  if (/\b(compare|comparison|trade-?offs?|evaluat|analys|analyz|strateg)/.test(p)) bar += 6;
  // Long or multi-part inputs need a model that can hold them together.
  if (words > 60) bar += 8;
  if (/\b(large|long|entire|whole)\b.{0,20}\b(document|report|file|dataset)\b/.test(p)) bar += 8;
  // Several required capabilities at once is itself a difficulty signal.
  if (listA.length >= 3) bar += 6;
  else if (listA.length === 2) bar += 3;

  // A short, plain request does not become hard because of its category.
  if (words <= 8 && !/\b(prove|derive|rigorous|optimis|optimiz)\b/.test(p)) bar -= 12;

  return Math.max(30, Math.min(92, Math.round(bar)));
}

/** Keyword fallback for when the evaluator cannot be reached. */
export function analyseHeuristically(
  prompt: string, attachments: { type: string }[] = [],
): AnalysedQuery {
  const types = new Set(attachments.map((a) => a.type.toLowerCase()));
  const p = prompt.toLowerCase();

  const input = types.has("image") ? "Image"
    : types.has("document") ? "Document"
    : /\bcsv\b|\bjson\b.*(given|attached)|this (table|dataset)/.test(p) ? "Structured Data"
    : "Text";

  // The output form is chosen from the forms the taxonomy actually offers for
  // this input. Asking for JSON from a PDF does not make the output form
  // "Structured Data": the dataset carries that as a mini-task capability
  // (MT030 Text-to-Schema JSON Generation) under a Document -> Text sub-task.
  const wanted =
    /\b(generate|create|draw|make).{0,30}\b(image|picture|photo|logo|illustration)\b/.test(p) ? "Image"
    : /\bword document\b|\.docx\b|downloadable (report|document)/.test(p) ? "Document"
    : /\bembed(ding)?\b|vector representation/.test(p) ? "Vector"
    : "Text";

  const legal = outputFormsFor(input);
  const output = legal.some((f) => eqForm(f, wanted)) ? wanted
    : legal.find((f) => eqForm(f, "Text")) ?? legal[0] ?? "Text";

  // Score every sub-task available for this input by how much of its
  // vocabulary the query uses, so a coding question does not fall to the
  // first sub-task in the list simply because it is first.
  const available = subTasksForForms(input, output).length
    ? subTasksForForms(input, output)
    : curatedDataset().subTasks.filter((s) => eqForm(s.input, input));

  const scoreOf = (s: CuratedSubTask) => {
    const members = curatedDataset().miniTasks.filter((m) => m.subTaskId === s.id);
    return members.reduce((n, m) => n + miniTaskScore(p, m), 0);
  };

  const subTask = available
    .map((s) => ({ s, n: scoreOf(s) }))
    .sort((a, b) => b.n - a.n)[0]?.s
    ?? resolveSubTask(input, output);

  const members = subTask
    ? curatedDataset().miniTasks.filter((m) => m.subTaskId === subTask.id)
    : [];

  // Keep only the strongest matches. An over-broad List A is not cautious -
  // it wrongly excludes models that could have answered, because eligibility
  // is a subset test and every extra entry is another requirement.
  const scored = members
    .map((m) => ({ m, n: miniTaskScore(p, m) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);

  const top = scored[0]?.n ?? 0;
  const matched = scored.filter((x) => x.n >= top).slice(0, 3).map((x) => x.m);

  // Never empty: an empty List A would make every model eligible, which is
  // the opposite of capability matching.
  const listA = (matched.length ? matched : members.slice(0, 1)).map((m) => m.id);

  return {
    input, output,
    subTaskId: subTask?.id ?? "",
    subTaskName: subTask?.name ?? "",
    listA,
    listANames: listA.map((id) => miniTaskById().get(id)?.name ?? id),
    requiredIntelligence: requiredIntelligenceFor(prompt, subTask ?? null, listA),
    source: "HEURISTIC",
    analyser: "none",
    // No model was called, so there is nothing to charge for.
    telemetry: { model: "none", inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 },
    reason: "CAI was unavailable; the query was matched against the sub-task's mini-tasks by wording.",
  };
}

/**
 * CAI analysis. Mandatory, and run for every query.
 *
 * The evaluator is told the exact catalogue it may choose from, so it cannot
 * invent a capability id, and its answer is filtered against the dataset
 * regardless.
 */
export async function analyseQuery(input: {
  prompt: string;
  attachments?: { type: string }[];
  apiKey?: string;
}): Promise<AnalysedQuery> {
  const attachments = input.attachments ?? [];
  const apiKey = input.apiKey ?? process.env.OPENROUTER_API_KEY;

  if (!apiKey) return analyseHeuristically(input.prompt, attachments);

  const data = curatedDataset();
  const forms = data.subTasks
    .map((s) => `${s.input} -> ${s.output} : ${s.id} ${s.name}`)
    .filter((v, i, a) => a.indexOf(v) === i).join("\n");
  const tasks = data.miniTasks
    .map((m) => `${m.id} [${m.subTaskId}] ${m.name}: ${m.definition}`).join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), caiTimeoutMs());
  const startedAt = Date.now();

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              `Analyse a user query for a model-routing system.\n\n`
              + `TAXONOMY (input -> output : sub-task):\n${forms}\n\n`
              + `PRIMARY MINI-TASKS:\n${tasks}\n\n`
              + `Return ONLY this JSON, no prose:\n`
              + `{"input":"...","output":"...","subTaskId":"ST..","listA":["MT..."]}\n\n`
              + `listA must contain every mini-task the query genuinely requires and `
              + `nothing else. An extra entry wrongly excludes models that could have `
              + `answered; a missing one lets through a model that cannot. Use only ids `
              + `from the lists above.`,
          },
          {
            role: "user",
            content: `Query: ${input.prompt}\n`
              + `Attachments: ${attachments.length ? attachments.map((a) => a.type).join(", ") : "none"}`,
          },
        ],
        temperature: 0,
        max_tokens: 400,
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await res.json() as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; is_byok?: boolean };
    };
    const text = body.choices?.[0]?.message?.content ?? "";

    const usage = body.usage;
    const telemetry = {
      model: CAI_MODEL,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
      // A BYOK call bills to the caller's own provider account, so the
      // gateway reports zero. That is not free, but dotAI cannot see the
      // real figure, and reporting zero is more honest than inventing one.
      costUsd: typeof usage?.cost === "number" ? usage.cost : 0,
    };
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON returned.");

    const parsed = JSON.parse(match[0]) as {
      input?: string; output?: string; subTaskId?: string; listA?: unknown;
    };

    const byId = miniTaskById();
    const listA = Array.isArray(parsed.listA)
      ? [...new Set(parsed.listA.filter(
          (x): x is string => typeof x === "string" && byId.has(x)))]
      : [];

    if (listA.length === 0) throw new Error("No recognised mini-tasks returned.");

    // Forms come from the attachments where present: what was actually
    // uploaded is a fact, and outranks the analyser's reading of it.
    //
    // With no attachment the analyser's answer is validated against the
    // taxonomy's input forms rather than trusted. It returned the prompt
    // itself ("Hi") as an input form, which resolved to no sub-task and left
    // every text query with zero eligible models.
    const types = new Set(attachments.map((a) => a.type.toLowerCase()));
    const legalInputs = inputForms();
    const claimedInput = parsed.input ?? "Text";

    const inputForm = types.has("image") ? "Image"
      : types.has("document") ? "Document"
      : legalInputs.find((f) => eqForm(f, claimedInput)) ?? "Text";

    /*
     * LIST A governs the output form.
     *
     * The analyser can name an output form that contradicts the mini-tasks it
     * just selected - it returned output "Text" alongside MT032
     * Text-to-Image Synthesis, whose own output form is Image. The mini-tasks
     * are the specific, checkable statement of what the query needs, so where
     * the two disagree they win.
     */
    const byId2 = miniTaskById();
    const listAOutputs = new Set(
      listA.map((id) => byId2.get(id)?.output).filter(Boolean) as string[]);

    // Only when the mini-tasks agree among themselves: a mixed set leaves the
    // analyser's own answer standing.
    const fromListA = listAOutputs.size === 1 ? [...listAOutputs][0] : null;

    const legal = outputFormsFor(inputForm);
    const wanted = fromListA ?? parsed.output ?? "Text";
    const outputForm = legal.some((f) => eqForm(f, wanted)) ? wanted
      : legal.find((f) => eqForm(f, "Text")) ?? legal[0] ?? "Text";

    const subTask = resolveSubTask(inputForm, outputForm, parsed.subTaskId);

    return {
      input: inputForm,
      output: outputForm,
      subTaskId: subTask?.id ?? "",
      subTaskName: subTask?.name ?? "",
      listA,
      listANames: listA.map((id) => byId.get(id)?.name ?? id),
      requiredIntelligence: requiredIntelligenceFor(input.prompt, subTask ?? null, listA),
      telemetry,
      source: "CAI",
      analyser: CAI_MODEL,
      reason: `CAI (${CAI_MODEL}) identified ${listA.length} required mini-task(s).`,
    };
  } catch (err) {
    const fallback = analyseHeuristically(input.prompt, attachments);
    return {
      ...fallback,
      // A failed call still consumed time, and the record should say so.
      telemetry: { ...fallback.telemetry, latencyMs: Date.now() - startedAt },
      reason: `CAI unavailable (${String(err)}); matched against the sub-task's mini-tasks by wording.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The full routing decision.
 *
 * Eligibility is `LIST A ⊆ LIST B` and nothing else. Every rejection records
 * precisely which capabilities were missing, so an absent model can always be
 * explained rather than merely noticed.
 */
export async function routeQuery(input: {
  prompt: string;
  attachments?: { type: string }[];
  apiKey?: string;
}): Promise<RoutingDecision> {
  const analysis = await analyseQuery(input);
  const listBs = allListB();
  const models = modelById();

  const eligible: EligibleModel[] = [];
  const rejected: { modelId: string; name: string; missing: string[] }[] = [];

  for (const [modelId, listB] of listBs) {
    const model = models.get(modelId);
    if (!model) continue;

    // The model must accept the input form and produce the output form.
    const formsOk = model.inputForms.some((f) => eqForm(f, analysis.input))
      && model.outputForms.some((f) => eqForm(f, analysis.output));

    const missing = analysis.listA.filter((t) => !listB.has(t));

    if (!formsOk || missing.length > 0) {
      rejected.push({
        modelId, name: model.name,
        missing: missing.length
          ? missing.map((id) => miniTaskById().get(id)?.name ?? id)
          : [`cannot handle ${analysis.input} → ${analysis.output}`],
      });
      continue;
    }

    const intel = intelligenceFor(modelId, analysis.subTaskId);
    // Without cost and intelligence for this sub-task the model cannot be
    // ranked against the others, so it is not offered as a choice.
    if (!intel) {
      rejected.push({
        modelId, name: model.name,
        missing: [`no rating for ${analysis.subTaskName || analysis.subTaskId}`],
      });
      continue;
    }

    eligible.push({
      modelId,
      name: model.name,
      openrouterId: model.openrouterId,
      company: model.company,
      trusted: model.trusted,
      inputCost: intel.inputCost,
      outputCost: intel.outputCost,
      intelligence: intel.intelligence,
      blendedCost: blendedCost(intel.inputCost, intel.outputCost),
      listB: [...listB].sort(),
      tradeoff: model.tradeoff,
    });
  }

  eligible.sort((a, b) => a.blendedCost - b.blendedCost || b.intelligence - a.intelligence);

  /*
   * Recommended: the cheapest model that is good enough for THIS query.
   *
   * Not simply the cheapest eligible one - that returned the same model for a
   * greeting and for a rigorous comparison, because both merely needed a
   * model that can converse. The bar is what makes the recommendation depend
   * on the query rather than only on its sub-task.
   *
   * If nothing clears the bar the strongest eligible model is offered
   * instead, so a demanding request is never quietly downgraded.
   */
  /*
   * Three tiers, strictly increasing in intelligence.
   *
   *   RECOMMENDED  cheapest eligible model that clears this query's bar
   *   ALTERNATIVE  eligible, strictly more intelligent than Recommended
   *   BEST         eligible, strictly more intelligent than Alternative
   *
   * "Strictly" is the point: three cards showing models of equal capability
   * would be three ways of saying the same thing. Every tier is drawn from
   * the eligible set, so trading up never trades away a required capability.
   *
   * A tier with no qualifying model is left null rather than filled with a
   * duplicate or with something ineligible - an honest gap is more useful
   * than an invented option.
   */
  const bar = analysis.requiredIntelligence;
  const clearsBar = eligible.filter((m) => m.intelligence >= bar);

  // Cheapest that is good enough for this query. Falls back to the strongest
  // eligible model when nothing clears the bar, so a demanding request is
  // never quietly downgraded.
  const recommended = clearsBar[0]
    ?? [...eligible].sort((a, b) => b.intelligence - a.intelligence)[0]
    ?? null;

  // Cheapest model strictly more intelligent than the tier below it. Taking
  // the *cheapest* qualifying model at each step keeps the ladder about
  // capability gained rather than money spent.
  const stepUp = (from: EligibleModel | null): EligibleModel | null => {
    if (!from) return null;
    return eligible.find((m) => m.intelligence > from.intelligence) ?? null;
  };

  const alternative = stepUp(recommended);
  const best = stepUp(alternative);

  return {
    analysis, eligible, rejected, recommended, best, alternative,
    provenance: CAPABILITY_PROVENANCE,
    notice: eligible.length > 0
      ? `${eligible.length} model(s) verified for all ${analysis.listA.length} `
        + `required mini-task(s); ${clearsBar.length} rated at or above the `
        + `${bar} this query needs.`
        + (best ? "" : alternative
            ? " No eligible model is stronger than the Alternative, so there is no Best tier."
            : " No eligible model is stronger than the Recommended one.")
      : `No model in the dataset is verified for all ${analysis.listA.length} required mini-task(s).`,
  };
}
