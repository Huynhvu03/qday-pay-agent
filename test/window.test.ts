import test from "node:test";
import assert from "node:assert/strict";
import { maxFeePerPaymentUqor, planWindow, windowId } from "../src/window.ts";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

test("maxFeePerPaymentUqor: 100,000 gas x 250 gwei = 25,000 uqor", () => {
  // 100_000 * 250e9 wei = 2.5e16 wei = 25_000 uqor (1 uqor = 1e12 wei).
  assert.equal(maxFeePerPaymentUqor(), 25_000n);
});

test("planWindow: sizes value as sum(amount + max fee) per payment", () => {
  const plan = planWindow(
    [
      { to: ALICE, amountUqor: 100_000n },
      { to: BOB, amountUqor: 50_000n },
    ],
    600n,
  );
  assert.equal(plan.blocks, 600n);
  assert.equal(plan.maxTxs, 2n);
  assert.equal(plan.maxValue, 100_000n + 25_000n + 50_000n + 25_000n);
  assert.deepEqual(plan.allowedTargets, [ALICE.toLowerCase(), BOB.toLowerCase()]);
});

test("planWindow: tutorial default shape (600 blocks, 5 txs) is within bounds", () => {
  const plan = planWindow(
    Array.from({ length: 5 }, (_, i) => ({
      to: `0x000000000000000000000000000000000000000${i + 1}`,
      amountUqor: 100_000n,
    })),
    600n,
  );
  assert.equal(plan.maxTxs, 5n);
  assert.ok(plan.maxValue > 0n);
});

test("planWindow: rejects 0 blocks", () => {
  assert.throws(() => planWindow([{ to: ALICE, amountUqor: 1n }], 0n), /blocks must be 1\.\./);
});

test("planWindow: rejects blocks above the chain max (17,280)", () => {
  assert.throws(() => planWindow([{ to: ALICE, amountUqor: 1n }], 17_281n), /blocks must be 1\.\./);
});

test("planWindow: rejects more than 16 distinct targets", () => {
  const payments = Array.from({ length: 17 }, (_, i) => ({
    to: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    amountUqor: 1n,
  }));
  assert.throws(() => planWindow(payments, 600n), /distinct targets exceed/);
});

test("planWindow: rejects an empty batch", () => {
  assert.throws(() => planWindow([], 600n), /nothing to pay/);
});

test("windowId: openedHeight-expiryHeight", () => {
  assert.equal(windowId({ openedHeight: 9942089n, expiryHeight: 9942389n } as never), "9942089-9942389");
});
