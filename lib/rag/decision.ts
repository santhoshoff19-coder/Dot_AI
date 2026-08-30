import type { UseCaseProfile } from "@/lib/governance/profiles";

export type RagMode = "AUTO" | "ON" | "OFF";
export type RetrievalType = "NONE" | "EVIDENCE" | "POLICY" | "BOTH";

export interface RetrievalDecisionInput {
  prompt: string;
  ragMode: RagMode;
  /** Compact digest of the conversation, when one exists. */
  conversationDigest?: string;
  hasAttachments?: boolean;
  outputModality?: "TEXT" | "IMAGE" | "DOCUMENT";
  riskLevel?: string;
  profile?: UseCaseProfile | null;
  /** Risk labels already detected, which pull policy retrieval in. */
  riskCategories?: string[];
}

export interface RetrievalDecision {
  shouldRetrieve: boolean;
  retrievalType: RetrievalType;
  reason: string;
  /** Retrieval before generation, so the model can ground its answer. */
  preGeneration: boolean;
  /** Retrieval after generation, to verify what it claimed. */
  postGeneration: boolean;
  forced: boolean;
  bypassed: boolean;
}

/**
 * Signals that a request depends on knowledge dotAI would have to look up
 * rather than knowledge a model can reasonably hold.
 */
const ORGANISATIONAL = [
  /\b(?:our|my|the)\s+(?:company|companies|organisation|organization|firm|team|business)\b/i,
  /\b(?:internal|corporate|company)\s+(?:policy|policies|data|document|report|guideline)/i,
  /\bwe\s+(?:have|offer|charge|allow|support|provide)\b/i,
];

const POLICY_SIGNALS = [
  /\b(?:policy|policies|compliance|regulation|regulatory|gdpr|dpdp|approval limit)\b/i,
  /\b(?:am i allowed|can i (?:send|share|disclose|approve)|is it permitted|permitted to)\b/i,
  /\b(?:privacy|retention|consent|data handling|access control)\b/i,
];

/**
 * A direct reference to material the user has put into the corpus.
 *
 * This was the gap that made uploaded documents unreachable. A question like
 * "what does the document say I prefer?" names the document explicitly, yet
 * matched none of the signals below: ORGANISATIONAL wants "our company", and
 * EVIDENCE_SIGNALS wants a verb like "summarise" or the phrasing "what is
 * the". A user who says "the document" is asking to be answered from it, and
 * that is now sufficient on its own.
 */
const DOCUMENT_REFERENCE = [
  // "the document", "my profile", "this contract", "the uploaded file"…
  /\b(?:the|this|that|my|our|uploaded|attached)\s+(?:document|file|pdf|doc|docx|report|contract|policy|profile|paper|agreement|record)\b/i,
  // "does the document say", "what does it state" — question forms that point
  // at a source rather than at general knowledge.
  /\b(?:does|do|did)\s+(?:the|this|my|our)\s+\w+\s+(?:say|state|mention|list|specify|contain)\b/i,
  // "according to the document", "as per my profile"
  /\b(?:according to|as per|per|based on|from)\s+(?:the|this|my|our)\s+(?:document|file|report|contract|policy|profile|record)\b/i,
];

const EVIDENCE_SIGNALS = [
  /\b(?:revenue|profit|margin|headcount|budget|quarterly|q[1-4]\s*\d{4}|fiscal)\b/i,
  /\b(?:according to|based on|per the|as stated in)\b/i,
  /\b(?:what (?:is|are|was|were) (?:our|the))\b/i,
  /\b(?:summar|analy[sz]e|extract|review)\b[^.?!]{0,30}\b(?:document|report|file|pdf|contract)\b/i,
];

/** Requests that plainly need no external knowledge. */
const CONVERSATIONAL = [
  /^\s*(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening))\b/i,
  /\b(?:write|compose|draft)\s+(?:a|an|me)?\s*(?:poem|story|haiku|joke|song)\b/i,
  /\b(?:explain|what is|how does)\b[^.?!]{0,40}\b(?:recursion|gravity|photosynthesis|quantum)\b/i,
];

/**
 * The single place retrieval is decided.
 *
 * Chat, Library, image and document paths all call this, so the three modes
 * behave identically everywhere and no caller can invent its own rule.
 */
