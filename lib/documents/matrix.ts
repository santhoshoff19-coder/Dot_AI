import { detectOutputIntent } from "@/lib/routing/modality-intent";

export type IOModality = "TEXT" | "IMAGE" | "DOCUMENT";
export type OutputPreference = "AUTO" | IOModality;

export interface MatrixCell {
  supported: boolean;
  /** Support that depends on the selected model, not just on dotAI. */
  conditional?: boolean;
  /** The provider capability a model must have to serve this cell. */
  requiresModelOutput: "TEXT" | "IMAGE";
  requiresModelInput: ("TEXT" | "IMAGE")[];
  note: string;
}

/**
 * The V1 capability matrix.
 *
 * A cell is only marked supported when dotAI can actually execute it end to
 * end. Document output is produced by rendering governed text, so it needs a
 * text-capable model; image output needs a genuine image-output model.
 */
export const CAPABILITY_MATRIX: Record<IOModality, Record<IOModality, MatrixCell>> = {
  TEXT: {
    TEXT: {
      supported: true, requiresModelOutput: "TEXT", requiresModelInput: ["TEXT"],
      note: "Standard text generation.",
    },
    IMAGE: {
      supported: true, requiresModelOutput: "IMAGE", requiresModelInput: ["TEXT"],
      note: "Text-to-image generation.",
    },
    DOCUMENT: {
      supported: true, requiresModelOutput: "TEXT", requiresModelInput: ["TEXT"],
      note: "Text is generated, governed, then rendered to DOCX.",
    },
  },
  IMAGE: {
    TEXT: {
      supported: true, requiresModelOutput: "TEXT", requiresModelInput: ["TEXT", "IMAGE"],
      note: "Vision: image input, text output.",
    },
    IMAGE: {
      // Genuinely conditional: most image models accept text only.
      supported: true, conditional: true,
      requiresModelOutput: "IMAGE", requiresModelInput: ["TEXT", "IMAGE"],
      note: "Image-to-image requires a model that accepts image input AND emits image output.",
    },
    DOCUMENT: {
      supported: true, requiresModelOutput: "TEXT", requiresModelInput: ["TEXT", "IMAGE"],
      note: "A vision model reads the image; the governed text is rendered to DOCX.",
    },
  },
  DOCUMENT: {
    TEXT: {
      supported: true, requiresModelOutput: "TEXT", requiresModelInput: ["TEXT"],
      note: "Extracted document text is summarised or analysed.",
    },
    IMAGE: {
      supported: true, requiresModelOutput: "IMAGE", requiresModelInput: ["TEXT"],
      note: "Extracted text becomes the image prompt.",
    },
    DOCUMENT: {
      supported: true, requiresModelOutput: "TEXT", requiresModelInput: ["TEXT"],
      note: "Extracted text is rewritten, governed, then rendered to DOCX.",
    },
  },
};

export function cellFor(input: IOModality, output: IOModality): MatrixCell {
  return CAPABILITY_MATRIX[input][output];
}

/** Highest-order input modality present, since that drives model capability. */
export function primaryInputModality(attachments: {
  type: string; extractionStatus?: string;
}[]): IOModality {
  if (attachments.some((a) => a.type === "image")) return "IMAGE";
  if (attachments.some((a) => a.type === "document")) return "DOCUMENT";
  return "TEXT";
}

export interface OutputResolution {
  output: IOModality;
  source: "USER_OVERRIDE" | "EXPLICIT_REQUEST" | "INFERRED";
  reason: string;
}

/**
 * Decides what the user actually wants back.
 *
 * An explicit user selection always wins. Otherwise an explicit phrase in the
 * prompt ("as a DOCX") beats inference, so "create a DOCX report" can never
 * quietly become an ordinary chat reply.
 */
export function resolveOutputModality(
  prompt: string,
  preference: OutputPreference = "AUTO",
  context: { hasImageInput?: boolean; hasDocumentInput?: boolean } = {},
): OutputResolution {
  if (preference !== "AUTO") {
    return {
      output: preference,
      source: "USER_OVERRIDE",
      reason: `The user explicitly selected ${preference.toLowerCase()} output.`,
    };
  }

  // Delegated to the single shared detector so the matrix, the fast router
  // and CAI can never disagree about what the user asked for.
  const intent = detectOutputIntent(prompt, context);
  return {
    output: intent.output,
    source: intent.signal === "DEFAULT_TEXT" ? "INFERRED" : "EXPLICIT_REQUEST",
    reason: intent.reason,
  };
}

export interface SupportCheck {
  supported: boolean;
  conditional: boolean;
  cell: MatrixCell;
  message: string;
}

export function checkSupport(input: IOModality, output: IOModality): SupportCheck {
  const cell = cellFor(input, output);
  return {
    supported: cell.supported,
    conditional: Boolean(cell.conditional),
    cell,
    message: cell.supported
      ? cell.note
      : `${input.toLowerCase()} input with ${output.toLowerCase()} output is not supported in V1.`,
  };
}
