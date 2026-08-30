import type { Capability } from "@/lib/intelligence/taxonomy";

/**
 * The canonical task structure: INPUT → OUTPUT → SUB-TASK.
 *
 * This is the single authoritative shape. The sub-task is what a model is
 * scored against, and a model's intelligence for one sub-task says nothing
 * about another: the same model is evaluated separately for Coding and for
 * General Chat & Writing.
 *
 * The tree below is fixed. Nothing here may be renamed, merged, split or
 * reordered — the UI's three dropdowns and the routing path both read it, so
 * a change here changes what users can ask for.
 */

export const INPUT_FORMS = [
  "TEXT", "IMAGE", "DOCUMENT", "STRUCTURED_DATA",
] as const;
export type InputForm = (typeof INPUT_FORMS)[number];

export const OUTPUT_FORMS = [
  "TEXT", "IMAGE", "DOCUMENT", "STRUCTURED_DATA", "VECTOR",
] as const;
export type OutputForm = (typeof OUTPUT_FORMS)[number];

export const SUB_TASKS = [
  "GENERAL_CHAT_WRITING",
  "REASONING_ANALYSIS",
  "CODING",
  "TEXT_PROCESSING",
  "IMAGE_GENERATION_EDITING",
  "IMAGE_UNDERSTANDING",
  "DOCUMENT_INTELLIGENCE",
  "DOCUMENT_CREATION_TRANSFORMATION",
  "DATA_INTELLIGENCE",
  "EMBEDDINGS_RETRIEVAL",
] as const;
export type SubTask = (typeof SUB_TASKS)[number];

export const FORM_LABEL: Record<string, string> = {
  TEXT: "Text",
  IMAGE: "Image",
  DOCUMENT: "Document",
  STRUCTURED_DATA: "Structured data",
  VECTOR: "Vector",
};

export const SUB_TASK_LABEL: Record<SubTask, string> = {
  GENERAL_CHAT_WRITING: "General Chat & Writing",
  REASONING_ANALYSIS: "Reasoning & Analysis",
  CODING: "Coding",
  TEXT_PROCESSING: "Text Processing",
  IMAGE_GENERATION_EDITING: "Image Generation & Editing",
  IMAGE_UNDERSTANDING: "Image Understanding",
  DOCUMENT_INTELLIGENCE: "Document Intelligence",
  DOCUMENT_CREATION_TRANSFORMATION: "Document Creation & Transformation",
  DATA_INTELLIGENCE: "Data Intelligence",
  EMBEDDINGS_RETRIEVAL: "Embeddings & Retrieval",
};

export const formLabel = (v: string) => FORM_LABEL[v] ?? v;
export const subTaskLabel = (v: string) =>
  SUB_TASK_LABEL[v as SubTask] ?? v.replace(/_/g, " ");

/** One leaf of the tree: an input, an output, and the sub-tasks it allows. */
export interface Combo {
  input: InputForm;
  output: OutputForm;
  subTasks: SubTask[];
}

/**
 * The tree, transcribed exactly.
 *
 * Every combination a user can select is here, and nothing else is
 * selectable. An input/output pair absent from this list has no sub-tasks and
 * the Task dropdown is empty for it, which is the honest answer.
 */
