import { NextRequest } from "next/server";
import { currentUserId } from "@/lib/auth/identity";
import { library } from "@/lib/library/service";
import { handleError } from "@/lib/library/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const userId = await currentUserId();
    const prompt = await library.get(userId, id);
    const usage = await library.usageFor(userId, id);
    return Response.json({ prompt, usage });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const userId = await currentUserId();
    return Response.json(await library.update(userId, id, await req.json()));
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const userId = await currentUserId();
    return Response.json(await library.remove(userId, id));
  } catch (err) {
    return handleError(err);
  }
}
