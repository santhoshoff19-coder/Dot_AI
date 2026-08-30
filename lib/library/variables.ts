/**
 * Template variable parsing.
 *
 * Variables are whatever the prompt author writes. Nothing is hard-coded: if
 * someone types "{SPACECRAFT}" the form grows a Spacecraft field, with no code
 * change anywhere.
 */

export const VARIABLE_TYPES = [
  "TEXT", "LONG_TEXT", "NUMBER", "SELECT", "FILE", "IMAGE", "DOCUMENT",
] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export interface ParsedVariable {
  name: string;
  /** Where it first appeared, so the form follows the template's order. */
  order: number;
  occurrences: number;
}

export interface TemplateIssue {
  kind: "UNCLOSED" | "EMPTY" | "INVALID_NAME" | "NESTED";
  detail: string;
  at: number;
}

export interface ParsedTemplate {
  variables: ParsedVariable[];
  issues: TemplateIssue[];
  valid: boolean;
}

/** A name is letters, digits and underscores. Nothing else. */
const VALID_NAME = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;

export const MAX_TEMPLATE_LENGTH = Number(process.env.MAX_TEMPLATE_LENGTH ?? 20_000);

/**
 * Extracts the variables from a template.
 *
 * Repeats collapse to a single field, order of first appearance is preserved,
 * and malformed placeholders are reported rather than silently ignored.
 */
export function parseTemplate(template: string): ParsedTemplate {
  const issues: TemplateIssue[] = [];
  const seen = new Map<string, ParsedVariable>();

  if (template.length > MAX_TEMPLATE_LENGTH) {
    issues.push({
      kind: "INVALID_NAME",
      detail: `Template exceeds the ${MAX_TEMPLATE_LENGTH} character limit.`,
      at: MAX_TEMPLATE_LENGTH,
    });
  }

  // Unbalanced braces are a common authoring slip and would otherwise produce
  // a prompt with a literal "{TOPIC" in it.
  const opens = (template.match(/\{/g) ?? []).length;
  const closes = (template.match(/\}/g) ?? []).length;
  if (opens !== closes) {
    issues.push({
      kind: "UNCLOSED",
      detail: `Unbalanced braces: ${opens} '{' and ${closes} '}'.`,
      at: template.indexOf("{"),
    });
  }

  let match: RegExpExecArray | null;
  PLACEHOLDER.lastIndex = 0;
  let order = 0;

  while ((match = PLACEHOLDER.exec(template)) !== null) {
    const raw = match[1];
    const name = raw.trim();

    if (name.length === 0) {
      issues.push({ kind: "EMPTY", detail: "Empty placeholder '{}'.", at: match.index });
      continue;
    }
    if (!VALID_NAME.test(name)) {
      issues.push({
        kind: "INVALID_NAME",
        detail: `'${name}' is not a valid variable name. Use letters, digits and underscores, starting with a letter.`,
        at: match.index,
      });
      continue;
    }

    const key = name.toUpperCase();
    const existing = seen.get(key);
    if (existing) {
      existing.occurrences++;
    } else {
      seen.set(key, { name: key, order: order++, occurrences: 1 });
    }
  }

  return {
    variables: [...seen.values()],
    issues,
    valid: issues.length === 0,
  };
}

/** A readable label from a variable name, used as the form field's default. */
export function humanLabel(name: string): string {
  return name
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Guesses a sensible field type from the variable's name. Only a default -
 * the author can change it, and the stored type always wins.
 */
export function inferType(name: string): VariableType {
  const n = name.toUpperCase();
  if (/(^|_)(DOCUMENT|PDF|DOC|FILE|REPORT_FILE)($|_)/.test(n)) return "DOCUMENT";
  if (/(^|_)(IMAGE|PHOTO|PICTURE|SCREENSHOT)($|_)/.test(n)) return "IMAGE";
  if (/(^|_)(CODE|SNIPPET|TEXT|CONTENT|BODY|ESSAY|ARTICLE|TRANSCRIPT)($|_)/.test(n)) {
    return "LONG_TEXT";
  }
  if (/(^|_)(COUNT|NUMBER|LENGTH|WORDS|AGE|YEAR|LIMIT)($|_)/.test(n)) return "NUMBER";
  return "TEXT";
}

export interface VariableSpec {
  name: string;
  type: VariableType;
  required: boolean;
  defaultValue: string;
  options: string[];
}

export interface FillResult {
  ok: boolean;
  prompt: string;
  missing: string[];
  invalid: { name: string; reason: string }[];
}

/**
 * Substitutes values into a template.
 *
 * Refuses to run when a required variable is absent: a prompt containing a
 * literal "{TOPIC}" would be sent to a model and answered as though that were
 * the question.
 */
export function fillTemplate(
  template: string,
  values: Record<string, string>,
  specs: VariableSpec[],
): FillResult {
  const parsed = parseTemplate(template);
  const missing: string[] = [];
  const invalid: { name: string; reason: string }[] = [];

  const specByName = new Map(specs.map((s) => [s.name.toUpperCase(), s]));
  const resolved = new Map<string, string>();

  for (const v of parsed.variables) {
    const spec = specByName.get(v.name);
    const supplied = values[v.name] ?? values[v.name.toLowerCase()] ?? "";
    const value = supplied.trim() || spec?.defaultValue?.trim() || "";

    if (!value) {
      if (spec?.required ?? true) missing.push(v.name);
      resolved.set(v.name, "");
      continue;
    }

    if (spec?.type === "NUMBER" && !/^-?\d+(\.\d+)?$/.test(value)) {
      invalid.push({ name: v.name, reason: "must be a number" });
    }
    if (spec?.type === "SELECT" && spec.options.length && !spec.options.includes(value)) {
      invalid.push({
        name: v.name,
        reason: `must be one of: ${spec.options.join(", ")}`,
      });
    }

    resolved.set(v.name, value);
  }

  const prompt = template.replace(PLACEHOLDER, (whole, raw: string) => {
    const key = raw.trim().toUpperCase();
    return resolved.has(key) ? resolved.get(key)! : whole;
  });

  return {
    ok: missing.length === 0 && invalid.length === 0 && parsed.valid,
    prompt,
    missing,
    invalid,
  };
}

/**
 * Neutralises instruction-like text arriving through a variable.
 *
 * A variable is content the prompt talks *about*; it must not be able to
 * restate the task. This is a mitigation, not a guarantee - the ControlPlane
 * checks still run on whatever comes back.
 */
export function sanitiseValue(value: string, maxLength = 20_000): string {
  return value
    .slice(0, maxLength)
    .replace(/\u0000/g, "")
    // Strip role markers that could be read as a new turn.
    .replace(/^\s*(system|assistant|user)\s*:/gim, "$1 -")
    .replace(/\[\/?INST\]/gi, "")
    .replace(/<\|[^|>]{0,40}\|>/g, "");
}
