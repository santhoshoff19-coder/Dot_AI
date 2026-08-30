import { prisma } from "@/lib/db";
import type { AttachmentRef } from "@/types";

export interface ContextTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AttachmentDigest {
  messageId: string;
  name: string;
  mimeType: string;
  type: string;
  /** Short excerpt so a later turn can refer to "that document". */
  excerpt: string | null;
  storageRef: string | null;
  turnsAgo: number;
}

export interface ConversationContext {
  /** Messages actually sent to the provider, oldest first. */
  turns: ContextTurn[];
  /** Compressed record of everything older than the recent window. */
  summary: string | null;
  /** Attachments seen earlier, so "that PDF" can be resolved. */
  attachments: AttachmentDigest[];
  totalMessages: number;
  includedMessages: number;
  summarisedMessages: number;
  estimatedTokens: number;
  /** Why the context looks the way it does. Useful in audit. */
  strategy: "FULL" | "RECENT_ONLY" | "SUMMARY_PLUS_RECENT" | "EMPTY";
}

/** Turns kept verbatim. Older turns are compressed instead. */
export const RECENT_TURNS = Number(process.env.CONTEXT_RECENT_TURNS ?? 10);
/** Hard ceiling on context tokens, so history can never dominate cost. */
export const MAX_CONTEXT_TOKENS = Number(process.env.CONTEXT_MAX_TOKENS ?? 3000);

const estTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Conversation context.
 *
 * Deliberately separate from SessionRiskService: that answers "how risky is
 * this conversation becoming", this answers "what was discussed". They share a
 * conversation id and nothing else.
 */
export class ConversationContextManager {
  /**
   * Builds the context for the next turn.
   *
   * Recent turns are sent verbatim; anything older is compressed into a
   * summary so a long conversation cannot grow the request without bound.
   */
  async build(
    conversationId: string | null | undefined,
    opts: { excludeMessageId?: string; maxTokens?: number } = {},
  ): Promise<ConversationContext> {
    const empty: ConversationContext = {
      turns: [], summary: null, attachments: [],
      totalMessages: 0, includedMessages: 0, summarisedMessages: 0,
      estimatedTokens: 0, strategy: "EMPTY",
    };
    if (!conversationId) return empty;

    const maxTokens = opts.maxTokens ?? MAX_CONTEXT_TOKENS;

    const all = await prisma.message.findMany({
      where: {
        conversationId,
        ...(opts.excludeMessageId ? { id: { not: opts.excludeMessageId } } : {}),
        role: { in: ["user", "assistant"] },
      },
      // Newest first so the *recent* window is taken, then reversed. Ordering
      // ascending with a take returns the oldest turns, which meant a long
      // conversation only ever showed the model how it began.
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { attachments: true },
    });

    if (all.length === 0) return empty;

    const chronological = [...all].reverse();
    const recent = chronological.slice(-RECENT_TURNS);
    const older = chronological.slice(0, Math.max(0, chronological.length - RECENT_TURNS));

    let turns: ContextTurn[] = recent
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // The summary must live inside the budget too - an unbounded summary of a
    // long conversation would blow the very ceiling it exists to respect.
    const summaryBudgetTokens = Math.floor(maxTokens * 0.35);
    let summary = older.length ? summarise(older) : null;
    if (summary && estTokens(summary) > summaryBudgetTokens) {
      summary = `${summary.slice(0, summaryBudgetTokens * 4 - 30)}\n(summary truncated)`;
    }

    // Trim from the oldest end until the budget is met. The current request
    // matters more than conversation history, so history yields first.
    let budget = maxTokens - (summary ? estTokens(summary) : 0);
    while (turns.length > 1 && tokensOf(turns) > budget) turns = turns.slice(1);

    // If even one turn plus the summary will not fit, truncate the turn rather
    // than dropping the summary: the summary carries more information per token.
    if (turns.length === 1 && tokensOf(turns) > budget && budget > 100) {
      turns = [{ ...turns[0], content: turns[0].content.slice(0, budget * 4) }];
    }

    const attachments = collectAttachments(chronological);

    return {
      turns,
      summary,
      attachments,
      totalMessages: chronological.length,
      includedMessages: turns.length,
      summarisedMessages: older.length,
      estimatedTokens: tokensOf(turns) + (summary ? estTokens(summary) : 0),
      strategy: older.length
        ? "SUMMARY_PLUS_RECENT"
        : turns.length < recent.length ? "RECENT_ONLY" : "FULL",
    };
  }

