import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

const CONTENT_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};

/**
 * Serves uploaded and generated files.
 *
 * Files written after the build are not served by Next's static handler, so
 * generated documents need this route. Only the basename is honoured, which
 * makes path traversal impossible regardless of what is requested.
 */
export async function GET(
  _req: Request, ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  const safe = path.basename(decodeURIComponent(name));
  const full = path.join(UPLOAD_DIR, safe);

  if (!full.startsWith(UPLOAD_DIR)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const file = await fs.readFile(full);
    const ext = path.extname(safe).toLowerCase();
    const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const isDownload = ext === ".docx" || ext === ".pdf";

    return new Response(new Uint8Array(file), {
      headers: {
        "Content-Type": type,
        "Content-Length": String(file.byteLength),
        "Cache-Control": "private, max-age=3600",
        // Documents download; images render inline.
        "Content-Disposition":
          `${isDownload ? "attachment" : "inline"}; filename="${safe.replace(/"/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
