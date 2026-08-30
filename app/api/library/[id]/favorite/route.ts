import { currentUserId } from "@/lib/auth/identity";
import { library } from "@/lib/library/service";
import { handleError } from "@/lib/library/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return Response.json(await library.toggleFavorite(await currentUserId(), id));
  } catch (err) {
    return handleError(err);
  }
}
