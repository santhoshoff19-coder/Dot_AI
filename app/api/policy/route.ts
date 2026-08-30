import { NextRequest } from "next/server";
import { z } from "zod";
import { getProfile } from "@/lib/governance/profiles";
import { policyIngestion } from "@/lib/policy/ingest";
import {
  normaliseJurisdiction, policyDecisionEngine, policyRetrieval,
} from "@/lib/policy/engine";
import { JURISDICTIONS } from "@/lib/policy/taxonomy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({
  riskCategories: z.array(z.string()).min(1),
  // Retained for request compatibility; there is one governance policy.
  profileId: z.string().default("BASELINE"),
  jurisdiction: z.enum(JURISDICTIONS).optional(),
  external: z.boolean().default(false),
  actionName: z.string().nullable().optional(),
  actionValueUsd: z.number().default(0),
  topK: z.number().int().min(1).max(10).optional(),
});

/**
 * Evaluates the policy layer alone, so the retrieval and decision can be
 * inspected without running a generation.
 */
export async function POST(req: NextRequest) {
  try {
    const body = Schema.parse(await req.json());
    await policyIngestion.ensureSeeded();

    const profile = getProfile(body.profileId);
    const jurisdictions = body.jurisdiction
      ? [body.jurisdiction]
      : [...new Set(profile.jurisdiction.map(normaliseJurisdiction))];

    const retrieval = await policyRetrieval.retrieve({
      riskCategories: body.riskCategories,
      external: body.external,
      actionName: body.actionName ?? null,
      jurisdictions,
      topK: body.topK,
    });

    const verdict = policyDecisionEngine.decide({
      profile, jurisdictions,
      riskCategories: body.riskCategories,
      dataTypes: [],
      external: body.external,
      actionName: body.actionName ?? null,
      actionValueUsd: body.actionValueUsd,
      evidence: retrieval.evidence,
      retrievalMode: retrieval.mode,
    });

    return Response.json({
      profile: { id: profile.id, name: profile.name },
      jurisdictions,
      retrieval: {
        mode: retrieval.mode, model: retrieval.model,
        query: retrieval.query, filters: retrieval.filters,
        evidence: retrieval.evidence,
      },
      verdict,
    });
  } catch (err) {
    return Response.json({ error: "Policy evaluation failed.", detail: String(err) }, { status: 400 });
  }
}
