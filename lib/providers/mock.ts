import { modelRegistry } from "@/lib/models/registry";
import type { GenerationRequest, GenerationResult, ModelSpec } from "@/types";
import type { LLMProvider, StreamChunk } from "./types";

/**
 * Deterministic offline provider. Reproduces the demo scenarios so the whole
 * control loop is demonstrable without any API key.
 */
const SCRIPTS: { match: RegExp; text: string }[] = [
  {
    // Scenario A - hallucination: contradicts the evidence store ($6,420).
    match: /\b(balance|how much.*(have|owe))\b/i,
    text:
      "John's account balance is $8,420.00 as of today. This figure is confirmed " +
      "against the customer ledger and reflects all settled transactions.",
  },
  {
    // Scenario C - responsibility: PII heading to an external destination.
    match: /(account number|send .*(statement|details).*(email|external))/i,
    text:
      "Certainly. John Smith's account number is 4488-1234-5678 and the current " +
      "balance is $6,420.00. I have prepared the statement and addressed it to " +
      "the external recipient as requested.",
  },
  {
    // Scenario D - high-risk action.
    match: /(approve|authorise|authorize).*(payment|transfer|\$)/i,
    text:
      "I have reviewed the request and recommend approving the payment of " +
      "$50,000 to the vendor account on file. The supporting invoice appears " +
      "consistent with the purchase order.",
  },
  {
    match: /refund/i,
    text:
      "Based on the customer's history I recommend issuing a full refund of " +
      "$4,800 and confirming by email once processed.",
  },
  {
    // Scenario B - cost optimisation: a short, cheap summarisation task.
    match: /summar(ise|ize)/i,
    text:
      "Here is a concise summary.\n\n" +
      "- The document sets out the quarterly operating position and highlights " +
      "three areas of change.\n" +
      "- Revenue moved in line with the prior period, with the largest variance " +
      "in the services line.\n" +
      "- Two actions are proposed for the next cycle, both owned by the " +
      "operations team.\n\n" +
      "Ask me to expand any section and I will go deeper.",
  },
  {
    match: /(hello|hi|hey)\b/i,
    text: "Hello. What would you like to work on? You can type, attach a file, or use voice input.",
  },
];

const DEFAULT_TEXT =
  "Here is a considered response to your request.\n\n" +
  "dotAI routed this to a model chosen for the shape of the task rather than " +
  "raw capability, then verified the result before returning it. You can open " +
  "Control Details to see the model choice, the cost, and every check that ran.";

function pick(prompt: string): string {
  for (const s of SCRIPTS) if (s.match.test(prompt)) return s.text;
  return DEFAULT_TEXT;
}

/**
 * Answers follow-up questions from the supplied history.
 *
 * The mock provider used to ignore history entirely, which meant multi-turn
 * context could not be demonstrated or tested without a real key. This is a
 * deliberately literal retrieval over what the caller actually sent: if the
 * context is missing, the mock says so rather than inventing an answer.
 */
export function answerFromContext(
  prompt: string,
  history: { role: string; content: string }[],
): string | null {
  if (history.length === 0) return null;

  const q = prompt.toLowerCase();
  const userTurns = history.filter((h) => h.role === "user");
  const assistantTurns = history.filter((h) => h.role === "assistant");
  const haystack = history.map((h) => h.content).join("\n");

  // "what is my project called" / "what did I say X was"
  const named = /\b(?:my|the)\s+([a-z ]{2,20}?)\s+is\s+(?:called\s+)?([A-Za-z0-9][\w-]*)/i
    .exec(haystack);
  if (/\bwhat(?:'s| is)?\b.*\b(?:called|named|name)\b/.test(q) && named) {
    return `Your ${named[1].trim()} is called ${named[2]}.`;
  }

  // Pronoun follow-ups: "describe it", "an example of that".
  if (/\b(it|that|this|them|those)\b/.test(q)) {
    const subject = named?.[2] ?? lastNoun(userTurns);
    const priorAnswer = assistantTurns.at(-1)?.content ?? "";

    if (/\bpresentation\b|\bslide\b/.test(q) && priorAnswer) {
      return `Reworked for a presentation:\n\n${firstSentence(priorAnswer)}`;
    }
    if (subject) {
      return `Referring to ${subject}: ${firstSentence(priorAnswer) || "as discussed earlier in this conversation."}`;
    }
  }

  return null;
}

function firstSentence(text: string): string {
  const clean = text.replace(/^\[.*?\]\n/s, "").replace(/\s+/g, " ").trim();
  return clean.split(/(?<=[.!?])\s/)[0] ?? clean;
}

function lastNoun(userTurns: { content: string }[]): string | null {
  const last = userTurns.at(-1)?.content ?? "";
  const m = /\b(?:about|on|for|of)\s+([A-Za-z][\w ]{2,30})/i.exec(last);
  return m ? m[1].trim() : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockProvider implements LLMProvider {
  readonly name = "mock";

  supports(): boolean { return true; }

  estimateCost(model: ModelSpec, inTok: number, outTok: number, reasoningTok = 0): number {
    return modelRegistry.price(model, inTok, outTok, reasoningTok);
  }

  async *stream(req: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const model = modelRegistry.resolve(req.modelId);
    // A follow-up is answered from the conversation the caller supplied, so
    // multi-turn context is demonstrable without a provider key.
    const text = answerFromContext(req.prompt, req.history ?? []) ?? pick(req.prompt);
    const tokens = text.match(/\S+\s*/g) ?? [text];

    const perToken = model.latencyClass === "fast" ? 10 : model.latencyClass === "balanced" ? 18 : 26;

    for (const t of tokens) {
      if (req.signal?.aborted) {
        yield { text: "", done: true };
        return;
      }
      await sleep(perToken);
      yield { text: t, done: false };
    }

    const inputTokens =
      Math.ceil(req.prompt.length / 4) +
      req.history.reduce((n, h) => n + Math.ceil(h.content.length / 4), 0) +
      req.attachments.reduce((n, a) => n + (a.type === "image" ? 800 : Math.ceil((a.extractedText?.length ?? 400) / 4)), 0);
    const outputTokens = Math.ceil(text.length / 4);
    const mult = req.effort === "low" ? 0 : req.effort === "medium" ? 0.6 : 2;
    const reasoningTokens = model.reasoningSupport ? Math.round(outputTokens * mult) : 0;

    yield {
      text: "",
      done: true,
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens,
        cost: modelRegistry.price(model, inputTokens, outputTokens, reasoningTokens),
      },
    };
  }

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const started = Date.now();
    let text = "";
    let usage: StreamChunk["usage"];
    for await (const chunk of this.stream(req)) {
      text += chunk.text;
      if (chunk.usage) usage = chunk.usage;
    }
    const model = modelRegistry.resolve(req.modelId);
    return {
      text,
      modelId: req.modelId,
      provider: model.provider,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      cost: usage?.cost ?? 0,
      latencyMs: Date.now() - started,
      cancelled: req.signal?.aborted,
    };
  }
}

export const mockProvider = new MockProvider();
