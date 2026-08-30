import { NextRequest } from "next/server";
import { z } from "zod";
import { routeQuery } from "@/lib/intelligence/curated-routing";
import { routingFromDecision } from "@/lib/intelligence/cai-routing-result";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AttachmentSchema = z.object({
  id: z.string(),
  name: z.string().max(300),
  mimeType: z.string().max(200),
  size: z.number().int().nonnegative(),
  type: z.enum(["image", "document", "audio", "other"]),
  previewUrl: z.string().nullable().optional(),
  storageRef: z.string().nullable().optional(),
  extractedText: z.string().nullable().optional(),
});

const Schema = z.object({
  prompt: z.string().min(1).max(20_000),
  attachments: z.array(AttachmentSchema).max(10).default([]),
  previousModelId: z.string().nullable().optional(),
  settings: z.object({
    autoMode: z.boolean(),
    effort: z.enum(["AUTO", "low", "medium", "high"]),
    verification: z.enum(["AUTO", "STANDARD", "STRICT"]),
    costPreference: z.enum(["LOWEST", "BALANCED", "BEST_QUALITY"]),
  }).partial().default({}),
});

/**
 * Routing only - no generation, no tokens spent on an answer.
 *
 * The UI calls this to show the three model options before committing, and it
 * runs the same single classification path the chat execution path does: CAI
 * classifies, the curated dataset supplies eligibility, and the three tiers
 * follow. It used to call the old orchestrator, which meant manual mode saw a
 * different classification and a different shortlist from the one that would
 * actually execute.
 */
export async function POST(req: NextRequest) {
  try {
    const body = Schema.parse(await req.json());
    const capability = await routeQuery({
      prompt: body.prompt,
      attachments: body.attachments.map((a) => ({ type: a.type })),
    });
    const routing = routingFromDecision(
      capability, capability.analysis.telemetry.costUsd);

    // The analysis travels with the result so the chooser can show the path
    // from query to shortlist.
    return Response.json({ ...routing, capability });
  } catch (err) {
    return Response.json(
      { error: "Routing failed.", detail: String(err) }, { status: 400 });
  }
}
