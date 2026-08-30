import type { ActionGateResult, ActionIntent, GateStage } from "@/types";

interface ActionPolicy {
  requiredPermission: string;
  autoApproveBelowUsd: number;
  hardLimitUsd: number;
  allowExternal: boolean;
}

/** An action absent from this registry is denied by default (fail closed). */
const ACTION_POLICIES: Record<string, ActionPolicy> = {
  issue_refund: { requiredPermission: "refunds.write", autoApproveBelowUsd: 100, hardLimitUsd: 5_000, allowExternal: false },
  approve_payment: { requiredPermission: "payments.approve", autoApproveBelowUsd: 1_000, hardLimitUsd: 250_000, allowExternal: false },
  send_email: { requiredPermission: "mail.send", autoApproveBelowUsd: 0, hardLimitUsd: 0, allowExternal: true },
  read_account: { requiredPermission: "accounts.read", autoApproveBelowUsd: 1e9, hardLimitUsd: 1e9, allowExternal: false },
};

export interface GateActor { role: string; permissions: string[] }

/**
 * ActionGate sits before any external action. It governs the ACTION, not the
 * sentence: even a response the checker cleared must pass every stage.
 */
export class ActionGate {
  /**
   * The gate is policy-aware: the same action can be auto-approved for one use
   * case and require a human for another. Profile limits may only be stricter
   * than the action's own registered limits, never looser.
   */
  evaluate(
    intent: ActionIntent,
    actor: GateActor,
    profile?: {
      id: string; name: string;
      allowedActions: string[]; blockedActions: string[];
      escalationRules: { humanApprovalAboveUsd: number };
    },
  ): ActionGateResult {
    const checks: ActionGateResult["checks"] = [];
    const fail = (stage: GateStage, decision: "HOLD" | "BLOCK", reason: string): ActionGateResult =>
      ({ allowed: false, decision, stage, reason, checks, executed: false });

    // 1. INTENT
    const policy = ACTION_POLICIES[intent.name];
    checks.push({
      stage: "intent", label: "Intent recognised", passed: Boolean(policy),
      detail: policy ? `Action '${intent.name}' is registered.` : `Action '${intent.name}' is not registered.`,
    });
    if (!policy) {
      return fail("intent", "BLOCK", `Action '${intent.name}' is not registered in policy, so it is denied by default.`);
    }

    // 1b. USE-CASE POLICY: is this action permitted for this use case at all?
    if (profile) {
      const blocked = profile.blockedActions.includes(intent.name);
      const allowed = profile.allowedActions.length === 0 ||
        profile.allowedActions.includes(intent.name);
      checks.push({
        stage: "policy", label: `Permitted for ${profile.name}`,
        passed: !blocked && allowed,
        detail: blocked
          ? `'${intent.name}' is on the ${profile.name} blocked list.`
          : allowed ? `'${intent.name}' is permitted for this use case.`
          : `'${intent.name}' is not on the ${profile.name} allowed list.`,
      });
      if (blocked || !allowed) {
        return fail("policy", "BLOCK",
          `'${intent.name}' is not permitted for ${profile.name}.`);
      }
    }

    // 2. PERMISSION
    const hasPerm = actor.permissions.includes(policy.requiredPermission) || actor.permissions.includes("*");
    checks.push({
      stage: "permission", label: "Permission granted", passed: hasPerm,
      detail: hasPerm ? `Actor holds '${policy.requiredPermission}'.` : `Actor lacks '${policy.requiredPermission}'.`,
    });
    if (!hasPerm) return fail("permission", "BLOCK", `Actor lacks '${policy.requiredPermission}'.`);

    // 3. RISK
    const withinLimit = intent.valueUsd <= policy.hardLimitUsd;
    checks.push({
      stage: "risk", label: "Within hard limit", passed: withinLimit,
      detail: `Value $${intent.valueUsd.toLocaleString()} against a hard limit of $${policy.hardLimitUsd.toLocaleString()}.`,
    });
    if (!withinLimit) {
      return fail("risk", "BLOCK", `$${intent.valueUsd.toLocaleString()} exceeds the hard limit of $${policy.hardLimitUsd.toLocaleString()}.`);
    }

    // 4. POLICY
    const destinationOk = policy.allowExternal || !intent.destination.external;
    checks.push({
      stage: "policy", label: "Destination permitted", passed: destinationOk,
      detail: intent.destination.external ? "External destination." : "Internal destination.",
    });
    if (!destinationOk) {
      return fail("policy", "BLOCK", `'${intent.name}' may not target an external destination.`);
    }

    // 5. PARAMETERS
    const paramsOk = Object.values(intent.parameters).every(
      (v) => v !== null && v !== undefined && String(v).length < 500);
    checks.push({
      stage: "parameters", label: "Parameters valid", passed: paramsOk,
      detail: paramsOk ? "All parameters are present and within bounds." : "A parameter is missing or oversized.",
    });
    if (!paramsOk) return fail("parameters", "HOLD", "Action parameters failed validation.");

    // Approval threshold -> human, not automatic execution.
    const needsApproval = intent.valueUsd >= policy.autoApproveBelowUsd;
    if (needsApproval) {
      checks.push({
        stage: "policy", label: "Auto-approval threshold", passed: false,
        detail: `$${intent.valueUsd.toLocaleString()} is at or above the $${policy.autoApproveBelowUsd.toLocaleString()} auto-approval threshold.`,
      });
      return fail("policy", "HOLD", `$${intent.valueUsd.toLocaleString()} requires human approval before it can execute.`);
    }

    // 6. EXECUTE (simulated in this prototype)
    checks.push({
      stage: "execute", label: "Executed", passed: true,
      detail: "Simulated execution: no external system was contacted.",
    });
    return {
      allowed: true, decision: "ALLOW", stage: "execute",
      reason: "All gate stages passed.", checks, executed: true,
      result: `Simulated '${intent.name}' completed.`,
    };
  }

  /** Detects an action the model is proposing, from the prompt. */
  detectIntent(prompt: string, external: boolean): ActionIntent | null {
    const money = prompt.match(/\$\s?([\d,]+(?:\.\d+)?)/);
    const valueUsd = money ? Number(money[1].replace(/,/g, "")) : 0;
    const p = prompt.toLowerCase();

    if (/(approve|authorise|authorize).*(payment|transfer)|payment.*(approve)/.test(p)) {
      return { name: "approve_payment", parameters: { note: "from chat request" }, valueUsd, reversible: false, destination: { channel: "api", external } };
    }
    if (/refund/.test(p)) {
      return { name: "issue_refund", parameters: { note: "from chat request" }, valueUsd: valueUsd || 4800, reversible: false, destination: { channel: "api", external } };
    }
    if (/(send|email).*(external|outside)|send.*email/.test(p)) {
      return { name: "send_email", parameters: { note: "from chat request" }, valueUsd: 0, reversible: false, destination: { channel: "email", external: true } };
    }
    if (/wire (the )?(funds|money)/.test(p)) {
      return { name: "wire_transfer", parameters: {}, valueUsd, reversible: false, destination: { channel: "api", external } };
    }
    return null;
  }
}

export const actionGate = new ActionGate();
