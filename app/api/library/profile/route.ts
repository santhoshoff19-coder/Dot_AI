import { NextRequest } from "next/server";
import { currentUserId } from "@/lib/auth/identity";
import { library } from "@/lib/library/service";
import { handleError } from "@/lib/library/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const userId = await currentUserId();
    return Response.json({ profile: await library.getProfile(userId) });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await currentUserId();
    return Response.json(await library.saveProfile(userId, await req.json()));
  } catch (err) {
    return handleError(err);
  }
}
