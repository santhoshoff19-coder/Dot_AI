import { NextRequest } from "next/server";
import { z } from "zod";
import { batchAudit } from "@/lib/audit/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Schema = z.object({
  strategy: z.enum(["RANDOM", "RISK_BASED", "MODEL_BASED", "PROFILE_BASED"]).default("RISK_BASED"),
  sampleSize: z.number().int().min(1).max(200).default(25),
  profileId: z.string().optional(),
  modelId: z.string().optional(),
  maxDeepChecks: z.number().int().min(0).max(50).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = Schema.parse(await req.json().catch(() => ({})));
    return Response.json(await batchAudit.run(body));
  } catch (err) {
    return Response.json({ error: "Batch audit failed.", detail: String(err) }, { status: 400 });
  }
}

export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get("runId");
  if (runId) {
    return Response.json({ findings: await batchAudit.findingsFor(runId) });
  }
  return Response.json({ runs: await batchAudit.listRuns() });
}
