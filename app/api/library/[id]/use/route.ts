import { NextRequest } from "next/server";
import { currentUserId } from "@/lib/auth/identity";
import { library } from "@/lib/library/service";
import { handleError } from "@/lib/library/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolves a Library prompt into the text the normal pipeline will run.
 *
 * It deliberately does NOT call a model. The caller posts the returned prompt
 * to /api/chat, so a Library run goes through CAI, model selection,
 * ControlPlane and audit exactly like anything typed into the chat box.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const userId = await currentUserId();
    const body = (await req.json().catch(() => ({}))) as {
      values?: Record<string, string>;
    };

    const prepared = await library.prepare(userId, id, body.values ?? {});
    return Response.json({
      promptId: id,
      filledPrompt: prepared.filledPrompt,
      outputModality: prepared.outputModality,
      inputModality: prepared.inputModality,
      taskType: prepared.prompt.taskType,
      version: prepared.prompt.version,
    });
  } catch (err) {
    return handleError(err);
  }
}
