import { promises as fs } from "fs";
import path from "path";
import type { AttachmentRef } from "@/types";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

/** Image types OpenRouter accepts as inline image content. */
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export class AttachmentEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentEncodeError";
  }
}

/**
 * Encodes an uploaded image as a data URL for transmission to a vision model.
 *
 * Uploads are stored on disk and referenced by path, not inlined. Without this
 * step the image is silently dropped from the request and the model answers as
 * though no image were attached - so a failure here throws rather than
 * returning nothing.
 */
export async function toImageDataUrl(a: AttachmentRef): Promise<string> {
  if (a.previewUrl?.startsWith("data:")) return a.previewUrl;

  if (!IMAGE_MIME.has(a.mimeType)) {
    throw new AttachmentEncodeError(
      `${a.name}: ${a.mimeType || "unknown type"} cannot be sent to a vision model.`);
  }

  const ref = a.storageRef ?? a.previewUrl;
  if (!ref) {
    throw new AttachmentEncodeError(`${a.name}: no stored file to read.`);
  }

  // Resolve inside the upload directory only; a crafted reference must never
  // be able to read an arbitrary file.
  const filename = path.basename(ref);
  const full = path.join(UPLOAD_DIR, filename);
  if (!full.startsWith(UPLOAD_DIR)) {
    throw new AttachmentEncodeError(`${a.name}: invalid storage reference.`);
  }

  try {
    const bytes = await fs.readFile(full);
    return `data:${a.mimeType};base64,${bytes.toString("base64")}`;
  } catch (err) {
    throw new AttachmentEncodeError(
      `${a.name}: could not be read for transmission (${err instanceof Error ? err.message : "unknown"}).`);
  }
}

export const isEncodableImage = (a: AttachmentRef): boolean =>
  a.type === "image" && (IMAGE_MIME.has(a.mimeType) || Boolean(a.previewUrl?.startsWith("data:")));
