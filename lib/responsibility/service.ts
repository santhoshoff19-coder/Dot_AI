import type { RiskCategory } from "@/lib/governance/profiles";
import type {
  ResponsibilityCategory, ResponsibilityFinding, ResponsibilityResult,
  ResponsibilityStatus,
} from "@/types";

export interface Destination { channel: string; external: boolean; address?: string }
export interface Actor { role: string; permissions: string[] }

const PII_PATTERNS: { cls: string; re: RegExp; severity: ResponsibilityFinding["severity"] }[] = [
  { cls: "private_key", re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g, severity: "critical" },
  { cls: "api_key", re: /\b(?:sk|pk|api|key)[-_][A-Za-z0-9]{16,}\b/g, severity: "critical" },
  { cls: "government_id", re: /\b\d{3}-\d{2}-\d{4}\b/g, severity: "critical" },
  { cls: "account_number", re: /\b\d{4}[-\s]\d{4}[-\s]\d{4}\b/g, severity: "critical" },
  { cls: "credit_card", re: /\b(?:\d[ -]?){13,16}\b/g, severity: "critical" },
  { cls: "email", re: /\b[\w.\-+]+@[\w-]+\.[A-Za-z]{2,}\b/g, severity: "low" },
];

/** Which PII classes may leave the system, and to where. */
const PRIVACY_POLICY: Record<string, { internal: boolean; external: boolean }> = {
  private_key: { internal: false, external: false },
  api_key: { internal: false, external: false },
  government_id: { internal: false, external: false },
  account_number: { internal: true, external: false },
  credit_card: { internal: false, external: false },
  email: { internal: true, external: true },
};

const INTERNAL_ROLES = ["support_agent", "admin", "analyst"];

const INJECTION = [
  /ignore (?:all |any )?(?:previous|prior|above) instructions/i,
  /disregard (?:the )?(?:system|previous) (?:prompt|instructions)/i,
  /reveal (?:your |the )?(?:system prompt|instructions)/i,
  /(?:disable|bypass|skip) (?:the )?(?:safety|guardrail|control|audit)/i,
];

const UNSAFE = [/synthesis route for/i, /bypass the authentication/i, /disable the audit log/i];

const STEREOTYPE =
  /\b(?:women|men|males?|females?|elderly|older|younger|immigrants?)\b[^.?!]{0,60}\b(?:generally|typically|usually|tend to|are less|are more|always|never|struggle|cannot)\b/i;

const HIGH_IMPACT = ["hiring", "lending", "insurance", "housing", "admissions"];

export interface PIIHit { cls: string; value: string; index: number }

export function scanPII(text: string): PIIHit[] {
  const hits: PIIHit[] = [];
  const claimed: [number, number][] = [];

  for (const { cls, re } of PII_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (claimed.some(([s, e]) => start < e && s < end)) continue;
      claimed.push([start, end]);
      hits.push({ cls, value: m[0], index: start });
    }
  }
  return hits;
}

export function redact(text: string, classes: string[]): string {
  let out = text;
  const hits = scanPII(out).filter((h) => classes.includes(h.cls));
  for (const h of [...hits].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, h.index) + `[REDACTED:${h.cls.toUpperCase()}]` + out.slice(h.index + h.value.length);
  }
  return out;
}

