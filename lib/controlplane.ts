import { actionGate } from "@/lib/action-gate/service";
import { costService } from "@/lib/cost/service";
import { privacyFirewall, type FirewallResult } from "@/lib/governance/privacy-firewall";
import {
  optionsFromDecision, routingFromDecision,
} from "@/lib/intelligence/cai-routing-result";
import {
  routeQuery, type RoutingDecision as CuratedRoutingDecision,
} from "@/lib/intelligence/curated-routing";
import { modelExecution } from "@/lib/models/execution";
import { getProfile } from "@/lib/governance/profiles";
import { toRiskFindings } from "@/lib/governance/risk-findings";
import { governedDecisionEngine } from "@/lib/governance/decision";
import { resolveVerificationDepth, sessionRiskService } from "@/lib/governance/session-risk";
import { checkerMetrics } from "@/lib/governance/metrics";
import { policyRetrieval, policyDecisionEngine, normaliseJurisdiction } from "@/lib/policy/engine";
import { policyIngestion } from "@/lib/policy/ingest";
import { anomalyDetector } from "@/lib/verification/anomaly";
import { modelIntelligenceService } from "@/lib/intelligence/service";
import { retrievalDecision, type RagMode } from "@/lib/rag/decision";
import { conversationContext } from "@/lib/conversation/context";
import { generateDocx } from "@/lib/documents/generate";
import {
  checkSupport, primaryInputModality, resolveOutputModality,
  type IOModality, type OutputPreference,
} from "@/lib/documents/matrix";
import { hasUsableText } from "@/lib/documents/extract";
import {
  mergeControlDecisions, policyToDecision, recommendedActionFor,
  type ControlSignal, type MergedDecision,
} from "@/lib/decision/merge";
import { recordPolicyDecision } from "@/lib/policy/audit";
import {
  CapabilityMismatchError, generationRouter, UnsupportedModalityError,
} from "@/lib/generation/router";
import { learningService } from "@/lib/learning/service";
import { decisionEngine } from "@/lib/decision/engine";
import { modelRegistry } from "@/lib/models/registry";
import { performanceService } from "@/lib/performance/service";
import { getProvider, isMockMode, ProviderError } from "@/lib/providers";
import { redact, responsibilityService } from "@/lib/responsibility/service";
import type { RoutingResult } from "@/lib/routing/route-types";
import type {
  AttachmentRef, ControlEventData, Decision, GenerationResult,
  ModelRecommendation, PerformanceResult, StreamEvent, UserSettings,
} from "@/types";

export interface RunInput {
  requestId: string;
  prompt: string;
  attachments: AttachmentRef[];
  history: { role: "user" | "assistant"; content: string }[];
  /** Built context, so routing and CAI can see what was discussed. */
  conversationContext?: import("@/lib/conversation/context").ConversationContext;
  settings: Partial<UserSettings>;
  destinationExternal: boolean;
  actor: { role: string; permissions: string[] };
  signal?: AbortSignal;
  /**
   * A routing decision already made (and possibly overridden by the user in
   * the three-model chooser). When absent the loop routes for itself.
   */
  routing?: RoutingResult;
  /** Model the user explicitly picked from the chooser. */
  selectedModelId?: string;
  /** Which use case governs this request. Policy differs per use case. */
  profileId?: string;
  /** Conversation this belongs to, for accumulated risk. */
  sessionId?: string;
  /** Explicit output type. AUTO lets the request decide. */
  outputPreference?: OutputPreference;
  /** Retrieval mode: AUTO decides, ON forces, OFF bypasses. */
  ragMode?: RagMode;
  /**
   * Automatic fallback is opt-in. Without it, a failed user selection is
   * reported rather than silently replaced with a different model.
   */
  allowFallback?: boolean;
}

export interface GeneratedImage {
  url: string;
  mimeType: string;
  simulated: boolean;
}

export interface GeneratedDocumentRef {
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  simulated: boolean;
}

export interface RunOutput {
  /** What may be shown to the user right now. Empty when held or blocked. */
  answer: string;
  /** Present when the request asked for a document artefact. */
  document?: GeneratedDocumentRef;
  /**
   * The generated answer retained for human review when the decision is HOLD.
   * Never populated for BLOCK - prohibited output is not stored or shown.
   */
  heldAnswer: string;
  /** Present when the task required image output. */
  image?: GeneratedImage;
  controlEvent: ControlEventData;
}

const MAX_ATTEMPTS = 2;

/**
 * The dotAI control loop:
 *   CAI -> model selection -> generation -> checker -> decision -> action gate
 * Emits progress events so the UI can show the sequence as it happens.
 */
