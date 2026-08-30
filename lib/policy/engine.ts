import { prisma } from "@/lib/db";
import { embeddingService, type RetrievalMode } from "@/lib/policy/embeddings";
import { vectorStore } from "@/lib/policy/vector-store";
import {
  normaliseJurisdiction, policyCategoriesFor,
  type Jurisdiction, type PolicyCategory, type PolicyDecision,
} from "@/lib/policy/taxonomy";
import type { UseCaseProfile } from "@/lib/governance/profiles";

export const DEFAULT_TOP_K = Number(process.env.POLICY_TOP_K ?? 5);

// The relevance floor lives in its own module so the performance checker can
// apply the same threshold without importing the policy engine. Re-exported
// here because this is where callers already expect to find it.
import { relevanceFloor } from "@/lib/policy/thresholds";
export { RELEVANCE_THRESHOLDS, relevanceFloor } from "@/lib/policy/thresholds";

export interface PolicyEvidence {
  chunkId: string;
  documentName: string;
  regulation: string;
  version: string;
  jurisdiction: string;
  section: string;
  category: string;
  text: string;
  score: number;
  isDemo: boolean;
  retrievedAt: string;
}

export interface RetrievalResult {
  evidence: PolicyEvidence[];
  mode: RetrievalMode;
  model: string;
  costUsd: number;
  query: string;
  filters: { jurisdictions: string[]; categories: PolicyCategory[] };
  /** Chunks considered before the relevance floor was applied. */
  consideredCount?: number;
  belowThresholdCount?: number;
  relevanceFloor?: number;
  latencyMs?: number;
}

/**
 * Builds the smallest query that captures the situation. Deliberately not the
 * whole conversation: we search for the rules that could govern the risk that
 * was actually detected.
 */
export function buildPolicyQuery(input: {
  riskCategories: string[];
  dataTypes: string[];
  actionName?: string | null;
  external: boolean;
}): string {
  const parts: string[] = [];
  for (const r of input.riskCategories) parts.push(r.toLowerCase().replace(/_/g, " "));
  for (const d of input.dataTypes) parts.push(d.toLowerCase().replace(/_/g, " "));
  if (input.external) parts.push("disclosure to external recipient outside the organisation");
  else parts.push("internal disclosure to authorised staff");
  if (input.actionName) parts.push(`action ${input.actionName.replace(/_/g, " ")}`);
  return [...new Set(parts)].join(", ");
}


/**
 * Whether a chunk states a rule, as opposed to describing the document.
 *
 * A preamble ("this policy governs how vendor agreements are assessed") shares
 * a lot of vocabulary with a question about vendor agreements, so it scores
 * highly — while containing nothing to check a claim against. Treating it as
 * evidence produced ungrounded claims and, through them, an unwarranted hold.
 *
 * Evidence has to carry a normative statement. This is a filter on what
 * counts as evidence, not on what may be retrieved.
 */
export function statesARule(text: string): boolean {
  return /\b(?:must|shall|may not|must not|required|requires|prohibited|permitted|acceptable|unacceptable|is a material risk|escalated|not allowed|only if|no longer than|within \d|beyond \d|at least|cap(?:ped)? (?:at|below))\b/i
    .test(text);
}

/**
 * Splits a multi-part question into the aspects it actually asks about.
 *
 * "…focusing on data privacy, breach handling, vendor control over our data,
 * and liability" names four distinct subjects. Embedding all of it as one
 * vector averages them, and the averaged vector matches generic text better
 * than any specific clause — so the clauses that answer the question lose to
 * the preamble. Retrieving per aspect and merging fixes that without
 * hardcoding any subject.
 */
export function queryAspects(query: string): string[] {
  const aspects: string[] = [];

  const focus = /(?:focus(?:ing|ed)?\s+on|specifically|covering|regarding|about)\s+([^.?!]+)/i
    .exec(query);
  if (focus) {
    for (const part of focus[1].split(/\s*(?:,|;|\band\b)\s*/i)) {
      const t = part.trim();
      if (t.length > 3 && t.split(/\s+/).length <= 8) aspects.push(t);
    }
  }

  // The whole question always stays in the set: an aspect list narrows the
  // search, it must not replace it.
  return [...new Set([query, ...aspects])];
}

