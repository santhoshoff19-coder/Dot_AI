import { NextRequest } from "next/server";
import { z } from "zod";
import { policyIngestion } from "@/lib/policy/ingest";
import { POLICY_CATEGORIES, JURISDICTIONS } from "@/lib/policy/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await policyIngestion.ensureSeeded();
  const documents = await policyIngestion.listDocuments();
  return Response.json({
    documents,
    categories: POLICY_CATEGORIES,
    jurisdictions: JURISDICTIONS,
    notice:
      "Demo policy packs are plain-English summaries written for this prototype. " +
      "They are not legal text and do not establish compliance.",
  });
}

const Ingest = z.object({
  name: z.string().min(1).max(200),
  jurisdiction: z.enum(JURISDICTIONS),
  regulation: z.string().min(1).max(60),
  version: z.string().min(1).max(40),
  text: z.string().min(1).max(200_000),
  sourceUrl: z.string().url().optional(),
  isDemo: z.boolean().default(true),
});

/** Ingests a plain-text or markdown policy document. */
export async function POST(req: NextRequest) {
  try {
    const body = Ingest.parse(await req.json());
    const result = await policyIngestion.ingestRaw(body.text, {
      name: body.name,
      jurisdiction: body.jurisdiction,
      regulation: body.regulation,
      version: body.version,
      sourceUrl: body.sourceUrl,
      isDemo: body.isDemo,
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: "Ingestion failed.", detail: String(err) }, { status: 400 });
  }
}