export async function runControlPlane(
  input: RunInput,
  emit: (e: StreamEvent) => void,
): Promise<RunOutput> {
  const started = Date.now();
  const provider = getProvider();
  const mock = isMockMode();


  // ---- ROUTING: Fast Router -> (CAI only if needed) -> Model Scoring ------
  const preInputModality: IOModality = primaryInputModality(input.attachments);
  const preOutput = resolveOutputModality(input.prompt, input.outputPreference);
  // Document output is rendered from governed text, so routing still needs a
  // text-capable model for it.
  const routingOutput: "TEXT" | "IMAGE" =
    preOutput.output === "IMAGE" ? "IMAGE" : "TEXT";

  /*
   * CAI is the only classifier.
   *
   * The fast router and the catalog orchestrator both used to classify
   * queries and pick models, and they disagreed: the router bucketed almost
   * every text prompt as "conversation" while CAI correctly identified
   * Coding, Reasoning & Analysis and the rest. Whichever the UI happened to
   * read was the answer the user saw.
   *
   * Now there is one path. CAI determines input form, output form, sub-task
   * and LIST A; the curated dataset supplies eligibility and the three tiers;
   * and everything the governance code needs - risk level, verification
   * depth, effort - is derived from that same analysis rather than from a
   * second opinion about the prompt.
   */
  const capability = await routeQuery({
    prompt: input.prompt,
    attachments: input.attachments.map((a) => ({ type: a.type })),
  });

  emit({ type: "capability", capability });
  emit({
    type: "status",
    stage: "capability",
    label:
      `${capability.analysis.source} (${capability.analysis.analyser}): `
      + `${capability.analysis.input} → ${capability.analysis.output} → `
      + `${capability.analysis.subTaskName} · List A `
      + `${capability.analysis.listA.length} · ${capability.eligible.length} eligible`,
  });

  const routing: RoutingResult = input.routing
    ?? routingFromDecision(capability, capability.analysis.telemetry.costUsd);

  // ---- PRE-GENERATION PRIVACY FIREWALL ----------------------------------
  // Checked before the request leaves. Every other control examines the
  // model's answer; by then a leaked identifier has already left the system
  // and no verdict can recall it.
  const firewall = privacyFirewall({
    prompt: input.prompt,
    profile: getProfile(input.profileId),
    destinationExternal: input.destinationExternal,
    attachmentText: input.attachments
      .map((a) => a.extractedText ?? "").filter(Boolean).join("\n") || undefined,
  });

  emit({ type: "firewall", firewall });
  emit({
    type: "status",
    stage: "firewall",
    label: firewall.detected.length === 0
      ? "Privacy firewall: nothing sensitive in the request"
      : `Privacy firewall: ${firewall.decision} — `
        + `${firewall.detected.map((d) => d.cls).join(", ")}`,
  });

  if (firewall.decision === "BLOCK" || firewall.decision === "HOLD") {
    throw new PrivacyFirewallError(firewall);
  }

  /*
   * Model selection:
   *
   *   1. the model the user picked in the three-model chooser
   *   2. otherwise the Recommended tier - the cheapest eligible model
   *
   * Both come from the eligible set, so an ineligible model cannot be
   * executed either way.
   */
  const capabilityChoice = capability.recommended?.openrouterId ?? null;
  const chosenModelId =
    input.selectedModelId ?? capabilityChoice ?? routing.recommendedModel;

  /*
   * The three model cards come from capability routing, not the orchestrator.
   *
   * The orchestrator's options are drawn from the synced OpenRouter catalog,
   * which is no longer populated - so it fell back to three seed models named
   * "Swift", "Balanced" and "Deep" and offered those same three for every
   * query. The cards showed placeholder names, and no query could change
   * them.
   *
   * These options are computed from this query's LIST A against each model's
   * LIST B, so a different query with different requirements yields different
   * cards. The model shown is the model that runs: both read the same
   * `openrouterId`.
   */
  // What the analysis cost this turn, for the ledger below.
  const caiCost = capability.analysis.telemetry.costUsd;

  /*
   * CAI's classification is the one the user sees.
   *
   * Two classifiers exist: the orchestrator's fast router, which buckets a
   * prompt into a coarse routing task, and CAI, which resolves the actual
   * input form, output form and sub-task against the curated taxonomy. The UI
   * was reading the fast router's value, and that router labels most text
   * prompts "conversation" - so a coding question, a reasoning question and a
   * greeting all displayed as Conversation while CAI had correctly
   * identified Coding, Reasoning & Analysis and General Chat & Writing.
   *
   * The fast router still does its job: it sets risk level and verification
   * depth, which govern the request. It just no longer speaks for the
   * classification.
   */
  // `routing` was already built from this decision; only the executed model
  // can differ, when the user picked one of the other tiers.
  const routingForUi: RoutingResult = { ...routing, recommendedModel: chosenModelId };

  const recommendation: ModelRecommendation =
    toRecommendation(routingForUi, chosenModelId);

  emit({ type: "routing", routing: routingForUi });
  emit({ type: "cai", recommendation });
  emit({
    type: "status",
    stage: "routing",
    label: `${labelTask(routing.taskType)} → ${modelName(chosenModelId)} selected`,
  });

  // ---- GOVERNANCE CONTEXT (shared by every modality) ---------------------
  const profile = getProfile(input.profileId);
  let sessionState = await sessionRiskService.get(input.sessionId ?? "", profile.id);

  // ---- GENERATION ROUTER -------------------------------------------------
  // The required output modality decides which provider method runs. An image
  // task never enters the text completion loop.
  // The user's explicit choice, then an explicit phrase in the request, then
  // inference. "Create a DOCX report" must never become a plain chat reply.
  const inputModality = preInputModality;
  const outputResolution = preOutput;
  const support = checkSupport(inputModality, outputResolution.output);

  emit({
    type: "status",
    stage: "modality",
    label: `${inputModality} → ${outputResolution.output} (${outputResolution.source.toLowerCase().replace(/_/g, " ")})`,
  });

  if (!support.supported) {
    throw new UnsupportedModalityError(support.message);
  }

  // A document that could not be read must not be silently answered about.
  const unreadable = input.attachments.filter(
    (a) => a.type === "document" && a.extractionStatus &&
      a.extractionStatus !== "EXTRACTED");
  if (unreadable.length > 0) {
    throw new UnsupportedModalityError(
      unreadable.map((a) => a.extractionDetail ??
        `${a.name}: text could not be extracted.`).join(" "));
  }

  // Document output is produced by rendering governed text, so it runs the
  // full text path and renders only after a decision permits it.
  const wantsDocument = outputResolution.output === "DOCUMENT";
  const requiredOutputs: ("TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "EMBEDDING" | "RERANK")[] =
    wantsDocument
      ? ["TEXT"]
      : routing.requirementProfile?.requiredOutputModalities ?? ["TEXT"];
  const method = generationRouter.methodFor(requiredOutputs);

  if (method === "unsupported") {
    throw new UnsupportedModalityError(
      `dotAI cannot yet produce ${requiredOutputs.join(", ").toLowerCase()} output.`);
  }

  if (method === "generateImage") {
    return await runImageGeneration(
      input, routing, chosenModelId, emit, started, mock, profile, sessionState,
      capability, firewall);
  }

  // ---- TEXT GENERATION (with failure-aware escalation) --------------------
  let checkerStarted = Date.now();
  let modelId = chosenModelId;
  // Models already proven unreachable this turn, so a fallback never loops
  // back onto one that has just failed.
  const failedModels = new Set<string>();
  let attempts = 0;
  let generation: GenerationResult | null = null;
  let answer = "";
  let performance = null as Awaited<ReturnType<typeof performanceService.check>> | null;
  let responsibility = responsibilityService.check("", {
    destination: { channel: "chat", external: input.destinationExternal },
    actor: input.actor,
  });
  let decision = null as ReturnType<typeof decisionEngine.decide> | null;

  // ---- GOVERNANCE CONTEXT -----------------------------------------------
  let riskFindings: import("@/lib/governance/risk-findings").RiskFinding[] = [];
  let policyOutcome: import("@/lib/policy/audit").PolicyOutcome | null = null;
  let ragMeta: NonNullable<ControlEventData["rag"]> | undefined;
  let governed: ReturnType<typeof governedDecisionEngine.decide> | null = null;
  /**
   * Policy sections retrieved for this turn. Retrieved evidence is what the
   * next attempt is grounded in and what the citations refer back to, so it
   * is kept rather than discarded once the verdict is taken.
   */
  let retrievedEvidence: import("@/lib/policy/engine").PolicyEvidence[] = [];
  // A2: every cost the control plane itself incurs, accumulated as it runs.
  const ledger = { verification: 0, rag: 0, retry: 0, routing: 0 };
  let merged: MergedDecision | null = null;

  // Depth is the profile floor, raised by response risk or accumulated
  // session risk - never lowered by either.
  /*
   * Bounded verification.
   *
   * Customer Support answers a waiting person, so its workflow caps checking
   * rather than running it to completion: past `light`, each extra tier costs
   * latency the use case cannot spend. Every other profile verifies to the
   * depth the risk warrants.
   *
   * This is a cap on effort, never on outcome - a finding that has already
   * surfaced still governs the decision.
   */
  const depthResolution = resolveVerificationDepth(
    profile, routing.verificationDepth, sessionState.riskLevel);

  if (profile.workflow.boundedVerification && depthResolution.depth === "deep") {
    // Recorded, not silently downgraded: the reason is part of the audit.
    depthResolution.depth = "standard";
    depthResolution.reason =
      `${profile.name} caps verification at standard to stay inside its `
      + `${profile.latencySLOms}ms budget.`;
  }

  // ---- PRE-GENERATION GROUNDING -----------------------------------------
  // Evidence retrieved before the model writes is evidence the model can use.
  // Retrieving only afterwards means the answer came from the model's priors
  // and the corpus merely graded it - which is not what "the request depends
  // on company knowledge" should mean.
  const effectiveRagMode: "AUTO" | "ON" | "OFF" =
    profile.workflow.retrieval === "FORCED" ? "ON"
    : profile.workflow.retrieval === "OFF" ? "OFF"
    : (input.ragMode ?? "AUTO");

  emit({
    type: "status",
    stage: "workflow",
    label: `${profile.name}: ${profile.workflow.stages.join(" → ")}`,
  });

  const groundingDecision = retrievalDecision.decide({
    prompt: input.prompt,
    // The profile's workflow governs retrieval. Internal Copilot and
    // Decision Support exist to answer from evidence, so they retrieve
    // regardless of the request's setting; the others honour it.
    ragMode: effectiveRagMode,
    hasAttachments: input.attachments.length > 0,
    outputModality: outputResolution.output,
    riskLevel: routing.riskLevel,
    profile,
    // Nothing has been written yet, so there are no answer-derived risk
    // labels. This decision is about the request alone.
    riskCategories: [],
  });

  let grounded = false;
  let groundingBlock = "";

  if (groundingDecision.shouldRetrieve && groundingDecision.preGeneration) {
    try {
      await policyIngestion.ensureSeeded();
      const jurisdictions = [...new Set(profile.jurisdiction.map(normaliseJurisdiction))];
      const grounding = await policyRetrieval.retrieve({
        riskCategories: [],
        external: input.destinationExternal,
        jurisdictions,
        // Search for what was actually asked.
        queryText: input.prompt,
      });

      ledger.rag += grounding.costUsd;
      retrievedEvidence = grounding.evidence;
      grounded = grounding.evidence.length > 0;
      groundingBlock = buildGroundingBlock(grounding.evidence);

      ragMeta = {
        mode: effectiveRagMode,
        label: retrievalDecision.label(groundingDecision),
        triggered: true,
        retrievalType: groundingDecision.retrievalType,
        reason: groundingDecision.reason,
        chunksRetrieved: grounding.evidence.length,
        embeddingCostUsd: grounding.costUsd,
        retrievalLatencyMs: grounding.latencyMs ?? 0,
        evidence: grounding.evidence,
        groundedGeneration: grounding.evidence.length > 0,
      };

      emit({
        type: "status",
        stage: "grounding",
        label: grounded
          ? `Grounding: ${grounding.evidence.length} indexed section(s) supplied to the model`
          : "Grounding: no indexed section met the relevance threshold",
      });
    } catch (err) {
      // Failing to ground is not a reason to fail the request, but it must
      // not be silent either - the answer is then ungrounded and the
      // checker will report it as such.
      console.error("[rag] pre-generation grounding failed", err);
    }
  }

  // The evidence is appended for the provider only. Audit, verification and
  // the UI all continue to show the request the user actually typed.
  // Redacted where the firewall required it: the model never sees the
  // identifiers, only the question.
  const generationPrompt = firewall.safePrompt + groundingBlock;

  while (attempts < MAX_ATTEMPTS + 1) {
    attempts++;
    answer = "";

    emit({
      type: "status",
      stage: "generating",
      label: attempts === 1
        ? `Generating with ${modelName(modelId)}`
        : `Regenerating with ${modelName(modelId)} (attempt ${attempts})`,
    });

    const genStart = Date.now();
    let usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cost: 0 };

    try {
      for await (const chunk of provider.stream({
        prompt: generationPrompt,
        modelId,
        effort: recommendation.recommendedEffort,
        attachments: input.attachments,
        history: input.history,
        signal: input.signal,
      })) {
        if (chunk.text) {
          answer += chunk.text;
          // Only stream the first attempt to the UI; retries replace it.
          if (attempts === 1) emit({ type: "token", text: chunk.text });
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
            reasoningTokens: chunk.usage.reasoningTokens ?? 0,
            cost: chunk.usage.cost ?? 0,
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason =
        err instanceof ProviderError && err.kind === "timeout" ? "TIMEOUT"
        : err instanceof ProviderError && err.kind === "auth" ? "AUTHENTICATION_ERROR"
        : err instanceof ProviderError && err.kind === "unavailable" ? "PROVIDER_UNAVAILABLE"
        : "GENERATION_FAILED";
      // Execution health, not capability: a provider outage says nothing about
      // how well the model reasons.
      await modelExecution.recordExecution(
        modelId, "TEXT", false, reason, message, input.requestId);

      /*
       * Try the next eligible model before giving up.
       *
       * The cheapest eligible model can be unreachable for reasons that have
       * nothing to do with capability - an account's allowed-providers
       * setting, a regional block, an outage. Failing the request would
       * discard a whole eligible set over one unreachable member.
       *
       * The replacement comes only from that eligible set, so a model whose
       * LIST B does not cover LIST A is still never executed.
       */
      const nextEligible = capability.eligible.find(
        (m) => m.openrouterId !== modelId && !failedModels.has(m.openrouterId));

      if (nextEligible && attempts <= MAX_ATTEMPTS) {
        failedModels.add(modelId);
        emit({
          type: "status",
          stage: "generating",
          label: `${modelName(modelId)} was unreachable; trying `
            + `${nextEligible.name}, the next eligible model.`,
        });
        modelId = nextEligible.openrouterId;

        // Correct the cards. The chooser was rendered before generation, so
        // leaving it alone would show a model that did not run - and the
        // guarantee is that the displayed model is the executed one.
        emit({
          type: "routing",
          routing: {
            ...routingForUi,
            recommendedModel: modelId,
            options: optionsFromDecision({ ...capability, recommended: nextEligible }),
          },
        });

        continue;
      }

      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`Generation failed: ${message}`, "unknown");
    }

    if (input.signal?.aborted) {
      throw new ProviderError("Generation cancelled.", "unknown");
    }

    await modelExecution.recordExecution(modelId, "TEXT", true, undefined, undefined, input.requestId);

    const spec = modelRegistry.resolve(modelId);
    generation = {
      text: answer,
      modelId,
      provider: spec.provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cost: usage.cost,
      latencyMs: Date.now() - genStart,
    };

    // ---- CHECKER: output is UNVERIFIED until this clears -------------------
    checkerStarted = Date.now();
    emit({ type: "status", stage: "checking", label: "ControlPlane checking" });

    performance = await performanceService.check(
      input.prompt, answer, depthResolution.depth);

    emit({
      type: "status",
      stage: "performance",
      label: performance.claimsChecked
        ? `Performance: ${performance.claimsChecked} claim(s) checked → ${performance.status}`
        : `Performance: ${performance.status}`,
    });

    responsibility = responsibilityService.check(answer, {
      destination: { channel: "chat", external: input.destinationExternal },
      actor: input.actor,
      context: input.prompt,
    });

    emit({
      type: "status",
      stage: "responsibility",
      label: `Responsibility: ${responsibility.status}`,
    });

    // ---- GOVERNED DECISION ------------------------------------------------
    // The existing per-dimension checkers are unchanged; this layer re-expresses
    // what they found as multi-label findings and applies the active use-case
    // policy to them.
    const intent = actionGate.detectIntent(input.prompt, input.destinationExternal);

    riskFindings = toRiskFindings(performance, responsibility, {
      answerText: answer,
      highConsequenceAction: Boolean(intent),
      actionValueUsd: intent?.valueUsd ?? 0,
    });

    // Session risk is committed once per user turn, after the attempt loop
    // settles. Recording inside the loop would count each regeneration as a
    // separate turn and inflate the conversation's risk artificially.
    governed = governedDecisionEngine.decide({
      profile,
      findings: riskFindings,
      sessionRisk: sessionState.riskLevel,
      consequence: {
        irreversible: intent ? !intent.reversible : false,
        external: input.destinationExternal,
        valueUsd: intent?.valueUsd ?? 0,
        actionName: intent?.name,
      },
      attempt: attempts,
      maxAttempts: MAX_ATTEMPTS,
    });

    /*
     * UNCERTAINTY CHECK — Decision Support only.
     *
     * For a profile whose output informs a consequential decision, "we could
     * not establish this" is a reason to stop, not a caveat to attach. Other
     * profiles annotate an unverifiable claim and deliver it; here it is
     * held for a person.
     *
     * Only ever tightens: a decision already at HOLD or BLOCK is untouched.
     */
    const beforeUncertainty = governed;
    if (profile.workflow.treatUncertaintyAsBlocking && beforeUncertainty) {
      const unresolved = performance
        && (performance.status === "UNVERIFIABLE" || performance.status === "UNCERTAIN"
          || performance.status === "CONTRADICTED");

      const order = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"];
      if (unresolved
          && order.indexOf(beforeUncertainty.decision) < order.indexOf("HOLD")) {
        emit({
          type: "status",
          stage: "uncertainty",
          label: `${profile.name}: claims are ${performance!.status.toLowerCase()}; `
            + "holding for a person rather than delivering.",
        });
        governed = {
          ...beforeUncertainty,
          decision: "HOLD",
          requiresHuman: true,
          reason:
            `${profile.name} holds output whose claims could not be established `
            + `against evidence (${performance!.status}). Being wrong here costs `
            + "more than being slow.",
          trace: [
            ...beforeUncertainty.trace,
            {
              rule: "uncertainty_check",
              detail: `Verification returned ${performance!.status}; this profile `
                + "treats unresolved evidence as disqualifying.",
              raisedTo: "HOLD" as const,
            },
          ],
        };
      }
    }

    // ---- POLICY LAYER ---------------------------------------------------
    // Jurisdiction comes from the profile, never from the retrieved text. RAG
    // supplies evidence; the deterministic engine decides what it means.
    const riskCategories = [...new Set(riskFindings.flatMap((f) => f.categories))];

    // One decision service, consulted by every path. OFF suppresses retrieval
    // but never the policy engine - a governed action still gets a verdict,
    // and missing evidence escalates rather than silently passing.
    const ragDecision = retrievalDecision.decide({
      prompt: input.prompt,
      ragMode: effectiveRagMode,
      hasAttachments: input.attachments.length > 0,
      riskLevel: routing.riskLevel,
      profile,
      riskCategories,
    });

    emit({
      type: "status",
      stage: "rag",
      label: `RAG: ${retrievalDecision.label(ragDecision)}`,
    });

    // Recorded before retrieval is attempted, so "switched off", "not needed"
    // and "never ran" are three distinguishable states rather than one blank.
    // A grounding pass that already ran keeps its record.
    ragMeta = ragMeta?.triggered ? ragMeta : {
      mode: effectiveRagMode,
      label: retrievalDecision.label(ragDecision),
      triggered: false,
      retrievalType: ragDecision.retrievalType,
      reason: ragDecision.reason,
      chunksRetrieved: 0,
      embeddingCostUsd: 0,
      retrievalLatencyMs: 0,
    };

    // Retrieval is decided by the retrieval service alone. Gating it on a
    // risk finding as well would mean ON silently does nothing on an ordinary
    // question - the mode would be a label rather than an instruction.
    //
    // A second search only earns its cost when risk labels exist, because the
    // query is then built from the risk rather than from the request. With no
    // risk, pre-generation grounding already retrieved exactly this.
    const alreadyRetrieved = ragMeta?.triggered === true && riskCategories.length === 0;

    if (ragDecision.shouldRetrieve && !alreadyRetrieved) {
      try {
        await policyIngestion.ensureSeeded();
        const jurisdictions = [...new Set(
          profile.jurisdiction.map(normaliseJurisdiction))];

        const retrieval = await policyRetrieval.retrieve({
          riskCategories,
          dataTypes: [...new Set(riskFindings.map((f) => f.redactClass ?? "").filter(Boolean))],
          actionName: intent?.name ?? null,
          external: input.destinationExternal,
          jurisdictions,
          // With no risk labels there is no risk-derived query to build, so
          // the request itself is what we search for.
          queryText: riskCategories.length === 0 ? input.prompt : undefined,
        });

        ledger.rag += retrieval.costUsd;
        // Both passes retrieved real sections, so both are recorded. The
        // grounding set is kept first: it is what the model actually saw.
        const seenChunks = new Set(retrievedEvidence.map((e) => e.chunkId));
        retrievedEvidence = [
          ...retrievedEvidence,
          ...retrieval.evidence.filter((e) => !seenChunks.has(e.chunkId)),
        ];

        ragMeta = {
          mode: effectiveRagMode,
          label: retrievalDecision.label(ragDecision),
          triggered: true,
          retrievalType: ragDecision.retrievalType,
          reason: ragDecision.reason,
          chunksRetrieved: retrievedEvidence.length,
          embeddingCostUsd: (ragMeta?.embeddingCostUsd ?? 0) + retrieval.costUsd,
          retrievalLatencyMs: retrieval.latencyMs ?? 0,
          evidence: retrievedEvidence,
          // Preserved from the grounding pass: this second search graded the
          // answer, but whether the model was grounded was already settled.
          groundedGeneration: grounded,
        };

        // The policy engine is a governance control, not a summariser. It is
        // asked only when there is something to govern; retrieving evidence
        // for an ordinary question must never manufacture a policy verdict.
        if (riskCategories.length > 0) {
          const verdict = policyDecisionEngine.decide({
            profile,
            jurisdictions,
            riskCategories,
            dataTypes: [],
            external: input.destinationExternal,
            actionName: intent?.name ?? null,
            actionValueUsd: intent?.valueUsd ?? 0,
            evidence: retrieval.evidence,
            retrievalMode: retrieval.mode,
          });

          policyOutcome = { retrieval, verdict, jurisdictions };

          emit({
            type: "status",
            stage: "policy",
            label: `Policy (${jurisdictions.join("/")}): ${verdict.decision} — ${
              retrieval.evidence.length} evidence section(s)`,
          });
        } else {
          emit({
            type: "status",
            stage: "policy",
            label: `Grounding: ${retrieval.evidence.length} indexed section(s) retrieved`,
          });
        }
      } catch (err) {
        // The policy layer must never take the request down; a failure here
        // leaves the governance verdict standing on its own.
        console.error("[policy] evaluation failed", err);
      }
    } else if (riskCategories.length > 0) {
      // Risk was detected but retrieval was suppressed. The engine is still
      // asked, with no evidence, so it returns UNVERIFIABLE and the profile's
      // escalation applies. Disabling retrieval must never mean "allowed".
      try {
        const jurisdictions = [...new Set(profile.jurisdiction.map(normaliseJurisdiction))];
        const verdict = policyDecisionEngine.decide({
          profile, jurisdictions, riskCategories, dataTypes: [],
          external: input.destinationExternal,
          actionName: intent?.name ?? null,
          actionValueUsd: intent?.valueUsd ?? 0,
          evidence: [], retrievalMode: "LEXICAL_FALLBACK",
        });
        policyOutcome = {
          retrieval: {
            evidence: [], mode: "LEXICAL_FALLBACK", model: "none", costUsd: 0,
            query: "", filters: { jurisdictions, categories: [] },
          },
          verdict, jurisdictions,
        };
      } catch (err) {
        console.error("[policy] no-retrieval evaluation failed", err);
      }
    }

    emit({
      type: "status",
      stage: "governance",
      label: `${profile.name}: ${governed.decision}${
        governed.intersectionsApplied.length
          ? ` (overlapping risk: ${governed.intersectionsApplied.join(", ")})` : ""}`,
    });

    decision = decisionEngine.decide({
      performance,
      cost: costService.check(recommendation, generation, {
        attempts, verificationCost: ledger.verification + ledger.rag, succeeded: true,
      }),
      responsibility,
      riskLevel: recommendation.riskLevel,
      consequence: {
        irreversible: intent ? !intent.reversible : false,
        external: input.destinationExternal,
        valueUsd: intent?.valueUsd ?? 0,
      },
      attempt: attempts,
      maxAttempts: MAX_ATTEMPTS,
    });

    // A1: every control contributes a signal and the strictest one binds.
    // Policy is a first-class control here, not audit decoration.
    const signals: ControlSignal[] = [
      {
        source: "GOVERNANCE",
        decision: governed?.decision ?? "ALLOW",
        reason: governed?.reason ?? "",
        skipped: !governed,
      },
      {
        source: "POLICY",
        decision: policyOutcome ? policyToDecision(policyOutcome.verdict.decision) : "ALLOW",
        reason: policyOutcome?.verdict.reason ?? "",
        skipped: !policyOutcome,
      },
      {
        source: "BASELINE",
        decision: decision.decision,
        reason: decision.reason,
      },
    ];

    merged = mergeControlDecisions(signals);
    decision = {
      decision: merged.decision,
      reason: merged.reason,
      recommendedAction: recommendedActionFor(merged.decision),
      annotations: [...new Set([...decision.annotations, ...(governed?.annotations ?? [])])],
    };

    if (decision.decision !== "REGENERATE" || attempts > MAX_ATTEMPTS) break;

    // Escalating to a stronger model is a quality decision, not a fallback.
    // When the user picked a model explicitly, dotAI stays on it unless they
    // allowed automatic substitution.
    if (input.selectedModelId && !input.allowFallback) break;

    const stronger = escalateFrom(modelId, routing);
    if (stronger) modelId = stronger;
  }

  if (!generation || !performance || !decision) {
    throw new ProviderError("The control loop did not complete.", "unknown");
  }

  // One turn, one contribution to conversation risk.
  sessionState = await sessionRiskService.record(
    input.sessionId ?? "", profile.id, riskFindings);

  // ---- Deterministic edit: mask identifiers, never rewrite reasoning ------
  let finalAnswer = answer;
  const redactClasses = responsibility.findings
    .map((f) => f.redactClass)
    .filter((c): c is string => Boolean(c));
  if ((decision.decision === "ALLOW" || decision.decision === "ANNOTATE") && redactClasses.length) {
    finalAnswer = redact(finalAnswer, redactClasses);
    decision.annotations.push("Sensitive identifiers were masked before delivery.");
  }

  // ---- ACTION GATE -------------------------------------------------------
  const intent = actionGate.detectIntent(input.prompt, input.destinationExternal);
  let gateResult = null;
  if (intent) {
    emit({ type: "status", stage: "action_gate", label: "Action Gate evaluating" });
    gateResult = actionGate.evaluate(intent, input.actor, profile);
    if (!gateResult.allowed) {
      // The gate may only make the outcome stricter. A BLOCK already returned
      // by the checker must never be relaxed to a HOLD by the gate.
      const ORDER: Decision[] = ["ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK"];
      const stricter =
        ORDER.indexOf(gateResult.decision) > ORDER.indexOf(decision.decision)
          ? gateResult.decision
          : decision.decision;
      decision = {
        ...decision,
        decision: stricter,
        reason:
          stricter === gateResult.decision
            ? `Action Gate (${gateResult.stage}): ${gateResult.reason}`
            : decision.reason,
        recommendedAction: stricter === "HOLD" ? "human_review"
          : stricter === "BLOCK" ? "block" : decision.recommendedAction,
      };
    }
  }

  const cost = costService.check(recommendation, generation, {
    attempts,
    verificationCost: ledger.verification + ledger.rag,
    succeeded: decision.decision === "ALLOW" || decision.decision === "ANNOTATE",
  });


  emit({ type: "status", stage: "decision", label: `Decision: ${decision.decision}` });

  const checkerLatencyMs = Date.now() - checkerStarted;

  // Only responses the checker cleared join the baseline. Learning from
  // failures would let a run of bad answers redefine normal.
  if (decision.decision === "ALLOW" || decision.decision === "ANNOTATE") {
    void anomalyDetector.learn(answer, {
      profileId: profile.id,
      taskType: routing.taskType,
      modelId,
    }, { passed: true });
  }

  // Task-specific feedback. A failure here changes this model's score for
  // THIS task only - failing at images must not lower its summarisation score.
  void modelIntelligenceService.recordOutcome({
    openrouterModelId: modelId,
    taskType: routing.taskType,
    success: decision.decision === "ALLOW" || decision.decision === "ANNOTATE",
    latencyMs: generation.latencyMs,
    costUsd: generation.cost,
    qualityFailure: performance.status === "CONTRADICTED",
  });

  if (policyOutcome) {
    await recordPolicyDecision(
      input.requestId, profile.id, policyOutcome,
      [...new Set(riskFindings.flatMap((f) => f.categories))]);
  }

  const controlEvent: ControlEventData = {
    requestId: input.requestId,
    profileId: profile.id,
    profileName: profile.name,
    riskFindings,
    riskCategories: governed?.categories ?? [],
    decisionTrace: governed?.trace ?? [],
    intersectionsApplied: governed?.intersectionsApplied ?? [],
    sessionRisk: {
      level: sessionState.riskLevel,
      score: sessionState.riskScore,
      unverifiedClaims: sessionState.unverifiedClaimCount,
      contradictions: sessionState.contradictionCount,
      responsibilityFindings: sessionState.responsibilityFindingCount,
      highRiskActions: sessionState.highRiskActionCount,
      turns: sessionState.turnCount,
    },
    verificationDepthReason: depthResolution.reason,
    checkerLatencyMs,
    taskClassification: recommendation.taskType,
    // CAI's sub-task, so the audit record says the same thing the user saw.
    subTaskLabel: capability.analysis.subTaskName,
    workflow: {
      profileId: profile.id,
      profileName: profile.name,
      stages: profile.workflow.stages,
      summary: profile.workflow.summary,
      retrieval: profile.workflow.retrieval,
      requireCitations: profile.workflow.requireCitations,
      boundedVerification: profile.workflow.boundedVerification,
      treatUncertaintyAsBlocking: profile.workflow.treatUncertaintyAsBlocking,
    },
    complexity: recommendation.complexity,
    recommendedModel: recommendation.recommendedModel,
    selectedModel: generation.modelId,
    capability,
    firewall,
    provider: generation.provider,
    effort: recommendation.recommendedEffort,
    estimatedCost: recommendation.estimatedCost,
    actualCost: generation.cost,
    verification: performance,
    cost,
    responsibility,
    riskLevel: recommendation.riskLevel,
    verificationDepth: depthResolution.depth,
    decisionMerge: merged ? {
      decidedBy: merged.decidedBy,
      concurring: merged.concurring,
      explanation: merged.explanation,
      contributions: merged.contributions.map((c) => ({
        source: c.source, decision: c.decision, reason: c.reason,
      })),
    } : undefined,
    costBreakdown: {
      generation: generation.cost,
      // CAI runs on every request, so its spend belongs in routing overhead
      // rather than sitting outside the ledger entirely.
      routing: routing.routingCostUsd + caiCost,
      verification: ledger.verification,
      rag: ledger.rag,
      retry: ledger.retry,
      controlPlaneOverhead:
        routing.routingCostUsd + caiCost + ledger.verification + ledger.rag,
      total:
        generation.cost + routing.routingCostUsd + caiCost +
        ledger.verification + ledger.rag + ledger.retry,
    },
    rag: ragMeta,
    policy: policyOutcome ? {
      jurisdictions: policyOutcome.jurisdictions,
      decision: policyOutcome.verdict.decision,
      reason: policyOutcome.verdict.reason,
      appliedRule: policyOutcome.verdict.appliedRule,
      conflict: policyOutcome.verdict.conflict,
      caveat: policyOutcome.verdict.caveat,
      retrievalMode: policyOutcome.retrieval.mode,
      evidence: policyOutcome.verdict.citedEvidence,
    } : undefined,
    decision,
    actionGate: gateResult,
    latencyMs: Date.now() - started,
    attempts,
    rationale: recommendation.rationale,
    routeSource: routing.routeSource,
    caiUsed: routing.caiUsed,
    caiSkippedReason: routing.caiSkippedReason,
    routingCostUsd: routing.routingCostUsd,
    fastRouterConfidence: routing.fastRouter.confidence,
    requirementProfile: routing.requirementProfile,
    qualifiedCount: routing.qualifiedCount,
    modelOptions: routing.options,
    mock,
  };

  // Blocked and held answers are never delivered to the client. A held answer
  // is still retained so a reviewer can read, edit and approve it.
  const deliverable =
    decision.decision === "BLOCK" || decision.decision === "HOLD" ? "" : finalAnswer;
  const heldAnswer = decision.decision === "HOLD" ? finalAnswer : "";

  await checkerMetrics.record({
    requestId: input.requestId,
    profileId: profile.id,
    sessionId: input.sessionId ?? null,
    decision: decision.decision,
    escalatedToHuman: decision.decision === "HOLD",
    categories: governed?.categories ?? [],
    findingCount: riskFindings.length,
    verificationDepth: depthResolution.depth,
    sessionRiskLevel: sessionState.riskLevel,
    checkerLatencyMs,
    verificationAttempted: performance.checksRun.includes("evidence"),
    verificationPossible: performance.claimsChecked > 0,
    selectedModel: modelId,
    cost: {
      estimated: routing.estimatedCost,
      generation: generation.cost,
      cai: routing.routingCostUsd,
      rag: ledger.rag,
      verification: ledger.verification,
      retry: ledger.retry,
      total: generation.cost + routing.routingCostUsd + ledger.rag +
        ledger.verification + ledger.retry,
      controlPlaneOverhead: routing.routingCostUsd + ledger.rag + ledger.verification,
    },
  });

  // ---- DOCUMENT OUTPUT ---------------------------------------------------
  // Rendered only after the decision. A BLOCK produces no artefact at all, and
  // a HOLD keeps the content for review rather than handing over a file.
  let document: GeneratedDocumentRef | undefined;
  if (wantsDocument && decision.decision !== "BLOCK" && decision.decision !== "HOLD") {
    try {
      emit({ type: "status", stage: "document", label: "Rendering DOCX" });
      const rendered = await generateDocx({
        title: documentTitle(input.prompt),
        content: deliverable,
        notice: mock
          ? "Generated by dotAI in mock mode: the text was produced by a simulated model."
          : undefined,
        simulated: mock,
      });

      const stored = await saveGeneratedDocument(rendered);
      document = {
        fileName: rendered.fileName,
        mimeType: rendered.mimeType,
        size: rendered.size,
        url: stored,
        simulated: rendered.simulated,
      };
      emit({
        type: "document",
        fileName: document.fileName,
        mimeType: document.mimeType,
        size: document.size,
        url: document.url,
        simulated: document.simulated,
      });
    } catch (err) {
      console.error("[document] rendering failed", err);
    }
  }

  return { answer: deliverable, heldAnswer, document, controlEvent };
}

/**
 * Formats retrieved policy sections for the model.
 *
 * The instruction is deliberately restrictive: the model may answer *from*
 * these sections and must say so when they do not cover the question. It is
 * not invited to reason about what the policy ought to mean - that remains
 * the deterministic engine's job.
 */
function buildGroundingBlock(
  evidence: import("@/lib/policy/engine").PolicyEvidence[],
): string {
  if (!evidence.length) return "";

  const sections = evidence
    .map((e, i) =>
      `[${i + 1}] ${e.documentName} — ${e.section} (${e.regulation} ${e.version}, ${e.jurisdiction})\n${e.text}`)
    .join("\n\n");

  return [
    "\n\n---",
    "Indexed policy sections retrieved for this request:",
    "",
    sections,
    "",
    "Answer using these sections where they apply, and refer to them by their",
    "number. If they do not cover the question, say so plainly rather than",
    "filling the gap from general knowledge.",
    "---",
  ].join("\n");
}


/**
 * Raised when the privacy firewall stops a request before generation.
 *
 * Carries the full result so the UI can explain what was found, what the
 * policy said and why - a bare refusal would leave the user guessing.
 */
export class PrivacyFirewallError extends Error {
  constructor(readonly firewall: FirewallResult) {
    super(firewall.reason);
    this.name = "PrivacyFirewallError";
  }
}

/** A short, filesystem-safe title taken from the request. */
function documentTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/\b(?:create|generate|write|produce|make|export)\b/gi, "")
    .replace(/\b(?:a|an|the|as|into|to)\b/gi, " ")
    .replace(/\b(?:docx|word document|document|file)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const title = cleaned.split(/[.?!]/)[0]?.trim() || "dotAI report";
  return title.charAt(0).toUpperCase() + title.slice(1, 70);
}