export class ResponsibilityService {
  /**
   * Detection is separate from decision: this reports what was found and where
   * it is going. The same account number is permitted internally and a breach
   * externally.
   */
  check(
    answer: string,
    opts: { destination: Destination; actor: Actor; context?: string },
  ): ResponsibilityResult {
    const findings: ResponsibilityFinding[] = [];
    const checksRun = ["privacy", "safety", "security", "fairness", "policy"];
    const categories: Record<ResponsibilityCategory, "clear" | "flagged" | "not_run"> = {
      privacy: "clear", safety: "clear", fairness: "clear", policy: "clear", security: "clear",
    };

    const external = opts.destination.external;
    const roleInternal = INTERNAL_ROLES.includes(opts.actor.role);

    // --- privacy -----------------------------------------------------------
    for (const hit of scanPII(answer)) {
      const rule = PRIVACY_POLICY[hit.cls];
      if (!rule) {
        findings.push({
          category: "privacy",
          categories: ["PRIVACY", "SENSITIVE_DATA"],
          severity: "medium", deterministic: true, confidence: 0.6,
          source: "dlp_scanner",
          message: `Unclassified identifier '${hit.cls}' present in the response.`,
          explanation: "An identifier was detected that no policy classifies yet.",
        });
        categories.privacy = "flagged";
        continue;
      }
      const allowed = external ? rule.external : rule.internal && roleInternal;
      if (allowed) continue;

      // One detection, several true labels. Personal data leaving the
      // organisation is a privacy issue, a sensitive-data issue and a policy
      // breach simultaneously - the decision engine reasons over all three.
      const labels: RiskCategory[] = ["PRIVACY", "SENSITIVE_DATA"];
      if (external) labels.push("POLICY_VIOLATION");

      findings.push({
        category: "privacy",
        categories: labels,
        severity: hit.cls === "email" ? "medium" : "critical",
        deterministic: true,
        confidence: 0.98,
        source: "dlp_scanner",
        message: `${hit.cls.replace(/_/g, " ")} would be disclosed to ${
          external ? "an external recipient" : "an unauthorised internal role"}.`,
        explanation:
          "Personal or account identifiers were detected in the response and the " +
          "destination is not permitted to receive them.",
        evidence: hit.value.slice(0, 40),
        location: { start: hit.index, end: hit.index + hit.value.length },
        redactClass: hit.cls,
      });
      categories.privacy = "flagged";
    }

    // --- safety ------------------------------------------------------------
    for (const re of UNSAFE) {
      if (re.test(answer)) {
        findings.push({
          category: "safety",
          categories: ["SAFETY", "POLICY_VIOLATION"],
          severity: "critical", deterministic: true, confidence: 1,
          source: "safety_rules",
          message: "Response matches a prohibited-content rule.",
          explanation: "The output matched an explicit prohibited-content policy rule.",
        });
        categories.safety = "flagged";
      }
    }

    // --- security ----------------------------------------------------------
    for (const re of INJECTION) {
      if (re.test(answer)) {
        findings.push({
          category: "security",
          categories: ["SECURITY", "POLICY_VIOLATION"],
          severity: "critical", deterministic: true, confidence: 0.95,
          source: "injection_detector",
          message: "Instruction-override attempt detected in the model output.",
          explanation: "The output contains text attempting to override system instructions.",
        });
        categories.security = "flagged";
      }
    }

    // --- fairness ----------------------------------------------------------
    const context = (opts.context ?? "").toLowerCase();
    const highImpact = HIGH_IMPACT.some((c) => context.includes(c));
    if (STEREOTYPE.test(answer)) {
      findings.push({
        category: "fairness",
        categories: highImpact ? ["FAIRNESS", "POLICY_VIOLATION"] : ["FAIRNESS"],
        severity: highImpact ? "critical" : "high",
        deterministic: false,
        confidence: 0.85,
        source: "fairness_detector",
        message: "Generalisation about a protected group used as a reason.",
        explanation:
          "A statement about a protected group was used to justify an outcome, " +
          "which is a fairness risk in a high-impact context.",
      });
      categories.fairness = "flagged";
    }

    // --- policy ------------------------------------------------------------
    if (external && findings.some((f) => f.category === "privacy")) {
      findings.push({
        category: "policy",
        categories: ["POLICY_VIOLATION", "PRIVACY"],
        severity: "critical", deterministic: true, confidence: 1,
        source: "policy_engine",
        message: "Data handling policy prohibits sending customer identifiers externally.",
        explanation: "An explicit data-handling rule forbids this destination.",
      });
      categories.policy = "flagged";
    }

    const worst = findings.reduce((acc, f) => Math.max(acc, rank(f.severity)), 0);
    const status: ResponsibilityStatus =
      worst >= 4 ? "PROHIBITED" : worst >= 2 ? "RESTRICTED" : "PERMITTED";

    return { status, findings, checksRun, categories };
  }
}

function rank(s: ResponsibilityFinding["severity"]): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[s];
}

export const responsibilityService = new ResponsibilityService();
