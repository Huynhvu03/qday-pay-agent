import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePayment, utcDayKey, type PolicyInput } from "../src/policy.ts";

function base(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    payment: { id: "alice", to: "0x1111111111111111111111111111111111111111", amountUqor: 100_000n },
    allowlist: new Set(["0x1111111111111111111111111111111111111111"]),
    perTxCapUqor: 500_000n,
    dailyCapUqor: 1_000_000n,
    spentTodayUqor: 0n,
    authenticatorExpiryUnix: 0,
    nowUnix: 1_700_000_000,
    window: {
      found: true,
      live: true,
      remainingBlocks: 500n,
      remainingTxs: 5n,
      remainingValue: 3_750_000n,
      allowedTargets: ["0x1111111111111111111111111111111111111111"],
      openedHeight: 100n,
      expiryHeight: 700n,
    },
    maxFeePerTxUqor: 25_000n,
    ...over,
  };
}

test("ALLOW: payment inside every limit", () => {
  const d = evaluatePayment(base());
  assert.equal(d.verdict, "ALLOW");
  assert.equal(d.reasonCode, "OK");
  assert.equal(d.limits.perTxCapUqor, "500000");
  assert.equal(d.limits.windowRemainingTxs, "5");
});

test("REFUSE: recipient not in the allowlist", () => {
  const d = evaluatePayment(base({ payment: { id: "x", to: "0x9999999999999999999999999999999999999999", amountUqor: 100_000n } }));
  assert.equal(d.verdict, "REFUSE");
  assert.equal(d.reasonCode, "NOT_ALLOWLISTED");
});

test("REFUSE: zero amount", () => {
  const d = evaluatePayment(base({ payment: { id: "x", to: "0x1111111111111111111111111111111111111111", amountUqor: 0n } }));
  assert.equal(d.reasonCode, "AMOUNT_ZERO");
});

test("REFUSE: amount over the per-tx cap", () => {
  const d = evaluatePayment(base({ payment: { id: "x", to: "0x1111111111111111111111111111111111111111", amountUqor: 500_001n } }));
  assert.equal(d.reasonCode, "OVER_PER_TX_CAP");
});

test("REFUSE: amount would break the daily cap", () => {
  const d = evaluatePayment(base({ spentTodayUqor: 950_000n }));
  assert.equal(d.reasonCode, "OVER_DAILY_CAP");
});

test("REFUSE: authenticator expired", () => {
  const d = evaluatePayment(base({ authenticatorExpiryUnix: 1_699_999_999 }));
  assert.equal(d.reasonCode, "AUTHENTICATOR_EXPIRED");
});

test("REFUSE: no window stored", () => {
  const d = evaluatePayment(base({ window: null }));
  assert.equal(d.reasonCode, "NO_WINDOW");
});

test("REFUSE: window stored but not live", () => {
  const d = evaluatePayment(base({ window: { ...base().window!, live: false } }));
  assert.equal(d.reasonCode, "WINDOW_NOT_LIVE");
});

test("REFUSE: window out of transactions", () => {
  const d = evaluatePayment(base({ window: { ...base().window!, remainingTxs: 0n } }));
  assert.equal(d.reasonCode, "WINDOW_TXS_EXHAUSTED");
});

test("REFUSE: window out of blocks", () => {
  const d = evaluatePayment(base({ window: { ...base().window!, remainingBlocks: 0n } }));
  assert.equal(d.reasonCode, "WINDOW_BLOCKS_EXHAUSTED");
});

test("REFUSE: recipient not in the window's allowed_targets", () => {
  const d = evaluatePayment(
    base({
      allowlist: new Set([
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ]),
      payment: { id: "bob", to: "0x2222222222222222222222222222222222222222", amountUqor: 100_000n },
    }),
  );
  assert.equal(d.reasonCode, "WINDOW_TARGET_NOT_LISTED");
});

test("REFUSE: value + max fee exceeds the window's remaining value", () => {
  const d = evaluatePayment(base({ window: { ...base().window!, remainingValue: 120_000n } }));
  assert.equal(d.reasonCode, "WINDOW_VALUE_EXHAUSTED");
});

test("ALLOW: unscoped window (empty allowed_targets) admits any allowlisted recipient", () => {
  const d = evaluatePayment(base({ window: { ...base().window!, allowedTargets: [] } }));
  assert.equal(d.verdict, "ALLOW");
});

test("ALLOW: treasury-direct mode skips window checks", () => {
  const d = evaluatePayment(base({ window: null, requireWindow: false, floatBalanceUqor: null }));
  assert.equal(d.verdict, "ALLOW");
});

test("REFUSE: treasury-direct mode still enforces caps", () => {
  const d = evaluatePayment(
    base({ window: null, requireWindow: false, floatBalanceUqor: null, spentTodayUqor: 999_999n }),
  );
  assert.equal(d.reasonCode, "OVER_DAILY_CAP");
});

test("REFUSE: float balance cannot cover the payment", () => {
  const d = evaluatePayment(base({ floatBalanceUqor: 50_000n }));
  assert.equal(d.reasonCode, "INSUFFICIENT_FLOAT");
});

test("utcDayKey: UTC calendar day", () => {
  assert.equal(utcDayKey(new Date("2026-11-15T23:30:00Z")), "2026-11-15");
  assert.equal(utcDayKey(new Date("2026-11-16T00:30:00Z")), "2026-11-16");
});
