import { prisma } from "@/lib/db";
import type { ChatMessage, ControlEventData } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          include: { attachments: true, controlEvent: true },
        },
      },
    });
    if (!conv) return Response.json({ error: "Conversation not found." }, { status: 404 });

    const messages: ChatMessage[] = conv.messages.map((m) => {
      let controlEvent: ControlEventData | null = null;
      if (m.controlEvent?.payload) {
        try {
          controlEvent = JSON.parse(m.controlEvent.payload) as ControlEventData;
        } catch {
          controlEvent = null;
        }
      }
      const generated = m.attachments.find(
        (a) => a.name === "generated-image" && a.previewUrl);
      return {
        id: m.id,
        image: generated
          ? { url: generated.previewUrl!, mimeType: generated.mimeType, simulated: false }
          : null,
        conversationId: m.conversationId,
        role: m.role as ChatMessage["role"],
        content: m.content,
        status: m.status as ChatMessage["status"],
        createdAt: m.createdAt.toISOString(),
        attachments: m.attachments.filter((a) => a.name !== "generated-image").map((a) => ({
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
          type: a.type as "image" | "document" | "audio" | "other",
          previewUrl: a.previewUrl,
          storageRef: a.storageRef,
        })),
        controlEvent,
      };
    });

    return Response.json({ id: conv.id, title: conv.title, messages });
  } catch (err) {
    return Response.json(
      { error: "Could not load conversation.", detail: String(err) },
      { status: 500 },
    );
  }
}