/** Writes the artefact where the browser can fetch it. */
async function saveGeneratedDocument(
  doc: { buffer: Buffer; fileName: string },
): Promise<string> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const dir = path.join(process.cwd(), "public", "uploads");
  await fs.mkdir(dir, { recursive: true });
  const stored = `${crypto.randomUUID()}-${path.basename(doc.fileName)}`;
  await fs.writeFile(path.join(dir, stored), doc.buffer);
  // Served through the file route: files written after the build are not
  // picked up by Next's static handler.
  return `/api/files/${encodeURIComponent(stored)}`;
}

/**
 * Image generation still passes through ControlPlane. Responsibility runs on
 * the prompt, and a provider failure is recorded as PROVIDER_FAILURE rather
 * than being mistaken for the model reasoning badly.
 */
async function runImageGeneration(
  input: RunInput,
  routing: RoutingResult,
  modelId: string,
  emit: (e: StreamEvent) => void,
  started: number,
  mock: boolean,
  profile: import("@/lib/governance/profiles").UseCaseProfile,
  sessionState: Awaited<ReturnType<typeof sessionRiskService.get>>,
  /** Passed through so an image turn records the same routing evidence. */
  capability: CuratedRoutingDecision,
  /** The firewall verdict for this request, recorded on the image event too. */
  firewall: FirewallResult,
): Promise<RunOutput> {
  const ledger = { rag: 0 };

  // ---- A3: GOVERNANCE BEFORE GENERATION ---------------------------------
  // The pixels carry no factual claims to verify, but the *request* does. A
  // prohibited image must never be produced and then judged afterwards.
  emit({ type: "status", stage: "checking", label: "Checking request" });

  const preResponsibility = responsibilityService.check(input.prompt, {
    destination: { channel: "chat", external: input.destinationExternal },
    actor: input.actor,
    context: input.prompt,
  });

  const intent = actionGate.detectIntent(input.prompt, input.destinationExternal);

  const preFindings = toRiskFindings(
    { status: "UNVERIFIABLE", claimsChecked: 0, verdicts: [], checksRun: [], earlyExit: false },
    preResponsibility,
    {
      answerText: input.prompt,
      highConsequenceAction: Boolean(intent),
      actionValueUsd: intent?.valueUsd ?? 0,
    },
  );

  const preCategories = [...new Set(preFindings.flatMap((f) => f.categories))];
  let imagePolicy: import("@/lib/policy/audit").PolicyOutcome | null = null;

  if (preCategories.length > 0) {
    try {
      await policyIngestion.ensureSeeded();
      const jurisdictions = [...new Set(profile.jurisdiction.map(normaliseJurisdiction))];
      const retrieval = await policyRetrieval.retrieve({
        riskCategories: preCategories,
        actionName: intent?.name ?? null,
        external: input.destinationExternal,
        jurisdictions,
      });
      ledger.rag += retrieval.costUsd;
      const verdict = policyDecisionEngine.decide({
        profile, jurisdictions, riskCategories: preCategories, dataTypes: [],
        external: input.destinationExternal, actionName: intent?.name ?? null,
        actionValueUsd: intent?.valueUsd ?? 0,
        evidence: retrieval.evidence, retrievalMode: retrieval.mode,
      });
      imagePolicy = { retrieval, verdict, jurisdictions };
      emit({
        type: "status", stage: "policy",
        label: `Policy (${jurisdictions.join("/")}): ${verdict.decision}`,
      });
    } catch (err) {
      console.error("[policy] image evaluation failed", err);
    }
  }

  const preGoverned = governedDecisionEngine.decide({
    profile,
    findings: preFindings,
    sessionRisk: sessionState.riskLevel,
    consequence: {
      irreversible: intent ? !intent.reversible : false,
      external: input.destinationExternal,
      valueUsd: intent?.valueUsd ?? 0,
      actionName: intent?.name,
    },
    attempt: 1,
    maxAttempts: 1,
  });

  const preMerged = mergeControlDecisions([
    { source: "GOVERNANCE", decision: preGoverned.decision, reason: preGoverned.reason },
    {
      source: "POLICY",
      decision: imagePolicy ? policyToDecision(imagePolicy.verdict.decision) : "ALLOW",
      reason: imagePolicy?.verdict.reason ?? "",
      skipped: !imagePolicy,
    },
    {
      source: "RESPONSIBILITY",
      decision: preResponsibility.status === "PROHIBITED" ? "BLOCK" : "ALLOW",
      reason: preResponsibility.findings[0]?.message ?? "",
      skipped: preResponsibility.status !== "PROHIBITED",
    },
  ]);

  // A blocked request is never generated. This is the whole point of checking
  // the request rather than the artefact.
  const blockedBeforeGeneration = preMerged.decision === "BLOCK";

  if (!blockedBeforeGeneration) {
    emit({ type: "status", stage: "generating", label: `Generating image with ${modelName(modelId)}` });
  } else {
    emit({ type: "status", stage: "decision", label: `Blocked before generation: ${preMerged.decidedBy}` });
  }

  let image;
  let providerError: string | null = null;
  let failureReason: import("@/lib/models/execution").FailureReason | undefined;
  const requestedModelId = modelId;
  let fallbackReason: string | undefined;
  try {
    if (blockedBeforeGeneration) {
      throw new CapabilityMismatchError(preMerged.reason || "Request blocked by policy.");
    }
    // Capability was established from the curated dataset: the model is in
    // the eligible set, which required its output forms to include Image.
    const curatedImageOk = Boolean(
      capability.eligible.some((m) => m.openrouterId === modelId));
    image = await generationRouter.generateImage(
      input.prompt, modelId, input.signal, curatedImageOk);
    await modelExecution.recordExecution(modelId, "IMAGE", true, undefined, undefined, input.requestId);
  } catch (err) {
    providerError = err instanceof Error ? err.message : "Image generation failed.";
    // The reason is structured so the learning system can tell an unusable
    // model apart from a provider having a bad minute.
    failureReason = err instanceof CapabilityMismatchError
      ? "MODALITY_UNSUPPORTED"
      : /timed out|timeout/i.test(providerError) ? "TIMEOUT"
      : /no openrouter key|auth/i.test(providerError) ? "AUTHENTICATION_ERROR"
      : /returned 4\d\d/.test(providerError) ? "INVALID_REQUEST"
      : "PROVIDER_ERROR";
    await modelExecution.recordExecution(
      modelId, "IMAGE", false, failureReason, providerError, input.requestId);
    if (err instanceof CapabilityMismatchError) {
      emit({ type: "status", stage: "capability", label: "Capability mismatch" });
    }

    // Fallback is explicit and announced. A capability mismatch is never
    // retried elsewhere - that would just move the same error.
    const eligible = input.allowFallback && failureReason !== "MODALITY_UNSUPPORTED";
    if (eligible) {
      const next = routing.options.all.find((o) => o.modelId !== modelId);
      if (next) {
        emit({
          type: "status", stage: "fallback",
          label: `${modelName(modelId)} failed (${failureReason}). Falling back to ${modelName(next.modelId)}.`,
        });
        try {
          image = await generationRouter.generateImage(
            input.prompt, next.modelId, input.signal,
            capability.eligible.some((m) => m.openrouterId === next.modelId));
          await modelExecution.recordExecution(
            next.modelId, "IMAGE", true, undefined, undefined, input.requestId);
          fallbackReason = failureReason;
          modelId = next.modelId;
          providerError = null;
        } catch (err2) {
          const m2 = err2 instanceof Error ? err2.message : String(err2);
          await modelExecution.recordExecution(
            next.modelId, "IMAGE", false, "GENERATION_FAILED", m2, input.requestId);
        }
      }
    }
  }

  emit({ type: "status", stage: "checking", label: "ControlPlane checking" });

  // Responsibility applies to the request itself even when no text was written.
  const responsibility = responsibilityService.check(input.prompt, {
    destination: { channel: "chat", external: input.destinationExternal },
    actor: input.actor,
    context: input.prompt,
  });

  const performance: PerformanceResult = {
    status: "UNVERIFIABLE",
    claimsChecked: 0,
    verdicts: [],
    checksRun: ["modality_check"],
    earlyExit: false,
    note: image
      ? "Image output carries no textual claims to verify."
      : "No image was produced, so there is nothing to verify.",
  };

  const generation = {
    text: "", modelId, provider: modelRegistry.get(modelId)?.provider ?? "openrouter",
    inputTokens: Math.ceil(input.prompt.length / 4), outputTokens: 0,
    reasoningTokens: 0, cost: image?.costUsd ?? 0, latencyMs: image?.latencyMs ?? 0,
  };

  const cost = costService.check(recommendationFor(routing, modelId), generation, {
    attempts: 1, verificationCost: 0, succeeded: Boolean(image),
  });

  // The same merge mechanism as the text path: every control contributes and
  // the strictest binds. A provider failure is a delivery failure, not a
  // governance verdict, so it is merged as its own signal.
  const merged = mergeControlDecisions([
    ...preMerged.contributions,
    {
      source: "ACTION_GATE",
      decision: providerError ? "BLOCK" : "ALLOW",
      reason: providerError ?? "",
      skipped: !providerError,
    },
    {
      source: "RESPONSIBILITY",
      decision: responsibility.status === "PROHIBITED" ? "BLOCK" : "ALLOW",
      reason: responsibility.findings[0]?.message ?? "",
      skipped: responsibility.status !== "PROHIBITED",
    },
  ]);

  const decision = {
    decision: merged.decision,
    reason: merged.decision === "ALLOW" ? "Image generated." : merged.reason,
    recommendedAction: recommendedActionFor(merged.decision),
    annotations: image?.simulated
      ? ["Simulated image (mock mode). Connect OpenRouter for real generation."]
      : [],
  };

  // Session risk accumulates for image turns too, so a run of risky image
  // requests deepens scrutiny exactly as it does for text.
  const imageSession = await sessionRiskService.record(
    input.sessionId ?? "", profile.id, preFindings);

  emit({ type: "status", stage: "decision", label: `Decision: ${decision.decision}` });

  // The loop announces the image itself, so every caller streams it rather
  // than only the chat route.
  if (image && decision.decision !== "BLOCK") {
    emit({
      type: "image", url: image.url, mimeType: image.mimeType, simulated: image.simulated,
    });
  }

  const controlEvent: ControlEventData = {
    requestId: input.requestId,
    taskClassification: routing.taskType,
    complexity: routing.complexity,
    recommendedModel: routing.recommendedModel,
    selectedModel: modelId,
    capability,
    firewall,
    provider: generation.provider,
    effort: routing.recommendedEffort,
    estimatedCost: routing.estimatedCost,
    actualCost: generation.cost,
    verification: performance,
    cost,
    responsibility,
    riskLevel: routing.riskLevel,
    verificationDepth: routing.verificationDepth,
    decision,
    actionGate: null,
    latencyMs: Date.now() - started,
    attempts: 1,
    rationale: routing.rationale,
    routeSource: routing.routeSource,
    caiUsed: routing.caiUsed,
    caiSkippedReason: routing.caiSkippedReason,
    routingCostUsd: routing.routingCostUsd,
    fastRouterConfidence: routing.fastRouter.confidence,
    requirementProfile: routing.requirementProfile,
    qualifiedCount: routing.qualifiedCount,
    modelOptions: routing.options,
    providerFailure: Boolean(providerError),
    executionFailureReason: failureReason,
    profileId: profile.id,
    sessionRisk: {
      level: imageSession.riskLevel,
      score: imageSession.riskScore,
      unverifiedClaims: imageSession.unverifiedClaimCount,
      contradictions: imageSession.contradictionCount,
      responsibilityFindings: imageSession.responsibilityFindingCount,
      highRiskActions: imageSession.highRiskActionCount,
      turns: imageSession.turnCount,
    },
    decisionMerge: {
      decidedBy: merged.decidedBy,
      concurring: merged.concurring,
      explanation: merged.explanation,
      contributions: merged.contributions.map((c) => ({
        source: c.source, decision: c.decision, reason: c.reason,
      })),
    },
    costBreakdown: {
      generation: image?.costUsd ?? 0,
      routing: routing.routingCostUsd,
      verification: 0,
      rag: ledger.rag,
      retry: 0,
      controlPlaneOverhead: routing.routingCostUsd + ledger.rag,
      total: (image?.costUsd ?? 0) + routing.routingCostUsd + ledger.rag,
    },
    policy: imagePolicy ? {
      jurisdictions: imagePolicy.jurisdictions,
      decision: imagePolicy.verdict.decision,
      reason: imagePolicy.verdict.reason,
      appliedRule: imagePolicy.verdict.appliedRule,
      conflict: imagePolicy.verdict.conflict,
      caveat: imagePolicy.verdict.caveat,
      retrievalMode: imagePolicy.retrieval.mode,
      evidence: imagePolicy.verdict.citedEvidence,
    } : undefined,
    requestedModel: requestedModelId,
    executedModel: modelId,
    fallbackReason,
    mock,
  };

  // Image turns are recorded too, otherwise image traffic would be invisible
  // to every profile metric and cost report.
  await checkerMetrics.record({
    requestId: input.requestId,
    profileId: profile.id,
    sessionId: input.sessionId ?? null,
    decision: merged.decision,
    escalatedToHuman: merged.decision === "HOLD",
    categories: preCategories,
    findingCount: preFindings.length,
    verificationDepth: "light",
    sessionRiskLevel: imageSession.riskLevel,
    checkerLatencyMs: Date.now() - started,
    verificationAttempted: false,
    verificationPossible: false,
    selectedModel: modelId,
    cost: {
      estimated: routing.estimatedCost,
      generation: image?.costUsd ?? 0,
      cai: routing.routingCostUsd,
      rag: ledger.rag,
      verification: 0,
      retry: 0,
      total: (image?.costUsd ?? 0) + routing.routingCostUsd + ledger.rag,
      controlPlaneOverhead: routing.routingCostUsd + ledger.rag,
    },
  });

  return {
    answer: decision.decision === "BLOCK" ? "" : "",
    heldAnswer: "",
    image: image && decision.decision !== "BLOCK"
      ? { url: image.url, mimeType: image.mimeType, simulated: image.simulated }
      : undefined,
    controlEvent,
  };
}