export class RetrievalDecisionService {
  decide(input: RetrievalDecisionInput): RetrievalDecision {
    const { prompt, ragMode } = input;

    // ---- MANUAL OFF -----------------------------------------------------
    // The user's instruction is honoured for retrieval, but it is only a
    // retrieval instruction. It never relaxes a governance control - the
    // policy engine still runs and will escalate on missing evidence.
    if (ragMode === "OFF") {
      return {
        shouldRetrieve: false,
        retrievalType: "NONE",
        reason: "Retrieval was switched off for this request by the user.",
        preGeneration: false,
        postGeneration: false,
        forced: false,
        bypassed: true,
      };
    }

    const needsPolicy = this.needsPolicy(input);
    const needsEvidence = this.needsEvidence(input);

    // ---- MANUAL ON ------------------------------------------------------
    if (ragMode === "ON") {
      const type: RetrievalType = needsPolicy && needsEvidence ? "BOTH"
        : needsPolicy ? "POLICY" : "EVIDENCE";
      return {
        shouldRetrieve: true,
        retrievalType: type,
        reason: "Retrieval was forced on by the user, regardless of whether the router judged it necessary.",
        preGeneration: this.canGround(input),
        postGeneration: this.wantsVerification(input),
        forced: true,
        bypassed: false,
      };
    }

    // ---- AUTO -----------------------------------------------------------
    if (!needsPolicy && !needsEvidence) {
      return {
        shouldRetrieve: false,
        retrievalType: "NONE",
        reason: "The request does not depend on company, document or policy knowledge.",
        preGeneration: false,
        postGeneration: false,
        forced: false,
        bypassed: false,
      };
    }

    const retrievalType: RetrievalType = needsPolicy && needsEvidence ? "BOTH"
      : needsPolicy ? "POLICY" : "EVIDENCE";

    return {
      shouldRetrieve: true,
      retrievalType,
      reason: needsPolicy && needsEvidence
        ? "The request needs company knowledge and touches a governed action."
        : needsPolicy
          ? "The request concerns what is permitted, so policy evidence applies."
          : "The request depends on company or document knowledge.",
      // Retrieved text informs the answer whether it was pulled as company
      // knowledge or as policy: "what does our retention policy say" is
      // answered *from* the policy, not merely judged against it.
      preGeneration: this.canGround(input),
      postGeneration: this.wantsVerification(input),
      forced: false,
      bypassed: false,
    };
  }

  /**
   * Whether retrieved text can ground the output at all. Image pixels cannot
   * be grounded in a policy section, so there is nothing to inject.
   */
  private canGround(input: RetrievalDecisionInput): boolean {
    return input.outputModality !== "IMAGE";
  }

  private needsPolicy(input: RetrievalDecisionInput): boolean {
    if ((input.riskCategories ?? []).length > 0) return true;
    if (input.riskLevel === "high" || input.riskLevel === "critical") return true;
    return POLICY_SIGNALS.some((r) => r.test(input.prompt));
  }

  private needsEvidence(input: RetrievalDecisionInput): boolean {
    // An attached document is knowledge the answer must be grounded in.
    if (input.hasAttachments) return true;

    const text = input.prompt;

    // An explicit reference to a document settles it on its own. Checked
    // before the conversational guard, because "thanks — what does the
    // contract say about notice?" opens conversationally and is still a
    // question about a document.
    if (DOCUMENT_REFERENCE.some((r) => r.test(text))) return true;

    if (CONVERSATIONAL.some((r) => r.test(text)) &&
        !ORGANISATIONAL.some((r) => r.test(text))) {
      return false;
    }
    return ORGANISATIONAL.some((r) => r.test(text)) ||
      EVIDENCE_SIGNALS.some((r) => r.test(text));
  }

  /**
   * Post-generation verification is expensive, so it is reserved for output
   * where being wrong actually costs something.
   */
  private wantsVerification(input: RetrievalDecisionInput): boolean {
    if (input.outputModality === "IMAGE") return false;
    if (input.riskLevel === "high" || input.riskLevel === "critical") return true;
    return input.profile?.riskTolerance === "low";
  }

  /** One line for the UI, e.g. "USED — POLICY" or "FORCED ON". */
  label(decision: RetrievalDecision): string {
    if (decision.bypassed) return "OFF";
    if (!decision.shouldRetrieve) return "NOT USED";
    const kind = decision.retrievalType === "BOTH"
      ? "EVIDENCE + POLICY" : decision.retrievalType;
    return decision.forced ? `FORCED ON — ${kind}` : `USED — ${kind}`;
  }
}

export const retrievalDecision = new RetrievalDecisionService();