export class PolicyRetrievalService {
  /**
   * Metadata filtering first, then semantic scoring over what survives. This
   * keeps retrieval cheap and stops rules from another jurisdiction being
   * scored at all.
   */
  async retrieve(input: {
    riskCategories: string[];
    dataTypes?: string[];
    actionName?: string | null;
    external: boolean;
    jurisdictions: Jurisdiction[];
    topK?: number;
    /**
     * Search text supplied by the caller, used instead of the risk-derived
     * query. Grounding a request means searching for what was actually asked,
     * not for the risk labels a not-yet-written answer might carry.
     */
    queryText?: string;
  }): Promise<RetrievalResult> {
    const topK = input.topK ?? DEFAULT_TOP_K;
    // With no risk labels there is nothing to narrow by, and filtering on an
    // empty category set would exclude the entire corpus.
    const categories = policyCategoriesFor(input.riskCategories);
    // GLOBAL rules always apply alongside the configured jurisdiction.
    const jurisdictions = [...new Set([...input.jurisdictions, "GLOBAL" as Jurisdiction])];

    const query = input.queryText?.trim() || buildPolicyQuery({
      riskCategories: input.riskCategories,
      dataTypes: input.dataTypes ?? [],
      actionName: input.actionName,
      external: input.external,
    });

    const started = Date.now();

    /*
     * Search each embedding space the corpus actually contains.
     *
     * Chunks record the model that produced their vector. A query embedded
     * with one model cannot be compared against chunks embedded with another:
     * the dimensions differ, cosine similarity is zero, and retrieval returns
     * nothing with no error to explain it. That is exactly what happened to a
     * document indexed locally and then queried after credentials were added.
     *
     * A mixed corpus is normal — documents are indexed whenever they are
     * uploaded, and credentials can change in between — so the query is
     * embedded once per space and the results merged.
     */
    const spaces = await prisma.policyChunk.groupBy({
      by: ["embeddingModel"],
      where: { embeddingModel: { not: "none" } },
    });

    // Best score per chunk, and which aspect produced it.
    const best = new Map<string, number>();
    const bestAspect = new Map<string, string>();
    let usedMode: RetrievalMode = "LEXICAL_FALLBACK";
    let usedModel = "";
    let totalCost = 0;

    const aspects = queryAspects(query);

    for (const space of spaces) {
      const local = space.embeddingModel.startsWith("Xenova/");

      for (const aspect of aspects) {
        const embedded = await embeddingService.embed([aspect], {
          preferMode: local ? "SEMANTIC_LOCAL" : undefined,
        });
        if (embedded.model !== space.embeddingModel) continue;

        const hitsForSpace = await vectorStore.search(
          embedded.vectors[0] ?? [],
          { jurisdictions, categories, embeddingModel: space.embeddingModel },
          topK * 3,
        );

        const spaceFloor = relevanceFloor(embedded.mode);
        for (const h of hitsForSpace) {
          if (h.score < spaceFloor) continue;
          const prev = best.get(h.chunkId) ?? 0;
          if (h.score > prev) {
            best.set(h.chunkId, h.score);
            bestAspect.set(h.chunkId, aspect);
          }
        }

        usedMode = embedded.mode;
        usedModel = embedded.model;
        totalCost += embedded.costUsd;
      }
    }

    let raw = [...best.entries()].map(([chunkId, score]) => ({ chunkId, score }));
    raw.sort((a, b) => b.score - a.score);

    // Each space filtered against its own floor above, because scores are not
    // comparable across embedding models. The floor reported is the one that
    // governed the space the results came from.
    const floor = relevanceFloor(usedMode);

    const ranked = raw.filter((h) => h.score >= floor);

    // Fetch more than needed so non-normative chunks can be dropped without
    // shrinking the evidence set below topK.
    const candidates = ranked.length
      ? await prisma.policyChunk.findMany({
          where: { id: { in: ranked.slice(0, topK * 3).map((h) => h.chunkId) } },
          include: { document: true },
        })
      : [];

    /*
     * Only chunks that state a rule can serve as evidence.
     *
     * A document preamble scores well against a question on its own subject
     * while containing nothing to verify a claim against. Admitting it as
     * evidence left claims ungrounded and escalated the session on the
     * strength of a chunk that never applied.
     *
     * If nothing normative survives, the ranked set is used unchanged rather
     * than returning empty — the relevance floor already decided the material
     * is relevant, and silently dropping it would hide evidence from review.
     */
    const normative = candidates.filter((c) => statesARule(c.text));
    const usable = normative.length > 0 ? normative : candidates;
    const usableIds = new Set(usable.map((c) => c.id));

    /*
     * Select round-robin across the aspects the question asked about.
     *
     * A global top-K lets one well-matched aspect fill every slot: a question
     * naming privacy, breach handling, vendor control and liability came back
     * with several privacy clauses and nothing on breach or deletion, so those
     * parts of the answer had no evidence and were reported ungrounded.
     * Taking the best remaining chunk per aspect in turn guarantees each part
     * of the question is represented before any aspect takes a second slot.
     */
    const eligible = ranked.filter((h) => usableIds.has(h.chunkId));
    const byAspect = new Map<string, typeof eligible>();
    for (const h of eligible) {
      const a = bestAspect.get(h.chunkId) ?? query;
      if (!byAspect.has(a)) byAspect.set(a, []);
      byAspect.get(a)!.push(h);
    }

    const hits: typeof eligible = [];
    const taken = new Set<string>();
    let progressed = true;
    while (hits.length < topK && progressed) {
      progressed = false;
      for (const aspect of aspects) {
        if (hits.length >= topK) break;
        const queue = byAspect.get(aspect);
        if (!queue) continue;
        const next = queue.find((h) => !taken.has(h.chunkId));
        if (!next) continue;
        taken.add(next.chunkId);
        hits.push(next);
        progressed = true;
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const keep = new Set(hits.map((h) => h.chunkId));
    const chunks = usable.filter((c) => keep.has(c.id));

    const scoreById = new Map(hits.map((h) => [h.chunkId, h.score]));
    const retrievedAt = new Date().toISOString();

    const evidence: PolicyEvidence[] = chunks
      .map((c) => ({
        chunkId: c.id,
        documentName: c.document.name,
        regulation: c.regulation,
        version: c.version,
        jurisdiction: c.jurisdiction,
        section: c.section,
        category: c.category,
        text: c.text,
        score: Math.round((scoreById.get(c.id) ?? 0) * 1e4) / 1e4,
        isDemo: c.document.isDemo,
        retrievedAt,
      }))
      .sort((a, b) => b.score - a.score);

    return {
      evidence,
      consideredCount: raw.length,
      belowThresholdCount: raw.length - hits.length,
      relevanceFloor: floor,
      latencyMs: Date.now() - started,
      mode: usedMode,
      model: usedModel,
      costUsd: totalCost,
      query,
      filters: { jurisdictions, categories },
    };
  }
}

export interface PolicyDecisionInput {
  profile: UseCaseProfile;
  jurisdictions: Jurisdiction[];
  riskCategories: string[];
  dataTypes: string[];
  external: boolean;
  actionName?: string | null;
  actionValueUsd?: number;
  evidence: PolicyEvidence[];
  retrievalMode: RetrievalMode;
}

export interface PolicyDecisionResult {
  decision: PolicyDecision;
  reason: string;
  conflict: boolean;
  /** Evidence actually cited by the rule that fired, never the whole corpus. */
  citedEvidence: PolicyEvidence[];
  appliedRule: string;
  caveat: string;
}

/**
 * Deterministic Policy Decision Engine.
 *
 * Retrieval supplies evidence; this decides. No model is asked what the policy
 * means, and retrieved text can never by itself authorise an action - it can
 * only be cited by a rule that the configured profile already defines.
 */
export class PolicyDecisionEngine {
  decide(input: PolicyDecisionInput): PolicyDecisionResult {
    const {
      profile, riskCategories, external, evidence, retrievalMode, actionValueUsd = 0,
    } = input;

    const caveat =
      "Based on the configured policy pack and retrieved evidence, ControlPlane " +
      "applied this policy decision. This is not a legal determination.";

    const sensitive = riskCategories.some(
      (r) => r === "SENSITIVE_DATA" || r === "PRIVACY" || r === "PERSONAL_DATA");
    const blockCats = profile.escalationRules.alwaysBlockCategories as string[];
    const hitsBlockCategory = riskCategories.some((r) => blockCats.includes(r));

    // --- conflicting evidence ---------------------------------------------
    // Two regulations pulling in different directions is not something to
    // resolve silently. It is escalated with both sources recorded.
    const conflict = detectConflict(evidence);
    if (conflict) {
      return {
        decision: profile.escalationRules.escalateAtSessionRisk === "NEVER" ? "ANNOTATE" : "HOLD",
        reason:
          `Retrieved policy evidence conflicts across ${
            [...new Set(evidence.map((e) => e.regulation))].join(" and ")
          }; the conflict was escalated rather than resolved automatically.`,
        conflict: true,
        citedEvidence: evidence,
        appliedRule: "POLICY_CONFLICT",
        caveat,
      };
    }

    // --- no usable evidence ------------------------------------------------
    // A risk was detected but no policy covers it. Silence is not permission.
    if (riskCategories.length > 0 && evidence.length === 0) {
      return {
        decision: "UNVERIFIABLE",
        reason:
          "A risk was detected but no policy in the configured pack covers it for " +
          "this jurisdiction, so the request could not be verified as permitted.",
        conflict: false,
        citedEvidence: [],
        appliedRule: "NO_APPLICABLE_POLICY",
        caveat,
      };
    }

    // --- sensitive data leaving the organisation ---------------------------
    if (sensitive && external) {
      const cited = evidence.filter(
        (e) => e.category === "DATA_TRANSFER" || e.category === "SENSITIVE_DATA");
      const decision: PolicyDecision = hitsBlockCategory ? "BLOCK" : "HOLD";
      return {
        decision,
        reason:
          `Personal or sensitive customer data would leave the organisation. The ` +
          `${profile.name} policy treats this as ${
            decision === "BLOCK" ? "prohibited" : "requiring human approval"}.`,
        conflict: false,
        citedEvidence: cited.length ? cited : evidence,
        appliedRule: "SENSITIVE_EXTERNAL_TRANSFER",
        caveat,
      };
    }

    // --- consequential action ----------------------------------------------
    if (actionValueUsd > profile.escalationRules.humanApprovalAboveUsd) {
      return {
        decision: "HOLD",
        reason:
          `The proposed action exceeds the ${profile.name} auto-approval limit and ` +
          `requires human approval under the configured policy.`,
        conflict: false,
        citedEvidence: evidence.filter((e) => e.category === "SAFETY"),
        appliedRule: "CONSEQUENTIAL_ACTION",
        caveat,
      };
    }

    // --- sensitive data staying internal ------------------------------------
    if (sensitive && !external) {
      return {
        decision: "ANNOTATE",
        reason:
          "Personal data is disclosed to an authorised internal recipient, which " +
          "the configured policy permits with a handling note.",
        conflict: false,
        citedEvidence: evidence.filter((e) => e.category === "PERSONAL_DATA"),
        appliedRule: "INTERNAL_DISCLOSURE",
        caveat,
      };
    }

    // --- lexical fallback caveat --------------------------------------------
    // With no embedding provider, absence of evidence is weak proof of
    // absence, so a detected risk is not cleared on that basis alone.
    if (riskCategories.length > 0 && retrievalMode === "LEXICAL_FALLBACK") {
      return {
        decision: "ANNOTATE",
        reason:
          "Policy evidence was retrieved by keyword matching rather than semantic " +
          "search, so coverage cannot be guaranteed for this risk.",
        conflict: false,
        citedEvidence: evidence,
        appliedRule: "DEGRADED_RETRIEVAL",
        caveat,
      };
    }

    return {
      decision: "ALLOW",
      reason: riskCategories.length === 0
        ? "No policy-relevant risk was detected in this response."
        : "The configured policy permits this disclosure in this context.",
      conflict: false,
      citedEvidence: evidence.slice(0, 1),
      appliedRule: "PERMITTED",
      caveat,
    };
  }
}

/**
 * Two documents conflict when both are strongly relevant, come from different
 * regulations, and one permits while the other restricts.
 */
export function detectConflict(evidence: PolicyEvidence[]): boolean {
  const strong = evidence.filter((e) => e.score > 0);
  if (strong.length < 2) return false;

  const regulations = new Set(strong.map((e) => e.regulation));
  if (regulations.size < 2) return false;

  const permits = (t: string) =>
    /\bmay be (?:processed|disclosed|shown)|is permitted|may be shown/i.test(t);
  const restricts = (t: string) =>
    /must not|shall not|requires (?:consent|human|a documented)|prohibited/i.test(t);

  return strong.some((e) => permits(e.text)) && strong.some((e) => restricts(e.text));
}

export const policyRetrieval = new PolicyRetrievalService();
export const policyDecisionEngine = new PolicyDecisionEngine();
export { normaliseJurisdiction };
