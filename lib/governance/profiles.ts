import type { Decision, RiskLevel, VerificationDepth } from "@/types";

/**
 * Risk labels are multi-label by design. A fabricated detail about a named
 * person is simultaneously a hallucination and a privacy problem, and forcing
 * it into one bucket loses exactly the signal that should escalate it.
 */
export const RISK_CATEGORIES = [
  "HALLUCINATION",
  "UNVERIFIABLE",
  "PRIVACY",
  "SENSITIVE_DATA",
  "SAFETY",
  "FAIRNESS",
  "SECURITY",
  "POLICY_VIOLATION",
  "HIGH_CONSEQUENCE_ACTION",
  "COST",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export type Severity = "low" | "medium" | "high" | "critical";
export const SEVERITY_RANK: Record<Severity, number> = {
  low: 1, medium: 2, high: 3, critical: 4,
};

/**
 * Pairs of risks that mean more together than apart. These are declared as
 * data with an explanation attached, so a decision can always say *why* the
 * intervention level rose rather than pointing at an opaque score.
 */
export interface RiskIntersection {
  categories: [RiskCategory, RiskCategory];
  escalate: number;              // how many levels to raise the intervention
  explanation: string;
}

export const RISK_INTERSECTIONS: RiskIntersection[] = [
  {
    categories: ["HALLUCINATION", "PRIVACY"],
    escalate: 2,
    explanation:
      "A fabricated claim about an identifiable person is both an accuracy and a privacy failure; either alone is recoverable, together they are not.",
  },
  {
    categories: ["HALLUCINATION", "SENSITIVE_DATA"],
    escalate: 2,
    explanation:
      "An unsupported claim attached to sensitive data can propagate an error into a record that is hard to correct.",
  },
  {
    categories: ["HALLUCINATION", "HIGH_CONSEQUENCE_ACTION"],
    escalate: 2,
    explanation:
      "An unverified claim is about to drive a consequential action, so the error becomes irreversible.",
  },
  {
    categories: ["PRIVACY", "POLICY_VIOLATION"],
    escalate: 1,
    explanation:
      "Personal data is being handled in a way that also breaches policy, which raises the regulatory exposure.",
  },
  {
    categories: ["FAIRNESS", "HIGH_CONSEQUENCE_ACTION"],
    escalate: 2,
    explanation:
      "A possible fairness problem is influencing a decision about a person, which is where bias causes real harm.",
  },
  {
    categories: ["UNVERIFIABLE", "HIGH_CONSEQUENCE_ACTION"],
    escalate: 1,
    explanation:
      "A claim that cannot be checked is being relied on for a consequential decision.",
  },
  {
    categories: ["SECURITY", "HIGH_CONSEQUENCE_ACTION"],
    escalate: 2,
    explanation:
      "A security signal appears alongside a consequential action, which is the shape of an attempted misuse.",
  },
];

/**
 * A use case is a policy, expressed as data.
 *
 * The premise of the brief is that a support assistant, an internal copilot
 * and a decision-support tool cannot share one checking configuration: they
 * differ in latency budget, risk tolerance and who carries the consequence.
 * Everything that differs between them lives here, never in code branches.
 */
/**
 * One stage of a profile's ControlPlane workflow.
 *
 * These are the stages that actually run, in order. Two profiles that differ
 * only in thresholds are the same product with different numbers; these
 * describe genuinely different sequences of work.
 */
export type WorkflowStage =
  | "DETECT"              // risk and PII detection on the request
  | "PRIVACY_CHECK"       // the pre-generation privacy firewall
  | "POLICY_CHECK"        // policy rules for the use case
  | "INTERNAL_DATA_CHECK" // does this need internal knowledge at all
  | "RETRIEVE_EVIDENCE"   // RAG over the policy/knowledge corpus
  | "ACCESS_CHECK"        // may this actor see what was retrieved
  | "VERIFY"              // claim verification
  | "FAST_VERIFY"         // bounded verification, latency-first
  | "UNCERTAINTY_CHECK"   // conflicting or unresolved evidence
  | "STRICT_POLICY"       // second, stricter policy pass
  | "HUMAN_APPROVAL"      // route to a person before acting
  | "CITE"                // attach evidence to the answer
  | "DECIDE"
  | "DELIVER";

export interface ProfileWorkflow {
  /** The stages this profile runs, in order. */
  stages: WorkflowStage[];
  /** One line describing what this workflow is for. */
  summary: string;
  /**
   * Retrieval policy. FORCED means this profile always retrieves regardless
   * of the request's RAG setting, because its whole purpose depends on it.
   */
  retrieval: "FORCED" | "AUTO" | "OFF";
  /** Answers must carry citations to the evidence they rest on. */
  requireCitations: boolean;
  /** A consequential action always routes to a person, whatever the findings. */
  alwaysHumanForActions: boolean;
  /** Verification is bounded to protect latency rather than run to completion. */
  boundedVerification: boolean;
  /** Conflicting or unresolved evidence is itself a reason to hold. */
  treatUncertaintyAsBlocking: boolean;
}

export interface UseCaseProfile {
  id: string;
  /** The ordered ControlPlane workflow this profile runs. */
  workflow: ProfileWorkflow;
  name: string;
  description: string;

  /** How much residual risk this use case is willing to carry. */
  riskTolerance: "low" | "moderate" | "high";
  /** Floor for verification. Response and session risk may raise it, never lower it. */
  baseVerificationDepth: VerificationDepth;
  /** Latency budget in milliseconds for the checking stage. */
  latencySLOms: number;

  /**
   * Severity at which each intervention begins. Lower numbers mean a stricter
   * profile: this is the operating point, chosen deliberately per use case.
   */
  thresholds: {
    annotate: Severity;
    regenerate: Severity;
    escalate: Severity;   // HOLD_FOR_HUMAN
    block: Severity;
    /** Verify claims when the response reaches this risk level. */
    verification: RiskLevel;
  };

  /** Categories this use case treats as automatically escalating. */
  escalationRules: {
    alwaysEscalateCategories: RiskCategory[];
    alwaysBlockCategories: RiskCategory[];
    /** Value above which a proposed action needs a human, regardless of findings. */
    humanApprovalAboveUsd: number;
    /** Session risk level at which every response goes to a human. */
    escalateAtSessionRisk: "MEDIUM" | "HIGH" | "NEVER";
  };

  allowedActions: string[];
  blockedActions: string[];

  /** Drives which policy pack applies. Regulation differs by geography. */
  jurisdiction: string[];

  /** Status at or above which the dimension forces intervention. */
  responsibilityThreshold: "PERMITTED" | "RESTRICTED" | "PROHIBITED";
  performanceThreshold: "SUPPORTED" | "UNCERTAIN" | "CONTRADICTED";
  costThresholdUsd: number;

  /** Whether overlapping risk categories raise the intervention level. */
  intersectionAware: boolean;
}

/**
 * Demo profiles. Deliberately different from one another - the same response
 * should land differently depending on which one is active.
 */
/**
 * Governance policies.
 *
 * These are backend policy, not a user-facing choice. They were once a Chat
 * dropdown, which meant how strictly a request was judged depended on a
 * setting the user had no basis for choosing - so the selector is gone and
 * the profile is decided by how the deployment is configured.
 *
 * BASELINE remains the default. The three named policies exist so an operator
 * can run dotAI under a stance that suits their use case, and they differ in
 * the three things that actually matter: how much risk is tolerated, how hard
 * an answer is verified, and how much latency that is worth.
 */
export const USE_CASE_PROFILES: Record<string, UseCaseProfile> = {
  BASELINE: {
    id: "BASELINE",
    workflow: {
      summary:
        "Detect, verify, decide, deliver. General-purpose protection with no "
        + "special obligation to retrieve, cite, or involve a person.",
      stages: ["DETECT", "VERIFY", "DECIDE", "DELIVER"],
      retrieval: "AUTO",
      requireCitations: false,
      alwaysHumanForActions: false,
      boundedVerification: false,
      treatUncertaintyAsBlocking: false,
    },
    name: "Baseline governance",
    description:
      "The default policy: moderate risk tolerance, light verification raised by risk, and a balanced latency budget.",
    riskTolerance: "moderate",
    // Light by default, raised by risk. A `standard` floor made every
    // trivial turn ("say hello") run retrieval and the deeper checks, which
    // spends latency and tokens on requests with nothing to verify.
    baseVerificationDepth: "light",
    latencySLOms: 2000,
    thresholds: {
      annotate: "low",
      regenerate: "medium",
      escalate: "high",
      block: "critical",
      verification: "medium",
    },
    escalationRules: {
      alwaysEscalateCategories: [],
      // Personal and sensitive data leaving the system is the line this
      // policy will not caveat its way past.
      alwaysBlockCategories: ["PRIVACY", "SENSITIVE_DATA", "SECURITY"],
      humanApprovalAboveUsd: 1000,
      escalateAtSessionRisk: "HIGH",
    },
    // Consequential money movement is held for a person rather than executed.
    allowedActions: ["read_account", "send_email", "issue_refund", "approve_payment"],
    blockedActions: ["wire_transfer"],
    jurisdiction: ["EU", "IN", "US"],
    responsibilityThreshold: "RESTRICTED",
    performanceThreshold: "CONTRADICTED",
    costThresholdUsd: 0.25,
    intersectionAware: true,
  },

  CUSTOMER_SUPPORT: {
    id: "CUSTOMER_SUPPORT",
    workflow: {
      summary:
        "Privacy first, then policy, then verification bounded by the latency "
        + "budget. A customer is waiting, so checking runs to a deadline rather "
        + "than to completion - and what it will not trade away is their data.",
      stages: [
        "DETECT", "PRIVACY_CHECK", "POLICY_CHECK", "FAST_VERIFY", "DECIDE", "DELIVER",
      ],
      // Retrieval costs latency and support answers rarely turn on the policy
      // corpus, so it runs only when the request actually calls for it.
      retrieval: "AUTO",
      requireCitations: false,
      alwaysHumanForActions: true,
      // The distinguishing choice: verification is capped, not exhaustive.
      boundedVerification: true,
      treatUncertaintyAsBlocking: false,
    },
    name: "Customer Support",
    description:
      "Answers reach a waiting customer, so latency is tight and verification is light. Customer data is the thing that must not leak, so privacy findings block outright and anything touching money needs a person.",
    // A support agent is not making irreversible decisions, so ordinary
    // uncertainty is tolerated where it would be caveated elsewhere.
    riskTolerance: "high",
    baseVerificationDepth: "light",
    // Somebody is waiting. A slow answer is a failed answer here.
    latencySLOms: 1200,
    thresholds: {
      annotate: "medium",
      regenerate: "high",
      escalate: "high",
      block: "critical",
      verification: "high",
    },
    escalationRules: {
      alwaysEscalateCategories: ["HIGH_CONSEQUENCE_ACTION"],
      alwaysBlockCategories: ["PRIVACY", "SENSITIVE_DATA", "SECURITY"],
      // Low bar: a support agent should not be committing money unattended.
      humanApprovalAboveUsd: 100,
      escalateAtSessionRisk: "MEDIUM",
    },
    allowedActions: ["read_account", "send_email", "issue_refund"],
    blockedActions: ["wire_transfer", "approve_payment"],
    jurisdiction: ["EU", "IN", "US"],
    responsibilityThreshold: "RESTRICTED",
    performanceThreshold: "CONTRADICTED",
    costThresholdUsd: 0.10,
    intersectionAware: true,
  },

  INTERNAL_COPILOT: {
    id: "INTERNAL_COPILOT",
    workflow: {
      summary:
        "Establish whether the question needs internal knowledge, retrieve it, "
        + "check the asker may see it, verify, and answer with citations. The "
        + "point is grounded answers from trusted internal sources, so an "
        + "uncited answer is a failure of the workflow rather than a style "
        + "preference.",
      stages: [
        "DETECT", "INTERNAL_DATA_CHECK", "RETRIEVE_EVIDENCE", "ACCESS_CHECK",
        "VERIFY", "CITE", "DECIDE", "DELIVER",
      ],
      // Forced: this profile exists to answer from internal knowledge, so it
      // retrieves whether or not the request asked it to.
      retrieval: "FORCED",
      requireCitations: true,
      alwaysHumanForActions: false,
      boundedVerification: false,
      treatUncertaintyAsBlocking: false,
    },
    name: "Internal Copilot",
    description:
      "Colleagues asking colleagues' questions. Content restrictions relax because the audience is internal, but an unverifiable claim is still annotated rather than presented as fact.",
    riskTolerance: "moderate",
    baseVerificationDepth: "standard",
    latencySLOms: 4000,
    thresholds: {
      annotate: "low",
      regenerate: "medium",
      escalate: "high",
      block: "critical",
      verification: "medium",
    },
    escalationRules: {
      alwaysEscalateCategories: [],
      // Security still blocks: an internal audience is not a safe audience
      // for credentials or exploit material.
      alwaysBlockCategories: ["SECURITY"],
      humanApprovalAboveUsd: 5000,
      escalateAtSessionRisk: "HIGH",
    },
    allowedActions: ["read_account", "send_email", "issue_refund", "approve_payment"],
    blockedActions: ["wire_transfer"],
    jurisdiction: ["IN"],
    responsibilityThreshold: "PROHIBITED",
    performanceThreshold: "CONTRADICTED",
    costThresholdUsd: 0.50,
    intersectionAware: true,
  },

  DECISION_SUPPORT: {
    id: "DECISION_SUPPORT",
    workflow: {
      summary:
        "Retrieve evidence, verify every claim against it, treat unresolved or "
        + "conflicting evidence as disqualifying, apply a second stricter policy "
        + "pass, and route any consequential action to a person. Being wrong "
        + "here costs more than being slow.",
      stages: [
        "DETECT", "RETRIEVE_EVIDENCE", "VERIFY", "UNCERTAINTY_CHECK",
        "STRICT_POLICY", "HUMAN_APPROVAL", "CITE", "DECIDE",
      ],
      retrieval: "FORCED",
      requireCitations: true,
      alwaysHumanForActions: true,
      boundedVerification: false,
      // The distinguishing choice: "we could not establish this" is a reason
      // to stop, not a caveat to attach.
      treatUncertaintyAsBlocking: true,
    },
    name: "Decision Support",
    description:
      "Output informs a consequential decision, so being wrong costs more than being slow. Verification is deep by default, uncertainty is held rather than annotated, and no money moves without a person.",
    riskTolerance: "low",
    baseVerificationDepth: "deep",
    // Correctness outranks speed here, and the budget says so.
    latencySLOms: 12_000,
    thresholds: {
      annotate: "low",
      // An unsupported claim is regenerated at the first sign of trouble.
      regenerate: "low",
      escalate: "medium",
      block: "high",
      verification: "low",
    },
    escalationRules: {
      alwaysEscalateCategories: ["HIGH_CONSEQUENCE_ACTION", "POLICY_VIOLATION", "SAFETY"],
      alwaysBlockCategories: ["PRIVACY", "SENSITIVE_DATA", "SECURITY"],
      // Any material sum needs a human.
      humanApprovalAboveUsd: 1,
      escalateAtSessionRisk: "MEDIUM",
    },
    allowedActions: ["read_account"],
    blockedActions: ["wire_transfer", "approve_payment", "issue_refund", "send_email"],
    jurisdiction: ["EU", "US"],
    responsibilityThreshold: "RESTRICTED",
    // An unverifiable claim is not good enough to decide on.
    performanceThreshold: "UNCERTAIN",
    costThresholdUsd: 2.00,
    intersectionAware: true,
  },
};

export const DEFAULT_PROFILE_ID = "BASELINE";

/**
 * The governance policy for a request.
 *
 * Resolved from configuration, never from the chat UI. An unrecognised or
 * absent id falls back to the baseline rather than failing, so a
 * misconfigured deployment still governs its traffic.
 */
export function getProfile(id?: string | null): UseCaseProfile {
  const requested = id ?? process.env.GOVERNANCE_PROFILE ?? DEFAULT_PROFILE_ID;
  return USE_CASE_PROFILES[requested] ?? USE_CASE_PROFILES[DEFAULT_PROFILE_ID];
}

export function listProfiles(): UseCaseProfile[] {
  return Object.values(USE_CASE_PROFILES);
}

/** Ordered intervention ladder, shared by the decision engine. */
export const INTERVENTIONS: Decision[] = [
  "ALLOW", "ANNOTATE", "REGENERATE", "HOLD", "BLOCK",
];

export function raise(decision: Decision, levels: number): Decision {
  const i = INTERVENTIONS.indexOf(decision);
  return INTERVENTIONS[Math.min(INTERVENTIONS.length - 1, i + levels)];
}

export function strictest(a: Decision, b: Decision): Decision {
  return INTERVENTIONS.indexOf(a) >= INTERVENTIONS.indexOf(b) ? a : b;
}

/** The intervention a profile prescribes for a given severity. */
export function interventionFor(profile: UseCaseProfile, severity: Severity): Decision {
  const rank = SEVERITY_RANK[severity];
  const t = profile.thresholds;
  if (rank >= SEVERITY_RANK[t.block]) return "BLOCK";
  if (rank >= SEVERITY_RANK[t.escalate]) return "HOLD";
  if (rank >= SEVERITY_RANK[t.regenerate]) return "REGENERATE";
  if (rank >= SEVERITY_RANK[t.annotate]) return "ANNOTATE";
  return "ALLOW";
}
