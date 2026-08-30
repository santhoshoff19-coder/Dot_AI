import {
  FIELD_LABELS, ORDERED_FIELDS, levelSatisfies, toolSatisfies,
  type CapabilityProfile, type OrderedField, type OutputCapability,
  type TaskRequirementProfile,
} from "@/lib/capability/taxonomy";

export interface CapabilityCheck {
  field: string;
  label: string;
  required: string;
  actual: string;
  passed: boolean;
}

export interface QualificationResult {
  qualified: boolean;
  checks: CapabilityCheck[];
  /** Short, user-safe explanation of why this model was kept or dropped. */
  reason: string;
  /** How far above the requirement the model sits, used as a tie-breaker. */
  headroom: number;
}

/**
 * Capability filter.
 *
 * Ordered fields qualify when capability >= requirement. Output capability is
 * a hard categorical constraint: a text-only model must never surface as a
 * recommendation for image generation, no matter how cheap it is.
 */
export function qualifyModel(
  capability: CapabilityProfile,
  requirements: TaskRequirementProfile,
  /** What the model can actually accept as input, from provider metadata. */
  inputModalities?: string[],
): QualificationResult {
  const checks: CapabilityCheck[] = [];
  let headroom = 0;

  // --- 0. Input modality: also a hard constraint --------------------------
  // Asking a text-only model about an attached image is not a cost trade-off,
  // it is an impossibility.
  if (inputModalities) {
    const accepted = inputModalities.map((m) => m.toUpperCase());
    const missingInputs = requirements.requiredInputModalities.filter(
      (want) => want !== "TEXT" && !accepted.includes(want),
    );
    const inputOk = missingInputs.length === 0;
    checks.push({
      field: "inputModalities",
      label: "Input modality",
      required: requirements.requiredInputModalities.join(", "),
      actual: accepted.join(", ") || "none",
      passed: inputOk,
    });
    if (!inputOk) {
      return {
        qualified: false,
        checks,
        reason: `Cannot accept ${missingInputs.join(", ").toLowerCase()} input.`,
        headroom: 0,
      };
    }
  }

  // --- 1. Output capability: hard constraint, evaluated first -------------
  const missingOutputs = requirements.requiredOutputModalities.filter(
    (want: OutputCapability) => !capability.outputCapabilities.includes(want),
  );
  const outputOk = missingOutputs.length === 0;
  checks.push({
    field: "outputCapabilities",
    label: FIELD_LABELS.outputCapabilities,
    required: requirements.requiredOutputModalities.join(", "),
    actual: capability.outputCapabilities.join(", "),
    passed: outputOk,
  });

  if (!outputOk) {
    return {
      qualified: false,
      checks,
      reason: `Cannot produce ${missingOutputs.join(", ").toLowerCase()} output.`,
      headroom: 0,
    };
  }

  // --- 2. Ordered fields --------------------------------------------------
  const failures: string[] = [];
  for (const field of ORDERED_FIELDS) {
    const required = requirements[field];
    const actual = capability[field];
    const passed = levelSatisfies(actual, required);
    if (passed) {
      headroom += rankOf(actual) - rankOf(required);
    } else {
      failures.push(`${FIELD_LABELS[field as OrderedField].toLowerCase()} ${actual} < ${required}`);
    }
    checks.push({
      field,
      label: FIELD_LABELS[field as OrderedField],
      required,
      actual,
      passed,
    });
  }

  // --- 3. Tool capability -------------------------------------------------
  const toolOk = toolSatisfies(capability.toolCapability, requirements.toolCapability);
  if (!toolOk) {
    failures.push(
      `tool capability ${capability.toolCapability} < ${requirements.toolCapability}`);
  }
  checks.push({
    field: "toolCapability",
    label: FIELD_LABELS.toolCapability,
    required: requirements.toolCapability,
    actual: capability.toolCapability,
    passed: toolOk,
  });

  const qualified = failures.length === 0;

  return {
    qualified,
    checks,
    reason: qualified
      ? "Meets every capability requirement for this task."
      : `Insufficient ${failures.join("; ")}.`,
    headroom,
  };
}

function rankOf(level: string): number {
  return { LOW: 0, MEDIUM: 1, HIGH: 2 }[level] ?? 0;
}

/** A compact, user-safe explanation of a qualified model's fit. */
export function explainQualification(result: QualificationResult): string[] {
  return result.checks.map(
    (c) => `${c.passed ? "\u2713" : "\u2717"} ${c.label}: ${c.actual} (needs ${c.required})`,
  );
}
