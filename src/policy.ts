/**
 * policy.ts — the agent's decision engine.
 *
 * Adapted from the LogiGuard wallet-guard policy model (see
 * ~/workspace/agentgames/guard/server.js): every proposed action is checked
 * against an allowlist + caps and returns a verdict with a reason, instead of
 * a bare boolean. The difference here is that the caps are ALSO enforced
 * on-chain — by the EVM authorisation window (tx count, value, duration,
 * targets) and by the abstract-account spending rules (per-tx + daily caps).
 * This engine is the agent's local mirror of those on-chain rules: it refuses
 * locally before anything is signed, so a refused payment never costs a fee.
 *
 * Pure functions only — no network, no keys — so the whole engine is unit
 * tested without a chain.
 */

export type Verdict = "ALLOW" | "REFUSE";

export type ReasonCode =
  | "OK"
  | "NOT_ALLOWLISTED" // recipient is not in the schedule/allowlist
  | "AMOUNT_ZERO" // amount is zero or negative
  | "OVER_PER_TX_CAP" // amount exceeds the per-transaction cap
  | "OVER_DAILY_CAP" // amount would exceed the daily cap
  | "AUTHENTICATOR_EXPIRED" // the agent's linked key has passed its expiry
  | "NO_WINDOW" // no EVM window is stored for the agent account
  | "WINDOW_NOT_LIVE" // a window is stored but expired/exhausted
  | "WINDOW_TXS_EXHAUSTED" // the window has no transactions left
  | "WINDOW_VALUE_EXHAUSTED" // the window cannot cover value + max fee
  | "WINDOW_BLOCKS_EXHAUSTED" // the window has no blocks left
  | "WINDOW_TARGET_NOT_LISTED" // the recipient is not in the window's allowed_targets
  | "INSUFFICIENT_FLOAT"; // the agent's float balance cannot cover the payment

export interface WindowSnapshot {
  found: boolean;
  live: boolean;
  remainingBlocks: bigint;
  remainingTxs: bigint;
  /** uqor left in the window (value + max fees). */
  remainingValue: bigint;
  /** Empty = unscoped (any target admitted). */
  allowedTargets: string[];
  openedHeight: bigint;
  expiryHeight: bigint;
}

export interface PolicyInput {
  /** The payment being decided. `to` must be a lowercase 0x address. */
  payment: { id: string; to: string; amountUqor: bigint };
  /** Allowlisted recipient addresses (lowercase 0x). From schedule.json. */
  allowlist: ReadonlySet<string>;
  /** On-chain spending-rule caps (uqor). */
  perTxCapUqor: bigint;
  dailyCapUqor: bigint;
  /** uqor already spent by the agent this UTC day (tracked in state.json). */
  spentTodayUqor: bigint;
  /** Unix seconds when the agent's authenticator link expires (0 = unknown). */
  authenticatorExpiryUnix: number;
  nowUnix: number;
  /** The agent account's live window, or null when there is none. */
  window: WindowSnapshot | null;
  /** Worst-case fee the chain charges this payment against the window (uqor). */
  maxFeePerTxUqor: bigint;
  /**
   * When false, skip the window checks (treasury-direct mode: MsgExecuteEVM
   * is a native-lane message the window does not govern — the on-chain
   * spending rules bound it instead). Default true.
   */
  requireWindow?: boolean;
  /** The agent float's balance (uqor), or null when not applicable. */
  floatBalanceUqor?: bigint | null;
}

export interface PolicyDecision {
  verdict: Verdict;
  reasonCode: ReasonCode;
  /** Human-readable reason, logged with the decision. */
  reason: string;
  /** The limits that were in force for this decision (logged). */
  limits: {
    perTxCapUqor: string;
    dailyCapUqor: string;
    spentTodayUqor: string;
    windowRemainingTxs: string | null;
    windowRemainingValueUqor: string | null;
    windowRemainingBlocks: string | null;
  };
}

function limitsOf(input: PolicyInput): PolicyDecision["limits"] {
  return {
    perTxCapUqor: input.perTxCapUqor.toString(),
    dailyCapUqor: input.dailyCapUqor.toString(),
    spentTodayUqor: input.spentTodayUqor.toString(),
    windowRemainingTxs: input.window ? input.window.remainingTxs.toString() : null,
    windowRemainingValueUqor: input.window ? input.window.remainingValue.toString() : null,
    windowRemainingBlocks: input.window ? input.window.remainingBlocks.toString() : null,
  };
}

