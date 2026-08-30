import { NextRequest } from "next/server";
import { z } from "zod";
import {
  clearOpenRouterKey, credentialStatus, setOpenRouterKey, testOpenRouterKey,
} from "@/lib/credentials/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({ key: z.string().min(10).max(300) });

/** Connection status only. The key itself is never returned. */
export async function GET() {
  return Response.json(await credentialStatus());
}

export async function POST(req: NextRequest) {
  let key: string;
  try {
    key = Schema.parse(await req.json()).key.trim();
  } catch {
    return Response.json({ error: "A valid key is required." }, { status: 400 });
  }

  // Validate before persisting so a bad key is never stored.
  const test = await testOpenRouterKey(key);
  if (!test.ok) {
    return Response.json({ error: test.detail, connected: false }, { status: 400 });
  }

  await setOpenRouterKey(key);
  return Response.json({ ...(await credentialStatus()), detail: test.detail });
}

export async function DELETE() {
  await clearOpenRouterKey();
  return Response.json(await credentialStatus());
}
