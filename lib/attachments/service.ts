import { promises as fs } from "fs";
import path from "path";
import { extractDocument } from "@/lib/documents/extract";
import type { AttachmentRef, AttachmentType } from "@/types";

export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

const ALLOWED_MIME = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "application/pdf", "text/plain", "text/markdown", "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "audio/webm", "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4",
]);

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

export function classify(mimeType: string): AttachmentType {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/pdf" ||
    mimeType === "application/json" ||
    mimeType.includes("wordprocessing")
  ) return "document";
  return "other";
}

export interface ValidationError { ok: false; error: string }
export interface ValidationOk { ok: true }

export function validate(file: { size: number; type: string; name: string }): ValidationOk | ValidationError {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: `${file.name} is larger than the 15 MB limit.` };
  }
  if (file.size === 0) return { ok: false, error: `${file.name} is empty.` };
  if (!ALLOWED_MIME.has(file.type)) {
    return { ok: false, error: `${file.type || "unknown type"} is not a supported file type.` };
  }
  return { ok: true };
}

/** Strips path separators so an upload can never escape the upload directory. */
export function safeName(name: string): string {
  return path.basename(name).replace(/[^\w.\-\s]/g, "_").slice(0, 120);
}

export class AttachmentService {
  async save(file: File): Promise<AttachmentRef> {
    const check = validate({ size: file.size, type: file.type, name: file.name });
    if (!check.ok) throw new Error(check.error);

    await fs.mkdir(UPLOAD_DIR, { recursive: true });

    const id = crypto.randomUUID();
    const clean = safeName(file.name);
    const stored = `${id}-${clean}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    // Uploads are written as inert bytes and are never executed.
    await fs.writeFile(path.join(UPLOAD_DIR, stored), buffer);

    const type = classify(file.type);
    let extractedText: string | null = null;
    let extractionStatus: string | undefined;
    let extractionDetail: string | undefined;
    let pageCount: number | undefined;

    // PDFs and DOCX files are actually read here, not merely stored. The
    // status travels with the attachment so downstream routing can refuse to
    // answer about a document it could not read.
    if (type === "document") {
      const content = await extractDocument(buffer, clean, file.type);
      extractedText = content.extractedText;
      extractionStatus = content.extractionStatus;
      extractionDetail = content.detail;
      pageCount = content.pageCount;
    }

    return {
      id,
      name: clean,
      mimeType: file.type,
      size: file.size,
      type,
      previewUrl: type === "image" ? `/uploads/${stored}` : null,
      storageRef: `/uploads/${stored}`,
      extractedText,
      extractionStatus,
      extractionDetail,
      pageCount,
    };
  }
}

export const attachmentService = new AttachmentService();
