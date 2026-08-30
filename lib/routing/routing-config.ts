/**
 * Routing configuration.
 *
 * Thresholds are deliberately configurable rather than hardcoded truths -
 * they are prototype defaults meant to be tuned against real traffic.
 */
export interface RoutingConfig {
  /** Minimum Fast Router confidence to route directly for an ordinary task. */
  FAST_ROUTE_MIN_CONFIDENCE: number;
  /**
   * Confidence required to route a *high-risk* task directly. Higher than the
   * ordinary bar: being wrong about a payment costs more than being wrong
   * about a summary.
   */
  HIGH_RISK_DIRECT_CONFIDENCE: number;
  /** At or below this, always escalate to CAI. */
  CAI_TRIGGER_CONFIDENCE: number;
  /** Model used by CAI itself. Must be cheap - it never writes the answer. */
  CAI_MODEL: string;
  /** Cap on what CAI may spend understanding a single request. */
  CAI_MAX_COST_USD: number;
  /** Minimum observed runs before learned reliability influences scoring. */
  RELIABILITY_MIN_SAMPLE: number;
  /** Auto mode selects the recommendable model without asking. */
  AUTO_MODE_DEFAULT: boolean;
}

export const routingConfig: RoutingConfig = {
  FAST_ROUTE_MIN_CONFIDENCE: Number(process.env.FAST_ROUTE_MIN_CONFIDENCE ?? 0.88),
  HIGH_RISK_DIRECT_CONFIDENCE: Number(process.env.HIGH_RISK_DIRECT_CONFIDENCE ?? 0.9),
  CAI_TRIGGER_CONFIDENCE: Number(process.env.CAI_TRIGGER_CONFIDENCE ?? 0.75),
  CAI_MODEL: process.env.CAI_MODEL ?? "google/gemini-2.5-flash-lite",
  CAI_MAX_COST_USD: Number(process.env.CAI_MAX_COST_USD ?? 0.002),
  RELIABILITY_MIN_SAMPLE: Number(process.env.RELIABILITY_MIN_SAMPLE ?? 5),
  AUTO_MODE_DEFAULT: (process.env.AUTO_MODE_DEFAULT ?? "true") !== "false",
};

/**
 * Minimum capability floor for obvious high-risk work. A user cost preference
 * can never lower these - mandatory controls are not negotiable.
 */
export const HIGH_RISK_POLICY = {
  minRelativeCapability: 0.85,
  minExpectedSuccess: 0.9,
  effort: "high" as const,
  verificationDepth: "deep" as const,
};
