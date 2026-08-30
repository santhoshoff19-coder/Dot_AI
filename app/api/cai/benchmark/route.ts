import { NextRequest } from "next/server";
import { caiBenchmark, CAI_THRESHOLDS } from "@/lib/cai/benchmark";
import { routingConfig } from "@/lib/routing/routing-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Candidate CAI classifiers to benchmark.
 *
 * Defaults to whichever model is configured as CAI, so this endpoint compares
 * against what is actually running rather than a hardcoded list. The three
 * ids that used to sit here were the same ones the removed Swift/Balanced/Deep
 * mappings pointed at, and leaving them would have kept a fixed model list in
 * production by another route. Callers pass their own candidates to compare
 * alternatives.
 */
const DEFAULT_CANDIDATES = [routingConfig.CAI_MODEL];

export async function GET() {
  return Response.json({
    latest: await caiBenchmark.latest(),
    thresholds: CAI_THRESHOLDS,
    configured: routingConfig.CAI_MODEL,
  });
}

export async function POST(req: NextRequest) {
  let candidates = DEFAULT_CANDIDATES;
  try {
    const body = (await req.json()) as { candidates?: string[] };
    if (Array.isArray(body.candidates) && body.candidates.length) candidates = body.candidates;
  } catch {
    /* defaults */
  }
  const report = await caiBenchmark.run(candidates);
  return Response.json(report);
}