function recommendationFor(routing: RoutingResult, modelId: string): ModelRecommendation {
  return toRecommendation(routing, modelId);
}

/** Failure-aware escalation: only after a check actually failed. */
function escalateFrom(currentId: string, routing: RoutingResult): string | null {
  const current = routing.options.all.find((o) => o.modelId === currentId);
  const stronger = routing.options.all
    .filter((o) => o.modelId !== currentId &&
      o.expectedSuccess > (current?.expectedSuccess ?? 0))
    .sort((a, b) => a.estimatedCost - b.estimatedCost);
  return stronger[0]?.modelId ?? null;
}

/** Adapts a RoutingResult to the ModelRecommendation the UI already renders. */
function toRecommendation(routing: RoutingResult, chosenId: string): ModelRecommendation {
  const chosen = routing.options.all.find((o) => o.modelId === chosenId);
  return {
    taskType: routing.taskType,
    complexity: routing.complexity,
    requiredCapabilities: routing.requiredCapabilities,
    recommendedModel: chosenId,
    bestModel: routing.bestModel,
    alternativeModel: routing.alternativeModel,
    recommendedEffort: routing.recommendedEffort,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedCost: chosen?.estimatedCost ?? routing.estimatedCost,
    confidence: chosen?.expectedSuccess ?? routing.confidence,
    rationale: routing.rationale,
    riskLevel: routing.riskLevel,
    verificationDepth: routing.verificationDepth,
    candidates: routing.candidates,
    routeSource: routing.routeSource,
    caiUsed: routing.caiUsed,
    caiSkippedReason: routing.caiSkippedReason,
    routingCostUsd: routing.routingCostUsd,
  };
}

function modelName(id: string): string {
  return modelRegistry.get(id)?.name ?? id;
}

function labelTask(t: string): string {
  const s = t.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
