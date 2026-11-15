import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  duePayments,
  emptyState,
  loadState,
  recordSent,
  saveState,
  spentToday,
  type AgentState,
} from "../src/scheduler.ts";
import type { Payee } from "../src/config.ts";

const ALICE: Payee = { id: "alice", to: "0x1111111111111111111111111111111111111111", amountUqor: "100000", everyHours: 24 };
const BOB: Payee = { id: "bob", to: "0x2222222222222222222222222222222222222222", amountUqor: "50000", everyHours: 12 };

const NOW = 1_700_000_000;

test("duePayments: never-paid payees are due immediately", () => {
  const due = duePayments([ALICE, BOB], emptyState(), NOW);
  assert.deepEqual(due.map((d) => d.payee.id), ["alice", "bob"]);
});

test("duePayments: a payee is not due inside its interval", () => {
  const state: AgentState = {
    version: 1,
    spentByDay: {},
    payees: { alice: { lastPaidUnix: NOW - 3600, lastTxHash: "0xabc" } },
  };
  assert.deepEqual(duePayments([ALICE], state, NOW).map((d) => d.payee.id), []);
});

test("duePayments: a payee is due once its interval has elapsed", () => {
  const state: AgentState = {
    version: 1,
    spentByDay: {},
    payees: { bob: { lastPaidUnix: NOW - 12 * 3600, lastTxHash: "0xabc" } },
  };
  const due = duePayments([BOB], state, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0].dueUnix, NOW); // last + 12h == NOW
});

test("recordSent + spentToday: daily accounting accumulates per UTC day", () => {
  let state = emptyState();
  const day = new Date("2026-11-15T10:00:00Z");
  state = recordSent(state, "alice", 100_000n, "0xhash1", NOW, day);
  state = recordSent(state, "bob", 50_000n, "0xhash2", NOW, day);
  assert.equal(spentToday(state, day), 150_000n);
  assert.equal(spentToday(state, new Date("2026-11-16T10:00:00Z")), 0n);
  assert.equal(state.payees.alice.lastTxHash, "0xhash1");
});

test("loadState/saveState round-trip; missing file gives an empty state", () => {
  const dir = mkdtempSync(join(tmpdir(), "qday-agent-"));
  const path = join(dir, "state.json");
  assert.deepEqual(loadState(path), emptyState());
  const state = recordSent(emptyState(), "alice", 100_000n, "0xhash", NOW, new Date("2026-11-15T10:00:00Z"));
  saveState(path, state);
  const loaded = loadState(path);
  assert.equal(loaded.payees.alice.lastTxHash, "0xhash");
  assert.equal(loaded.spentByDay["2026-11-15"], "100000");
});

test("loadState: a corrupt file throws instead of silently resetting", () => {
  const dir = mkdtempSync(join(tmpdir(), "qday-agent-"));
  const path = join(dir, "state.json");
  writeFileSync(path, "{not json", "utf8");
  assert.throws(() => loadState(path), /cannot read state/);
});
