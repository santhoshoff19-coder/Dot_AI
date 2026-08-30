import { NextRequest } from "next/server";
import { extractDocument, hasUsableText } from "@/lib/documents/extract";
import { policyIngestion } from "@/lib/policy/ingest";
import { JURISDICTIONS, type Jurisdiction } from "@/lib/policy/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Ingests a policy document from an uploaded file.
 *
 * Reuses the same extractor the chat pipeline uses, so a PDF that chat can
 * read is a PDF the policy pack can read - and one that cannot be read is
 * rejected rather than ingested as an empty document.
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected a file upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file was received." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "File exceeds the 10 MB limit." }, { status: 413 });
  }

  const jurisdiction = String(form.get("jurisdiction") ?? "GLOBAL").toUpperCase();
  if (!JURISDICTIONS.includes(jurisdiction as Jurisdiction)) {
    return Response.json({ error: `Unknown jurisdiction '${jurisdiction}'.` }, { status: 400 });
  }

  const regulation = String(form.get("regulation") ?? "INTERNAL").slice(0, 60);
  const version = String(form.get("version") ?? "1.0").slice(0, 40);
  const name = String(form.get("name") ?? file.name).slice(0, 200);
  // Uploaded documents are real by default, unlike the shipped demo packs.
  const isDemo = String(form.get("isDemo") ?? "false") === "true";

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const content = await extractDocument(buffer, file.name, file.type);

    if (!hasUsableText(content)) {
      return Response.json({
        error: `No usable text could be extracted from ${file.name}.`,
        extractionStatus: content.extractionStatus,
        detail: content.detail,
      }, { status: 422 });
    }

    const result = await policyIngestion.ingestRaw(content.extractedText!, {
      name, jurisdiction: jurisdiction as Jurisdiction, regulation, version, isDemo,
      source: "UPLOAD",
    });

    return Response.json({
      ...result,
      fileName: file.name,
      wordCount: content.wordCount,
      pageCount: content.pageCount ?? null,
      extractionStatus: content.extractionStatus,
    });
  } catch (err) {
    return Response.json({
      error: "Ingestion failed.", detail: String(err),
    }, { status: 500 });
  }
}
