import type { IOModality } from "@/lib/documents/matrix";

/**
 * ROOT-CAUSE FIX.
 *
 * Image-generation intent used to be detected by three separate regexes - one
 * in the capability matrix, one in the fast router, one in CAI - each with a
 * different vocabulary. They disagreed, so "design a logo" resolved to IMAGE
 * in one place and TEXT in another, and "generate a cat pic" matched nowhere
 * because "pic" was in none of them.
 *
 * This module is now the only place output-modality intent is decided.
 * Everything else calls it.
 */

/** Nouns that name a visual artefact. Deliberately broad and informal. */
const IMAGE_NOUNS = [
  "image", "images", "pic", "pics", "picture", "pictures", "photo", "photos",
  "photograph", "illustration", "illustrations", "drawing", "sketch",
  "painting", "artwork", "art", "render", "rendering", "logo", "icon",
  "poster", "banner", "wallpaper", "avatar", "thumbnail", "infographic",
  "diagram", "chart image", "portrait", "mockup", "graphic", "graphics",
  "visual", "visualisation", "visualization", "meme", "comic", "storyboard",
];

/**
 * Verbs that are inherently visual: "draw a city" needs no noun, because
 * drawing already implies an image.
 */
const INHERENTLY_VISUAL_VERBS = [
  "draw", "sketch", "paint", "illustrate", "render", "photorealistic",
];

/** Verbs that produce something, but need a noun to say what. */
const PRODUCE_VERBS = [
  "generate", "create", "make", "design", "produce", "give me", "show me",
  "build", "compose", "output", "i want", "i need", "can you",
];

/** Nouns that name a document artefact. */
const DOCUMENT_NOUNS = [
  "docx", "word document", "word doc", "\\.doc", "document file",
  "downloadable report", "downloadable document", "report file",
];

/** Editing an existing image rather than making a new one. */
const EDIT_VERBS = [
  "edit", "modify", "change", "alter", "retouch", "adjust", "remove",
  "replace", "recolour", "recolor", "upscale", "restyle", "inpaint",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const group = (words: string[]) => words.map(escape).join("|");

/** "generate ... a cat pic" - verb, then a visual noun within a short window. */
const PRODUCE_IMAGE = new RegExp(
  `\\b(?:${group(PRODUCE_VERBS)})\\b[^.?!]{0,60}?\\b(?:${group(IMAGE_NOUNS)})\\b`, "i");

/** "draw a futuristic city" - the verb alone is enough. */
const VISUAL_VERB = new RegExp(
  `\\b(?:${group(INHERENTLY_VISUAL_VERBS)})\\b`, "i");

/** "an image of a dog", "picture of the moon". */
const NOUN_OF = new RegExp(
  `\\b(?:${group(IMAGE_NOUNS)})\\s+(?:of|showing|depicting|featuring|with)\\b`, "i");

const PRODUCE_DOCUMENT = new RegExp(
  `\\b(?:${group(DOCUMENT_NOUNS)})\\b|\\b(?:as|into|to|in)\\s+(?:a\\s+)?(?:${group(DOCUMENT_NOUNS)})\\b`,
  "i");

const EDIT_IMAGE = new RegExp(
  `\\b(?:${group(EDIT_VERBS)})\\b[^.?!]{0,40}\\b(?:${group(IMAGE_NOUNS)})\\b|` +
  `\\b(?:${group(EDIT_VERBS)})\\b[^.?!]{0,20}\\b(?:this|the|it)\\b`, "i");

/** Asking *about* an image, which is vision - image in, text out. */
const ASK_ABOUT_IMAGE = new RegExp(
  `\\b(?:what|which|who|describe|identify|read|explain|analyse|analyze|caption|tell me)\\b` +
  `[^.?!]{0,50}\\b(?:${group(IMAGE_NOUNS)}|this|it)\\b`, "i");

export interface ModalityIntent {
  output: IOModality;
  /** How the conclusion was reached, for auditability. */
  signal:
    | "PRODUCE_IMAGE" | "VISUAL_VERB" | "IMAGE_OF" | "EDIT_IMAGE"
    | "PRODUCE_DOCUMENT" | "ASK_ABOUT_INPUT" | "DEFAULT_TEXT";
  confidence: number;
  reason: string;
}

/**
 * Decides what artefact the user wants back.
 *
 * `hasImageInput` matters: "edit this and make the sky blue" is image editing
 * only when an image was actually attached; otherwise it is ordinary text.
 */
export function detectOutputIntent(
  prompt: string,
  opts: { hasImageInput?: boolean; hasDocumentInput?: boolean } = {},
): ModalityIntent {
  const text = prompt.trim();

  // Document wins over image: "an infographic in a DOCX" is a document.
  if (PRODUCE_DOCUMENT.test(text)) {
    return {
      output: "DOCUMENT", signal: "PRODUCE_DOCUMENT", confidence: 0.95,
      reason: "The request names a document file format.",
    };
  }

  // Editing an attached image produces another image.
  if (opts.hasImageInput && EDIT_IMAGE.test(text)) {
    return {
      output: "IMAGE", signal: "EDIT_IMAGE", confidence: 0.9,
      reason: "An image was supplied and the request asks to change it.",
    };
  }

  // Asking about an attached image is vision, not generation.
  if (opts.hasImageInput && ASK_ABOUT_IMAGE.test(text) && !PRODUCE_IMAGE.test(text)) {
    return {
      output: "TEXT", signal: "ASK_ABOUT_INPUT", confidence: 0.93,
      reason: "The request asks about the supplied image rather than for a new one.",
    };
  }

  if (PRODUCE_IMAGE.test(text)) {
    return {
      output: "IMAGE", signal: "PRODUCE_IMAGE", confidence: 0.94,
      reason: "The request asks to produce a visual artefact.",
    };
  }

  if (NOUN_OF.test(text)) {
    return {
      output: "IMAGE", signal: "IMAGE_OF", confidence: 0.9,
      reason: "The request names an image of a subject.",
    };
  }

  // "draw a city" - no noun needed, the verb is already visual. Excluded when
  // an image was supplied, where it more likely means editing.
  if (VISUAL_VERB.test(text) && !opts.hasImageInput) {
    return {
      output: "IMAGE", signal: "VISUAL_VERB", confidence: 0.88,
      reason: "The request uses an inherently visual verb.",
    };
  }

  return {
    output: "TEXT", signal: "DEFAULT_TEXT", confidence: 0.75,
    reason: "No request for an image or document artefact was detected.",
  };
}

/** True when the request wants a newly generated image. */
export function wantsImageGeneration(
  prompt: string, opts: { hasImageInput?: boolean } = {},
): boolean {
  const intent = detectOutputIntent(prompt, opts);
  return intent.output === "IMAGE" && intent.signal !== "EDIT_IMAGE";
}

/** True when the request wants an existing image changed. */
export function wantsImageEditing(prompt: string, hasImageInput: boolean): boolean {
  return detectOutputIntent(prompt, { hasImageInput }).signal === "EDIT_IMAGE";
}
