import { NextRequest } from "next/server";
import { z } from "zod";
import { getOpenRouterKey, testOpenRouterKey } from "@/lib/credentials/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({ key: z.string().min(10).max(300).optional() });

/** Tests a supplied key, or the stored one when none is supplied. */
export async function POST(req: NextRequest) {
  let supplied: string | undefined;
  try {
    supplied = Schema.parse(await req.json().catch(() => ({}))).key;
  } catch {
    supplied = undefined;
  }

  const key = supplied ?? (await getOpenRouterKey());
  if (!key) {
    return Response.json({ ok: false, detail: "No OpenRouter key is configured." }, { status: 400 });
  }
  return Response.json(await testOpenRouterKey(key));
}
