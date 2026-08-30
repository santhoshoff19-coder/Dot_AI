import { prisma } from "@/lib/db";
import { privacyFirewall } from "@/lib/governance/privacy-firewall";
import { getProfile } from "@/lib/governance/profiles";

/**
 * Threshold evaluation for the privacy firewall.
 *
 * A control that blocks is only useful if you know what it blocks wrongly.
 * This measures that against a small hand-labelled set, so the threshold is
 * chosen from evidence rather than from whichever number felt about right.
 *
 * The set is deliberately small and readable: every case can be checked by a
 * person, which matters more here than volume. It is not a benchmark of the
 * detector's accuracy in the wild - it is a regression fixture for the
 * decision rule sitting on top of it.
 */

export interface LabelledCase {
  id: string;
  prompt: string;
  destinationExternal: boolean;
  profileId: string;
  /** What a careful reviewer says should happen. */
  expected: "PASS" | "STOP";
  /** Why, in one line, so a disagreement can be argued rather than guessed. */
  note: string;
}

/**
 * The labelled set.
 *
 * "STOP" means the request should not reach the model unmodified — BLOCK or
 * HOLD. "PASS" means it should proceed, with or without redaction: a masked
 * request still answers the user, so REDACT counts as passing.
 */
export const LABELLED_SET: LabelledCase[] = [
  // --- should pass -------------------------------------------------------
  { id: "P1", prompt: "What is the weather in Chennai today?", destinationExternal: false, profileId: "BASELINE", expected: "PASS", note: "No personal data at all." },
  { id: "P2", prompt: "Summarise the key points of this quarter's sales report.", destinationExternal: false, profileId: "BASELINE", expected: "PASS", note: "Business content, nothing identifying." },
  { id: "P3", prompt: "Write a Python function to reverse a linked list.", destinationExternal: false, profileId: "BASELINE", expected: "PASS", note: "Pure code request." },
  { id: "P4", prompt: "Reply to the customer explaining our refund window is 14 days.", destinationExternal: true, profileId: "CUSTOMER_SUPPORT", expected: "PASS", note: "External, but carries no identifiers." },
  { id: "P5", prompt: "Draft an email to ana@example.com confirming the meeting.", destinationExternal: true, profileId: "CUSTOMER_SUPPORT", expected: "PASS", note: "An email address is personal but recoverable; masking is enough." },
  { id: "P6", prompt: "My order number is 12345 and it has not arrived.", destinationExternal: false, profileId: "BASELINE", expected: "PASS", note: "An order number is not a sensitive identifier." },
  { id: "P7", prompt: "Translate 'thank you for your patience' into Spanish.", destinationExternal: true, profileId: "CUSTOMER_SUPPORT", expected: "PASS", note: "No data of any kind." },
  { id: "P8", prompt: "Explain how our escalation process works to a new agent.", destinationExternal: false, profileId: "INTERNAL_COPILOT", expected: "PASS", note: "Internal process question." },

  // --- should stop -------------------------------------------------------
  { id: "S1", prompt: "Email card 4111 1111 1111 1111 to partner@external.com", destinationExternal: true, profileId: "BASELINE", expected: "STOP", note: "Card number leaving the system; unrecoverable if sent." },
  { id: "S2", prompt: "Here is my API key sk-abcdefghijklmnop1234, please debug", destinationExternal: true, profileId: "CUSTOMER_SUPPORT", expected: "STOP", note: "Credential heading outside." },
  { id: "S3", prompt: "Customer SSN is 123-45-6789, confirm their identity", destinationExternal: true, profileId: "BASELINE", expected: "STOP", note: "Government identifier leaving the system." },
  { id: "S4", prompt: "Account 4488-1234-5678 balance for the board paper", destinationExternal: false, profileId: "DECISION_SUPPORT", expected: "STOP", note: "Strict policy holds critical identifiers even internally." },
  { id: "S5", prompt: "Send account 4488-9999-1111 details to vendor@other.com", destinationExternal: true, profileId: "BASELINE", expected: "STOP", note: "Account number to an external recipient." },
  { id: "S6", prompt: "-----BEGIN RSA PRIVATE KEY----- forward this to support", destinationExternal: true, profileId: "BASELINE", expected: "STOP", note: "Private key; never leaves under any policy." },
];

