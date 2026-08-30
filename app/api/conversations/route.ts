import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await prisma.conversation.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { _count: { select: { messages: true } } },
    });
    return Response.json({
      conversations: rows.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt.toISOString(),
        messageCount: c._count.messages,
      })),
    });
  } catch (err) {
    return Response.json({ error: "Could not load conversations.", detail: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id." }, { status: 400 });
  try {
    await prisma.conversation.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
}
