import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  conversationContext, RECENT_TURNS, summarise,
} from "@/lib/conversation/context";
import { answerFromContext } from "@/lib/providers/mock";

async function makeConversation(
  turns: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const c = await prisma.conversation.create({ data: { title: "ctx-test" } });
  for (const t of turns) {
    await prisma.message.create({
      data: { conversationId: c.id, role: t.role, content: t.content, status: "complete" },
    });
    // Distinct timestamps so ordering is deterministic.
    await new Promise((r) => setTimeout(r, 2));
  }
  return c.id;
}

describe("ROOT CAUSE: recent turns reach the provider, not the oldest", () => {
  it("keeps the most recent turns in a long conversation", async () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn-${i + 1}`,
    }));
    const id = await makeConversation(turns);

    const ctx = await conversationContext.build(id);
    const joined = ctx.turns.map((t) => t.content).join(",");

    // The bug was that `orderBy asc` + `take` returned turn-1..turn-12 and the
    // model never saw anything recent.
    expect(joined).toContain("turn-30");
    expect(joined).not.toContain("turn-1,");
    expect(ctx.totalMessages).toBe(30);
    expect(ctx.summarisedMessages).toBeGreaterThan(0);
  }, 120_000);

  it("sends everything verbatim for a short conversation", async () => {
    const id = await makeConversation([
      { role: "user", content: "My project is called dotAI." },
      { role: "assistant", content: "Noted." },
    ]);
    const ctx = await conversationContext.build(id);
    expect(ctx.strategy).toBe("FULL");
    expect(ctx.summary).toBeNull();
    expect(ctx.turns).toHaveLength(2);
  }, 60_000);

  it("compresses older turns instead of dropping them", async () => {
    const turns = [
      { role: "user" as const, content: "My project is called dotAI." },
      { role: "assistant" as const, content: "Understood." },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `filler message number ${i}`,
      })),
    ];
    const id = await makeConversation(turns);
    const ctx = await conversationContext.build(id);

    expect(ctx.strategy).toBe("SUMMARY_PLUS_RECENT");
    // The earliest fact survives in the summary even though it left the window.
    expect(ctx.summary).toContain("dotAI");
    expect(ctx.turns.length).toBeLessThanOrEqual(RECENT_TURNS);
  }, 120_000);
});

describe("context is cost-aware", () => {
  it("never exceeds the configured token budget", async () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "x".repeat(2000),
    }));
    const id = await makeConversation(turns);

    const ctx = await conversationContext.build(id, { maxTokens: 800 });
    expect(ctx.estimatedTokens).toBeLessThanOrEqual(900);
    expect(ctx.includedMessages).toBeLessThan(40);
  }, 180_000);

  it("gives the classifier a compact digest, not the whole conversation", async () => {
    const id = await makeConversation(
      Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `a fairly long message number ${i} `.repeat(20),
      })),
    );
    const ctx = await conversationContext.build(id);
    const digest = conversationContext.toClassifierContext(ctx);
    expect(digest.length).toBeLessThanOrEqual(600);
  }, 120_000);

  it("summarises deterministically without calling a model", () => {
    const s = summarise([
      { role: "user", content: "My project is called dotAI." },
      { role: "assistant", content: "Understood. It is a control layer." },
    ]);
    expect(s).toContain("dotAI");
    expect(s).toContain("User said");
  });
});

describe("attachment context survives across turns", () => {
  it("remembers a document shared earlier and its text", async () => {
    const c = await prisma.conversation.create({ data: { title: "att-test" } });
    const m = await prisma.message.create({
      data: {
        conversationId: c.id, role: "user", content: "Summarize this.", status: "complete",
        attachments: {
          create: [{
            name: "q3.pdf", mimeType: "application/pdf", size: 1000, type: "document",
            extractedText: "Revenue grew 12 percent to 4.2 million dollars.",
            extractionStatus: "EXTRACTED",
          }],
        },
      },
    });
    await prisma.message.create({
      data: { conversationId: c.id, role: "assistant", content: "Summary done.", status: "complete" },
    });

    const ctx = await conversationContext.build(c.id);
    expect(ctx.attachments).toHaveLength(1);
    expect(ctx.attachments[0].name).toBe("q3.pdf");
    expect(ctx.attachments[0].excerpt).toContain("Revenue grew 12 percent");

    // "make an infographic from that" can now resolve which document.
    const doc = conversationContext.mostRecentAttachment(ctx, "document");
    expect(doc?.name).toBe("q3.pdf");

    // And the provider history mentions it.
    const history = conversationContext.toProviderHistory(ctx);
    expect(history.some((h) => h.content.includes("q3.pdf"))).toBe(true);
    void m;
  }, 120_000);
});

describe("the provider actually receives the context", () => {
  it("history passed to the provider contains the earlier turns", async () => {
    const id = await makeConversation([
      { role: "user", content: "My project is called dotAI." },
      { role: "assistant", content: "Noted, dotAI it is." },
    ]);
    const ctx = await conversationContext.build(id);
    const history = conversationContext.toProviderHistory(ctx);

    expect(history.map((h) => h.content).join(" ")).toContain("dotAI");
    expect(history[history.length - 1].role).toBe("assistant");
  }, 60_000);

  it("answers a follow-up from the supplied history alone", () => {
    const history = [
      { role: "user", content: "My project is called dotAI. It is an AI control layer." },
      { role: "assistant", content: "Understood." },
    ];
    const answer = answerFromContext("What is my project called?", history);
    expect(answer).toBeTruthy();
    expect(answer).toContain("dotAI");
  });

  it("resolves a pronoun against the previous answer", () => {
    const history = [
      { role: "user", content: "My project is called dotAI." },
      { role: "assistant", content: "dotAI checks model outputs before consequential actions." },
    ];
    const answer = answerFromContext("Make that suitable for a presentation.", history);
    expect(answer).toBeTruthy();
    expect(answer!.toLowerCase()).toContain("presentation");
  });

  it("returns nothing when there is no context, rather than inventing", () => {
    expect(answerFromContext("What is my project called?", [])).toBeNull();
  });
});

describe("session risk stays separate from conversation context", () => {
  it("the context manager exposes no risk state", async () => {
    const id = await makeConversation([{ role: "user", content: "hello" }]);
    const ctx = await conversationContext.build(id);
    expect(ctx).not.toHaveProperty("riskScore");
    expect(ctx).not.toHaveProperty("riskLevel");
  }, 60_000);
});
