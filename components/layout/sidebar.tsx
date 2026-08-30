"use client";

import {
  Activity, BarChart3, BookMarked, ChevronDown, Database, History, Menu,
  MessageCircle, MessageSquarePlus, Scale, Search, Settings, ShieldCheck, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn, relativeTime } from "@/lib/utils";
import type { ConversationSummary } from "@/types";

/**
 * Nav entries. An entry with `children` is a group: it expands in place and
 * links to its own pages, which are unchanged and keep their routes.
 */
const NAV = [
  { href: "/history", label: "History", icon: History },
  { href: "/library", label: "Library", icon: BookMarked },
  { href: "/models", label: "Models", icon: Database },
  { href: "/policy", label: "Policy & Audit", icon: Scale },
  {
    // Metrics, Control and Usage all answer "how is this performing, and was
    // it right?", so they sit together rather than as three peers.
    label: "Feedback",
    icon: MessageCircle,
    children: [
      { href: "/metrics", label: "Metrics", icon: Activity },
      { href: "/control", label: "Control", icon: ShieldCheck },
      { href: "/usage", label: "Usage", icon: BarChart3 },
    ],
  },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  /** Groups the user has opened by hand, in addition to the active one. */
  const [openGroups, setOpenGroups] = React.useState<string[]>([]);
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/conversations");
        if (!res.ok) return;
        const data = (await res.json()) as { conversations: ConversationSummary[] };
        if (!cancelled) setConversations(data.conversations);
      } catch { /* sidebar degrades to empty */ }
    })();
    return () => { cancelled = true; };
  }, [pathname]);

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      {/* mobile toggle */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="fixed left-3 top-3 z-30 md:hidden"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[264px] shrink-0 flex-col border-r border-line bg-surface transition-transform md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 py-3.5">
          <Link href="/chat" className="flex items-center gap-2 focus-ring rounded-md">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 hairline border-accent/25">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">dotAI</span>
          </Link>
          <Button
            variant="ghost" size="icon-sm" onClick={() => setOpen(false)}
            aria-label="Close menu" className="md:hidden"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-3">
          <Button
            variant="secondary"
            className="w-full justify-start"
            onClick={() => { router.push("/chat"); setOpen(false); }}
          >
            <MessageSquarePlus className="h-4 w-4" />
            New chat
          </Button>
        </div>

        <div className="px-3 pt-3">
          <div className="flex items-center gap-2 rounded-lg bg-elevated hairline px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-muted/70"
            />
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 pt-4">
          <p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-wider text-muted/70">
            Recent
          </p>
          <ul className="space-y-0.5">
            {filtered.length === 0 && (
              <li className="px-2 py-1.5 text-[12px] text-muted/60">No conversations yet</li>
            )}
            {filtered.slice(0, 20).map((c) => (
              <li key={c.id}>
                <Link
                  href={`/chat?c=${c.id}`}
                  onClick={() => setOpen(false)}
                  className="block truncate rounded-lg px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-elevated hover:text-ink focus-ring"
                  title={c.title}
                >
                  {c.title}
                  <span className="ml-1 text-[11px] text-muted/50">{relativeTime(c.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-line p-3">
          <ul className="space-y-0.5">
            {NAV.map((n) => {
              const Icon = n.icon;

              if (!n.children) {
                const active = pathname === n.href;
                return (
                  <li key={n.href}>
                    <Link
                      href={n.href!}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors focus-ring",
                        active ? "bg-elevated text-ink" : "text-muted hover:bg-elevated hover:text-ink",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {n.label}
                    </Link>
                  </li>
                );
              }

              // A group. Open when one of its pages is showing, or when the
              // user opened it — so landing on /usage directly does not hide
              // where you are.
              const inGroup = n.children.some((c) => pathname === c.href);
              const expanded = inGroup || openGroups.includes(n.label);

              return (
                <li key={n.label}>
                  <button
                    type="button"
                    onClick={() => setOpenGroups((g) =>
                      g.includes(n.label) ? g.filter((x) => x !== n.label) : [...g, n.label])}
                    aria-expanded={expanded}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors focus-ring",
                      inGroup ? "text-ink" : "text-muted hover:bg-elevated hover:text-ink",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {n.label}
                    <ChevronDown
                      className={cn("ml-auto h-3.5 w-3.5 transition-transform",
                        expanded && "rotate-180")}
                    />
                  </button>

                  {expanded && (
                    <ul className="mt-0.5 space-y-0.5 border-l border-line pl-2.5 ml-3">
                      {n.children.map((c) => {
                        const CIcon = c.icon;
                        const active = pathname === c.href;
                        return (
                          <li key={c.href}>
                            <Link
                              href={c.href}
                              onClick={() => setOpen(false)}
                              className={cn(
                                "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors focus-ring",
                                active ? "bg-elevated text-ink" : "text-muted hover:bg-elevated hover:text-ink",
                              )}
                            >
                              <CIcon className="h-4 w-4" />
                              {c.label}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </>
  );
}
