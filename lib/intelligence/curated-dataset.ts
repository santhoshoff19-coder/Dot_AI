import { readFileSync } from "fs";
import path from "path";

/**
 * The curated Model Intelligence dataset.
 *
 * This file is the ONLY source of model intelligence. The live OpenRouter
 * catalogue is no longer consulted for which models exist, what they cost or
 * what they can do — every one of those answers comes from here, so the set a
 * user sees is stable and auditable rather than shifting with the upstream
 * catalogue between requests.
 *
 * One thing the dataset is explicit about and this code will not paper over:
 * its capability evidence records an *analytic determination* by the
 * evaluator, marked "pending live three-example execution". So a verified
 * capability here means the evaluator judged the model capable from its model
 * card, benchmarks and architecture — not that three probes were executed
 * against it. `provenance` carries that distinction through to the UI.
 */

export interface CuratedSubTask {
  id: string; name: string; input: string; output: string; description: string;
}

export interface CuratedMiniTask {
  id: string; name: string; input: string; output: string;
  subTaskId: string; definition: string;
  examples: string[]; criteria: string;
}

export interface CuratedModel {
  id: string; name: string; company: string; openrouterId: string;
  trusted: boolean; inputForms: string[]; outputForms: string[]; tradeoff: string;
}

export interface CuratedCapability {
  modelId: string; miniTaskId: string; verified: boolean; evidence: string;
}

export interface CuratedIntelligence {
  modelId: string; subTaskId: string;
  inputCost: number; outputCost: number; intelligence: number;
}

export interface CuratedSubTaskSet {
  subTaskId: string; modelId: string; group: string; match: string; verified: string[];
}

export interface CuratedRoutingExample {
  query: string; input: string; output: string; subTask: string;
  listA: string[]; eligible: string[];
  recommended: string; best: string; alternative: string;
}

export interface CuratedDataset {
  meta: { workbook: string; built: string; evaluator: string; corrections?: string[] };
  subTasks: CuratedSubTask[];
  miniTasks: CuratedMiniTask[];
  models: CuratedModel[];
  capabilities: CuratedCapability[];
  intelligence: CuratedIntelligence[];
  subTaskSets: CuratedSubTaskSet[];
  routingExamples: CuratedRoutingExample[];
}

/**
 * How a capability label was established.
 *
 * ANALYTIC is what the shipped dataset carries. It is a considered judgement,
 * not a measurement, and must never be displayed as though probes were run.
 */
export const CAPABILITY_PROVENANCE = "ANALYTIC" as const;

let cached: CuratedDataset | null = null;

/** Reads and caches the dataset. Parsed once per process. */
export function curatedDataset(): CuratedDataset {
  if (cached) return cached;

  const file = path.join(process.cwd(), "data", "curated-model-intelligence.json");
  cached = JSON.parse(readFileSync(file, "utf8")) as CuratedDataset;
  return cached;
}

// ---- indexes -------------------------------------------------------------

export function subTaskById(): Map<string, CuratedSubTask> {
  return new Map(curatedDataset().subTasks.map((s) => [s.id, s]));
}

export function miniTaskById(): Map<string, CuratedMiniTask> {
  return new Map(curatedDataset().miniTasks.map((m) => [m.id, m]));
}

export function modelById(): Map<string, CuratedModel> {
  return new Map(curatedDataset().models.map((m) => [m.id, m]));
}

/** The sub-tasks reachable from an input/output pair. Drives the taxonomy. */
export function subTasksForForms(input: string, output: string): CuratedSubTask[] {
  return curatedDataset().subTasks.filter(
    (s) => eqForm(s.input, input) && eqForm(s.output, output));
}

export function inputForms(): string[] {
  return [...new Set(curatedDataset().subTasks.map((s) => s.input))];
}

export function outputFormsFor(input: string): string[] {
  return [...new Set(curatedDataset().subTasks
    .filter((s) => eqForm(s.input, input)).map((s) => s.output))];
}

/** Form names are compared case- and space-insensitively. */
export function eqForm(a: string, b: string): boolean {
  return normaliseForm(a) === normaliseForm(b);
}

export function normaliseForm(v: string): string {
  return String(v ?? "").trim().toUpperCase().replace(/[\s_-]+/g, "_");
}

/**
 * A model's verified capability set — its List B.
 *
 * Only rows the dataset marks verified are included. An unverified row is a
 * recorded negative, not a gap, and must never be read as "probably fine".
 */
export function listBFor(modelId: string): Set<string> {
  return new Set(curatedDataset().capabilities
    .filter((c) => c.modelId === modelId && c.verified)
    .map((c) => c.miniTaskId));
}

/** Every model's List B, built once. */
export function allListB(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of curatedDataset().capabilities) {
    if (!c.verified) continue;
    if (!out.has(c.modelId)) out.set(c.modelId, new Set());
    out.get(c.modelId)!.add(c.miniTaskId);
  }
  return out;
}

/** Cost and intelligence for a model on one sub-task. */
export function intelligenceFor(
  modelId: string, subTaskId: string,
): CuratedIntelligence | null {
  return curatedDataset().intelligence.find(
    (i) => i.modelId === modelId && i.subTaskId === subTaskId) ?? null;
}

/** Capability groups: models whose verified set is identical. */
export function capabilityGroups(): {
  key: string; modelIds: string[]; size: number;
}[] {
  const groups = new Map<string, string[]>();
  for (const [modelId, set] of allListB()) {
    const key = [...set].sort().join(",");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(modelId);
  }
  return [...groups.entries()]
    .map(([key, modelIds]) => ({ key, modelIds, size: modelIds.length }))
    .sort((a, b) => b.size - a.size);
}
