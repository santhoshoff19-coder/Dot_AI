import mammoth from "mammoth";

/**
 * Why extraction did or did not produce usable text. Downstream routing needs
 * to distinguish "no text" from "text we failed to read" - answering a
 * question about a document we could not read is worse than saying so.
 */
export type ExtractionStatus =
  | "EXTRACTED"
  | "DOCUMENT_TEXT_UNAVAILABLE"
  | "EXTRACTION_FAILED"
  | "EMPTY_DOCUMENT"
  | "UNSUPPORTED_FORMAT";

export interface DocumentContent {
  fileName: string;
  mimeType: string;
  size: number;
  extractedText: string | null;
  extractionStatus: ExtractionStatus;
  pageCount?: number;
  /** Words extracted, useful for deciding whether a summary is even possible. */
  wordCount: number;
  detail: string;
  metadata: Record<string, string>;
}

export const MAX_EXTRACT_CHARS = 200_000;

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const TEXT_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json",
]);

/** Collapses whitespace without destroying paragraph structure. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

function base(fileName: string, mimeType: string, size: number): DocumentContent {
  return {
    fileName, mimeType, size,
    extractedText: null,
    extractionStatus: "EXTRACTION_FAILED",
    wordCount: 0,
    detail: "",
    metadata: {},
  };
}

function finalise(
  doc: DocumentContent, text: string, meta: Record<string, string> = {},
): DocumentContent {
  const clean = cleanText(text).slice(0, MAX_EXTRACT_CHARS);
  const words = clean ? clean.split(/\s+/).filter(Boolean).length : 0;

  if (words === 0) {
    return {
      ...doc,
      extractedText: null,
      extractionStatus: "DOCUMENT_TEXT_UNAVAILABLE",
      wordCount: 0,
      detail:
        "The file was read successfully but contains no extractable text. " +
        "Scanned or image-only documents need OCR, which dotAI does not do yet.",
      metadata: meta,
    };
  }

  return {
    ...doc,
    extractedText: clean,
    extractionStatus: "EXTRACTED",
    wordCount: words,
    detail: `Extracted ${words} words.`,
    metadata: meta,
  };
}

/** PDF text extraction via pdfjs. Text-based PDFs only; scans are reported. */
export async function extractPdf(
  buffer: Buffer, fileName: string, size: number,
): Promise<DocumentContent> {
  const doc = base(fileName, "application/pdf", size);

  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return {
      ...doc,
      extractionStatus: "EXTRACTION_FAILED",
      detail: `${fileName} is not a valid PDF (missing PDF header).`,
    };
  }

  try {
    // The legacy build runs under Node without a DOM.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      isEvalSupported: false,
    } as unknown as Parameters<typeof pdfjs.getDocument>[0]);

    const pdf = await task.promise;
    const pages: string[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (typeof item === "object" && item && "str" in item
          ? String((item as { str: unknown }).str) : ""))
        .join(" ");
      pages.push(text);
    }

    const meta: Record<string, string> = { pages: String(pdf.numPages) };
    try {
      const info = await pdf.getMetadata();
      const raw = info.info as Record<string, unknown> | undefined;
      if (raw?.Title) meta.title = String(raw.Title);
      if (raw?.Author) meta.author = String(raw.Author);
    } catch { /* metadata is optional */ }

    const result = finalise(doc, pages.join("\n\n"), meta);
    return { ...result, pageCount: pdf.numPages };
  } catch (err) {
    return {
      ...doc,
      extractionStatus: "EXTRACTION_FAILED",
      detail: `Could not read ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** DOCX text extraction via mammoth. */
export async function extractDocx(
  buffer: Buffer, fileName: string, size: number,
): Promise<DocumentContent> {
  const doc = base(fileName, DOCX_MIME, size);

  // A DOCX is a ZIP; anything else will not open.
  if (buffer.subarray(0, 2).toString("latin1") !== "PK") {
    return {
      ...doc,
      extractionStatus: "EXTRACTION_FAILED",
      detail: `${fileName} is not a valid DOCX (missing ZIP header).`,
    };
  }

  try {
    const result = await mammoth.extractRawText({ buffer });
    const messages = result.messages
      .filter((m) => m.type === "error")
      .map((m) => m.message);
    const meta: Record<string, string> = {};
    if (messages.length) meta.warnings = messages.join("; ");
    return finalise(doc, result.value, meta);
  } catch (err) {
    return {
      ...doc,
      extractionStatus: "EXTRACTION_FAILED",
      detail: `Could not read ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function extractPlainText(
  buffer: Buffer, fileName: string, mimeType: string, size: number,
): DocumentContent {
  const doc = base(fileName, mimeType, size);
  try {
    return finalise(doc, buffer.toString("utf8"));
  } catch (err) {
    return {
      ...doc,
      extractionStatus: "EXTRACTION_FAILED",
      detail: `Could not decode ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Single entry point for turning an uploaded document into text.
 *
 * Never returns a silently empty document: every path sets a status that says
 * what happened, so the caller can refuse rather than answer about nothing.
 */
export async function extractDocument(
  buffer: Buffer, fileName: string, mimeType: string,
): Promise<DocumentContent> {
  const size = buffer.length;

  if (size === 0) {
    return {
      ...base(fileName, mimeType, 0),
      extractionStatus: "EMPTY_DOCUMENT",
      detail: `${fileName} is empty.`,
    };
  }

  if (mimeType === "application/pdf") return extractPdf(buffer, fileName, size);
  if (mimeType === DOCX_MIME || mimeType.includes("wordprocessing")) {
    return extractDocx(buffer, fileName, size);
  }
  if (TEXT_MIMES.has(mimeType) || mimeType.startsWith("text/")) {
    return extractPlainText(buffer, fileName, mimeType, size);
  }

  return {
    ...base(fileName, mimeType, size),
    extractionStatus: "UNSUPPORTED_FORMAT",
    detail: `${mimeType || "unknown type"} cannot be read for text.`,
  };
}

/** True when the document yielded text a model can actually work from. */
export function hasUsableText(doc: DocumentContent): boolean {
  return doc.extractionStatus === "EXTRACTED" && (doc.extractedText?.length ?? 0) > 0;
}
