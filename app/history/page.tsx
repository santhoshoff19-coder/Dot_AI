import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { prisma } from "@/lib/db";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const conversations = await prisma.conversation.findMany({
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { _count: { select: { messages: true } } },
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="History" subtitle="Resume any previous conversation." />
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {conversations.length === 0 ? (
          <p className="text-[13px] text-muted">
            No conversations yet. <Link href="/chat" className="text-accent-soft underline">Start one.</Link>
          </p>
        ) : (
          <ul className="mx-auto max-w-3xl space-y-1.5">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/chat?c=${c.id}`}
                  className="flex items-center gap-3 rounded-xl bg-surface hairline px-4 py-3 transition-colors hover:border-accent/40 hover:bg-elevated focus-ring"
                >
                  <MessageSquare className="h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-ink">{c.title}</span>
                    <span className="text-[11px] text-muted">
                      {c._count.messages} message{c._count.messages === 1 ? "" : "s"} · {relativeTime(c.updatedAt.toISOString())}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
