import { Suspense } from "react";
import { ChatView } from "@/components/chat/chat-view";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { c } = await searchParams;
  return (
    <Suspense fallback={<div className="p-6 text-[13px] text-muted">Loading…</div>}>
      <ChatView key={c ?? "new"} conversationId={c} />
    </Suspense>
  );
}