function refuse(input: PolicyInput, code: ReasonCode, reason: string): PolicyDecision {
  return { verdict: "REFUSE", reasonCode: code, reason, limits: limitsOf(input) };
}

/**
 * Decide one payment. Checks run fail-closed, cheapest first:
 * allowlist -> amount -> caps -> authenticator expiry -> window.
 */
export function evaluatePayment(input: PolicyInput): PolicyDecision {
  const { payment } = input;

  if (!input.allowlist.has(payment.to.toLowerCase())) {
    return refuse(input, "NOT_ALLOWLISTED", `recipient ${payment.to} is not in the allowlist`);
  }
  if (payment.amountUqor <= 0n) {
    return refuse(input, "AMOUNT_ZERO", `amount must be positive, got ${payment.amountUqor}`);
  }
  if (payment.amountUqor > input.perTxCapUqor) {
    return refuse(
      input,
      "OVER_PER_TX_CAP",
      `amount ${payment.amountUqor} uqor exceeds per-tx cap ${input.perTxCapUqor} uqor`,
    );
  }
  if (input.spentTodayUqor + payment.amountUqor > input.dailyCapUqor) {
    return refuse(
      input,
      "OVER_DAILY_CAP",
      `spent today ${input.spentTodayUqor} + ${payment.amountUqor} would exceed daily cap ${input.dailyCapUqor} uqor`,
    );
  }
  if (input.authenticatorExpiryUnix > 0 && input.nowUnix >= input.authenticatorExpiryUnix) {
    return refuse(
      input,
      "AUTHENTICATOR_EXPIRED",
      `agent authenticator expired at unix ${input.authenticatorExpiryUnix}`,
    );
  }

  if (
    input.floatBalanceUqor !== null &&
    input.floatBalanceUqor !== undefined &&
    payment.amountUqor > input.floatBalanceUqor
  ) {
    return refuse(
      input,
      "INSUFFICIENT_FLOAT",
      `float balance ${input.floatBalanceUqor} uqor cannot cover ${payment.amountUqor} uqor`,
    );
  }
  if (input.requireWindow === false) {
    return {
      verdict: "ALLOW",
      reasonCode: "OK",
      reason: `within allowlist, per-tx cap ${input.perTxCapUqor}, daily cap ${input.dailyCapUqor} (treasury-direct: window does not govern MsgExecuteEVM; spending rules bind on-chain)`,
      limits: limitsOf(input),
    };
  }

  const w = input.window;
  if (!w || !w.found) {
    return refuse(input, "NO_WINDOW", "no EVM authorisation window is open for the agent account");
  }
  if (!w.live) {
    return refuse(input, "WINDOW_NOT_LIVE", "the stored EVM window is expired or exhausted");
  }
  if (w.remainingBlocks <= 0n) {
    return refuse(input, "WINDOW_BLOCKS_EXHAUSTED", "the EVM window has no blocks left");
  }
  if (w.remainingTxs <= 0n) {
    return refuse(input, "WINDOW_TXS_EXHAUSTED", "the EVM window has no transactions left");
  }
  if (w.allowedTargets.length > 0) {
    const listed = w.allowedTargets.some((t) => t.toLowerCase() === payment.to.toLowerCase());
    if (!listed) {
      return refuse(
        input,
        "WINDOW_TARGET_NOT_LISTED",
        `recipient ${payment.to} is not in the window's allowed_targets`,
      );
    }
  }
  // The chain charges value + max fee against the window, value rounded up.
  const charge = payment.amountUqor + input.maxFeePerTxUqor;
  if (charge > w.remainingValue) {
    return refuse(
      input,
      "WINDOW_VALUE_EXHAUSTED",
      `payment ${payment.amountUqor} + max fee ${input.maxFeePerTxUqor} = ${charge} uqor exceeds window remaining value ${w.remainingValue} uqor`,
    );
  }

  return {
    verdict: "ALLOW",
    reasonCode: "OK",
    reason: `within allowlist, per-tx cap ${input.perTxCapUqor}, daily cap ${input.dailyCapUqor}, window ${w.remainingTxs} txs / ${w.remainingValue} uqor / ${w.remainingBlocks} blocks left`,
    limits: limitsOf(input),
  };
}

/** UTC calendar day key (YYYY-MM-DD) for the daily-cap accounting. */
export function utcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
