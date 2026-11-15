import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  loadSchedule,
  uqorToWei,
  validatePayee,
  weiToUqorCeil,
} from "../src/config.ts";

test("uqorToWei / weiToUqorCeil: 1 uqor = 10^12 wei, ceil rounds up", () => {
  assert.equal(uqorToWei(1n), 10n ** 12n);
  assert.equal(uqorToWei(1_000_000n), 10n ** 18n); // 1 QOR
  assert.equal(weiToUqorCeil(1n), 1n);
  assert.equal(weiToUqorCeil(10n ** 12n), 1n);
  assert.equal(weiToUqorCeil(10n ** 12n + 1n), 2n);
});

test("loadConfig: refuses anything but testnet", () => {
  const prev = process.env.QORE_NETWORK;
  try {
    process.env.QORE_NETWORK = "mainnet";
    assert.throws(() => loadConfig(), /must be "testnet"/);
    process.env.QORE_NETWORK = "qorechain-vladi";
    assert.throws(() => loadConfig(), /must be "testnet"/);
    delete process.env.QORE_NETWORK;
    assert.equal(loadConfig().network, "testnet");
  } finally {
    if (prev === undefined) delete process.env.QORE_NETWORK;
    else process.env.QORE_NETWORK = prev;
  }
});

test("loadConfig: rejects non-positive caps", () => {
  const prev = process.env.AGENT_PER_TX_CAP_UQOR;
  try {
    process.env.AGENT_PER_TX_CAP_UQOR = "0";
    assert.throws(() => loadConfig(), /must be a positive integer/);
  } finally {
    if (prev === undefined) delete process.env.AGENT_PER_TX_CAP_UQOR;
    else process.env.AGENT_PER_TX_CAP_UQOR = prev;
  }
});

test("validatePayee: rejects bad addresses, zero amounts, bad intervals", () => {
  const good = { id: "a", to: "0x1111111111111111111111111111111111111111", amountUqor: "100", everyHours: 24 };
  validatePayee(good);
  assert.throws(() => validatePayee({ ...good, to: "not-an-address" }), /not a 0x address/);
  assert.throws(() => validatePayee({ ...good, amountUqor: "0" }), /must be positive/);
  assert.throws(() => validatePayee({ ...good, everyHours: 0 }), /everyHours/);
});

test("loadSchedule: rejects duplicate payee addresses and empty lists", () => {
  const dir = mkdtempSync(join(tmpdir(), "qday-agent-"));
  const dup = join(dir, "dup.json");
  writeFileSync(
    dup,
    JSON.stringify({
      payees: [
        { id: "a", to: "0x1111111111111111111111111111111111111111", amountUqor: "100", everyHours: 24 },
        { id: "b", to: "0x1111111111111111111111111111111111111111", amountUqor: "100", everyHours: 24 },
      ],
    }),
  );
  assert.throws(() => loadSchedule(dup), /duplicate payee address/);
  const empty = join(dir, "empty.json");
  writeFileSync(empty, JSON.stringify({ payees: [] }));
  assert.throws(() => loadSchedule(empty), /non-empty array/);
});