export const COMBOS: Combo[] = [
  {
    input: "TEXT", output: "TEXT",
    subTasks: ["GENERAL_CHAT_WRITING", "REASONING_ANALYSIS", "CODING", "TEXT_PROCESSING"],
  },
  { input: "TEXT", output: "IMAGE", subTasks: ["IMAGE_GENERATION_EDITING"] },

  { input: "IMAGE", output: "TEXT", subTasks: ["IMAGE_UNDERSTANDING"] },
  { input: "IMAGE", output: "IMAGE", subTasks: ["IMAGE_GENERATION_EDITING"] },

  {
    input: "DOCUMENT", output: "TEXT",
    subTasks: ["DOCUMENT_INTELLIGENCE", "TEXT_PROCESSING"],
  },
  {
    input: "DOCUMENT", output: "DOCUMENT",
    subTasks: ["DOCUMENT_CREATION_TRANSFORMATION"],
  },

  { input: "STRUCTURED_DATA", output: "TEXT", subTasks: ["DATA_INTELLIGENCE"] },
  { input: "STRUCTURED_DATA", output: "STRUCTURED_DATA", subTasks: ["DATA_INTELLIGENCE"] },
  { input: "STRUCTURED_DATA", output: "IMAGE", subTasks: ["DATA_INTELLIGENCE"] },

  // TEXT / IMAGE / DOCUMENT → VECTOR
  { input: "TEXT", output: "VECTOR", subTasks: ["EMBEDDINGS_RETRIEVAL"] },
  { input: "IMAGE", output: "VECTOR", subTasks: ["EMBEDDINGS_RETRIEVAL"] },
  { input: "DOCUMENT", output: "VECTOR", subTasks: ["EMBEDDINGS_RETRIEVAL"] },
];

/** Inputs that lead anywhere. */
export function availableInputs(): InputForm[] {
  return [...new Set(COMBOS.map((c) => c.input))];
}

/** Outputs reachable from an input. Drives the second dropdown. */
export function outputsFor(input: string): OutputForm[] {
  return [...new Set(COMBOS.filter((c) => c.input === input).map((c) => c.output))];
}

/**
 * Sub-tasks for an input/output pair. Drives the third dropdown, which is
 * why it must return exactly the tree's leaves and never a default.
 */
export function subTasksFor(input: string, output: string): SubTask[] {
  return COMBOS.find((c) => c.input === input && c.output === output)?.subTasks ?? [];
}

export function isValidCombo(input: string, output: string, subTask: string): boolean {
  return subTasksFor(input, output).includes(subTask as SubTask);
}

/** Every leaf, flattened. Used to evaluate the whole database. */
export function allCombos(): { input: InputForm; output: OutputForm; subTask: SubTask }[] {
  return COMBOS.flatMap((c) =>
    c.subTasks.map((subTask) => ({ input: c.input, output: c.output, subTask })));
}

/**
 * The storage key for one leaf.
 *
 * Assessments are keyed by the full path, not the sub-task alone: Coding
 * reached from TEXT→TEXT and a hypothetical Coding elsewhere are different
 * populations and must not share scores.
 */
export function comboKey(input: string, output: string, subTask: string): string {
  return `${input}>${output}>${subTask}`;
}

export function parseComboKey(key: string): {
  input: string; output: string; subTask: string;
} | null {
  const parts = key.split(">");
  return parts.length === 3
    ? { input: parts[0], output: parts[1], subTask: parts[2] }
    : null;
}

/**
 * The hard capability gate for a leaf.
 *
 * Derived from the input and output forms, so a model that cannot read the
 * input or produce the output is never a candidate — it is absent, not
 * ranked low.
 */
export function requirementsFor(input: string, output: string): Capability[] {
  const required: Capability[] = [];

  switch (input) {
    case "IMAGE": required.push("IMAGE_INPUT"); break;
    // A document reaches the model as extracted text, so text input is what
    // the model must actually accept.
    case "DOCUMENT": required.push("TEXT_INPUT"); break;
    case "STRUCTURED_DATA": required.push("TEXT_INPUT"); break;
    default: required.push("TEXT_INPUT");
  }

  switch (output) {
    case "IMAGE": required.push("IMAGE_OUTPUT"); break;
    case "VECTOR": required.push("EMBEDDING"); break;
    case "STRUCTURED_DATA": required.push("TEXT_OUTPUT", "STRUCTURED_OUTPUT"); break;
    // A document is rendered by dotAI from the model's text.
    case "DOCUMENT": required.push("TEXT_OUTPUT"); break;
    default: required.push("TEXT_OUTPUT");
  }

  return [...new Set(required)];
}

/**
 * How a sub-task bills. Image work is per image; everything else per token.
 */
export function billingFor(output: string): "USD_PER_IMAGE" | "USD_PER_MILLION_TOKENS" {
  return output === "IMAGE" ? "USD_PER_IMAGE" : "USD_PER_MILLION_TOKENS";
}