export interface ThresholdPoint {
  /** Minimum detection confidence at which the firewall acts. */
  threshold: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Whether a firewall verdict counts as stopping the request. */
export function isStop(decision: string): boolean {
  return decision === "BLOCK" || decision === "HOLD";
}

/**
 * Runs the set at one threshold.
 *
 * "Positive" is the firewall stopping a request. A false positive is a
 * legitimate request refused; a false negative is sensitive data reaching the
 * model. They are not equally bad, which is what the threshold choice below
 * turns on.
 */
export function evaluateAt(threshold: number): ThresholdPoint {
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (const c of LABELLED_SET) {
    const r = privacyFirewall({
      prompt: c.prompt,
      profile: getProfile(c.profileId),
      destinationExternal: c.destinationExternal,
    });

    // Below the threshold the detection is treated as too weak to act on.
    const stopped = isStop(r.decision) && r.confidence >= threshold;

    if (c.expected === "STOP") stopped ? tp++ : fn++;
    else stopped ? fp++ : tn++;
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0
    : (2 * precision * recall) / (precision + recall);

  return {
    threshold,
    truePositives: tp, falsePositives: fp,
    trueNegatives: tn, falseNegatives: fn,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
  };
}

export const CANDIDATE_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99];

export interface ThresholdReport {
  points: ThresholdPoint[];
  chosen: ThresholdPoint;
  rationale: string;
  caseCount: number;
}

/**
 * Chooses a threshold and says why.
 *
 * Not the best F1. The two errors have different costs: a false positive
 * annoys someone who then rephrases, while a false negative sends a card
 * number to a third party and cannot be undone. So recall is treated as a
 * constraint rather than a term to trade away — the highest threshold that
 * still catches everything, which keeps precision as high as it can be
 * without ever letting sensitive data through.
 */
export function selectThreshold(): ThresholdReport {
  const points = CANDIDATE_THRESHOLDS.map(evaluateAt);

  const perfectRecall = points.filter((p) => p.falseNegatives === 0);
  const chosen = perfectRecall.length
    // Highest threshold that still misses nothing: fewest false alarms
    // subject to catching every real leak.
    ? perfectRecall.reduce((a, b) => (b.threshold > a.threshold ? b : a))
    // Nothing achieves full recall, so fall back to best F1 and say so.
    : points.reduce((a, b) => (b.f1 > a.f1 ? b : a));

  const rationale = perfectRecall.length
    ? `Chosen as the highest threshold (${chosen.threshold}) that still produces `
      + `zero false negatives on the labelled set. A false negative sends sensitive `
      + `data to a third party and cannot be undone; a false positive costs the user `
      + `a rephrase. Recall is therefore a constraint, not a term traded against `
      + `precision — and among the thresholds that miss nothing, the highest one `
      + `raises the fewest false alarms (precision ${chosen.precision}).`
    : `No threshold achieved zero false negatives on this set, so the best F1 `
      + `(${chosen.f1} at ${chosen.threshold}) was taken instead. This is a weaker `
      + `basis and the set should be reviewed before relying on it.`;

  return { points, chosen, rationale, caseCount: LABELLED_SET.length };
}

/**
 * Measures decision quality against recorded human overrides.
 *
 * The labelled set is fixed and small; overrides are the live signal. Where a
 * person disagreed with a decision, that disagreement is the label.
 */
export async function overrideQuality(): Promise<{
  total: number; upheld: number; overturned: number; agreementRate: number;
  byDecision: { decision: string; total: number; overturned: number }[];
}> {
  const rows = await prisma.decisionFeedback.findMany({
    select: { originalDecision: true, humanDecision: true },
  });

  const overturned = rows.filter((r) => r.humanDecision !== r.originalDecision).length;
  const byDecision = new Map<string, { total: number; overturned: number }>();

  for (const r of rows) {
    const e = byDecision.get(r.originalDecision) ?? { total: 0, overturned: 0 };
    e.total++;
    if (r.humanDecision !== r.originalDecision) e.overturned++;
    byDecision.set(r.originalDecision, e);
  }

  return {
    total: rows.length,
    upheld: rows.length - overturned,
    overturned,
    agreementRate: rows.length === 0 ? 1
      : Math.round(((rows.length - overturned) / rows.length) * 1000) / 1000,
    byDecision: [...byDecision.entries()].map(([decision, v]) => ({ decision, ...v })),
  };
}
