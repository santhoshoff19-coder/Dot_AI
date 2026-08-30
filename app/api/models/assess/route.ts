import { NextRequest } from "next/server";
import { modelAssessment } from "@/lib/models/assessment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Assesses every unassessed model, or reassesses one by id. */
export async function POST(req: NextRequest) {
  let body: { modelId?: string; force?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* assess all */
  }

  if (body.modelId) {
    const outcome = await modelAssessment.reassessModel(body.modelId, { force: body.force });
    return Response.json(outcome);
  }
  return Response.json(await modelAssessment.assessNewModels());
}
