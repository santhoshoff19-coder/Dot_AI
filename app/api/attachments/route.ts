import { NextRequest } from "next/server";
import { attachmentService, MAX_FILE_BYTES } from "@/lib/attachments/service";
import type { AttachmentRef } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (!files.length) {
      return Response.json({ error: "No files were provided." }, { status: 400 });
    }
    if (files.length > 10) {
      return Response.json({ error: "A maximum of 10 files can be attached." }, { status: 400 });
    }

    const saved: AttachmentRef[] = [];
    const errors: string[] = [];

    for (const file of files) {
      try {
        saved.push(await attachmentService.save(file));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return Response.json({ attachments: saved, errors, maxBytes: MAX_FILE_BYTES });
  } catch (err) {
    return Response.json(
      { error: "Upload failed.", detail: String(err) }, { status: 500 });
  }
}