  /**
   * The history array handed to the provider. The summary rides as a leading
   * assistant note so no provider-specific system-message support is needed.
   */
  toProviderHistory(context: ConversationContext): ContextTurn[] {
    const out: ContextTurn[] = [];

    if (context.summary) {
      out.push({
        role: "assistant",
        content: `[Earlier in this conversation]\n${context.summary}`,
      });
    }

    if (context.attachments.length) {
      const refs = context.attachments
        .map((a) => `- ${a.name} (${a.type})${a.excerpt ? `: ${a.excerpt}` : ""}`)
        .join("\n");
      out.push({
        role: "assistant",
        content: `[Files shared earlier in this conversation]\n${refs}`,
      });
    }

    return [...out, ...context.turns];
  }

  /**
   * A compact digest for the classifier, so a follow-up like "make it blue"
   * can be understood. Deliberately short: CAI is a cheap classifier and must
   * not be handed the whole conversation.
   */
  toClassifierContext(context: ConversationContext, maxChars = 600): string {
    if (context.turns.length === 0 && !context.summary) return "";
    const lastTurns = context.turns.slice(-4)
      .map((t) => `${t.role}: ${t.content.slice(0, 200)}`)
      .join("\n");
    const files = context.attachments.length
      ? `\nfiles: ${context.attachments.map((a) => a.name).join(", ")}`
      : "";
    return `${context.summary ? `summary: ${context.summary}\n` : ""}${lastTurns}${files}`
      .slice(0, maxChars);
  }

  /** The most recent attachment of a kind, for resolving "that document". */
  mostRecentAttachment(
    context: ConversationContext, type?: "image" | "document",
  ): AttachmentDigest | null {
    const candidates = type
      ? context.attachments.filter((a) => a.type === type)
      : context.attachments;
    return candidates.length ? candidates[candidates.length - 1] : null;
  }
}

function tokensOf(turns: ContextTurn[]): number {
  return turns.reduce((n, t) => n + estTokens(t.content), 0);
}

/**
 * Extractive summary of older turns.
 *
 * Deliberately deterministic and free: summarising with a model would add a
 * per-turn LLM call to every long conversation, which is exactly the cost the
 * router exists to avoid. It keeps what follow-up questions actually rely on -
 * what the user stated, and what the assistant concluded.
 */
export function summarise(messages: { role: string; content: string }[]): string {
  const facts: string[] = [];

  for (const m of messages) {
    const text = m.content.replace(/\s+/g, " ").trim();
    if (!text) continue;

    if (m.role === "user") {
      // The user's own statements are the most load-bearing context.
      facts.push(`User said: ${text.slice(0, 220)}`);
    } else {
      // For assistant turns the opening sentence usually carries the answer.
      const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
      facts.push(`Assistant answered: ${first.slice(0, 220)}`);
    }
  }

  // Keep the earliest facts (where projects and constraints are established)
  // and the latest (nearest to the current turn).
  const kept = facts.length <= 12
    ? facts
    : [...facts.slice(0, 6), `(${facts.length - 12} further turns omitted)`, ...facts.slice(-6)];

  return kept.join("\n");
}

function collectAttachments(
  messages: { id: string; attachments: { name: string; mimeType: string; type: string; previewUrl: string | null; storageRef: string | null; extractedText: string | null }[] }[],
): AttachmentDigest[] {
  const out: AttachmentDigest[] = [];
  messages.forEach((m, i) => {
    for (const a of m.attachments ?? []) {
      if (a.name === "generated-image") continue;
      out.push({
        messageId: m.id,
        name: a.name,
        mimeType: a.mimeType,
        type: a.type,
        excerpt: a.extractedText ? a.extractedText.replace(/\s+/g, " ").slice(0, 300) : null,
        storageRef: a.storageRef,
        turnsAgo: messages.length - i,
      });
    }
  });
  return out;
}

/** Rebuilds an AttachmentRef from a digest, so a later turn can reuse a file. */
export function digestToAttachment(d: AttachmentDigest): AttachmentRef {
  return {
    id: `ctx-${d.messageId}`,
    name: d.name,
    mimeType: d.mimeType,
    size: 0,
    type: d.type as AttachmentRef["type"],
    previewUrl: null,
    storageRef: d.storageRef,
    extractedText: d.excerpt,
  };
}

export const conversationContext = new ConversationContextManager();
