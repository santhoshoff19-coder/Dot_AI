import { NextRequest } from "next/server";
import { z } from "zod";
import { modelExecution, type Modality } from "@/lib/models/execution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({
  modelId: z.string().min(1),
  modality: z.enum(["TEXT", "IMAGE", "AUDIO", "VIDEO", "EMBEDDING"]).optional(),
});

/** Manual execution revalidation: clears the cache, then re-checks. */
export async function POST(req: NextRequest) {
  try {
    const body = Schema.parse(await req.json());
    const cleared = await modelExecution.invalidate(body.modelId, body.modality as Modality);
    const result = body.modality
      ? await modelExecution.validateModel(body.modelId, body.modality as Modality)
      : null;
    return Response.json({ cleared, result });
  } catch (err) {
    return Response.json({ error: "Invalid request.", detail: String(err) }, { status: 400 });
  }
}

/** Probe spend, tracked separately from generation cost. */
export async function GET() {
  return Response.json(await modelExecution.probeSpend());
}
