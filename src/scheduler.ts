/**
 * scheduler.ts — which payments are due, and the agent's persistent state.
 *
 * State (state.json, local only) tracks, per payee, the last time a payment
 * was SENT (not merely decided) and the UTC-day spend totals the daily cap
 * is accounted against. The chain is the source of truth for what was spent;
 * this file is the agent's local mirror so it can refuse locally before
 * signing anything.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Payee } from "./config.js";
import { utcDayKey } from "./policy.js";

export interface PayeeState {
  lastPaidUnix: number | null;
  lastTxHash: string | null;
}

export interface AgentState {
  version: 1;
  /** UTC day -> uqor spent that day (agent's own accounting). */
  spentByDay: Record<string, string>;
  payees: Record<string, PayeeState>;
}

export function emptyState(): AgentState {
  return { version: 1, spentByDay: {}, payees: {} };
}

export function loadState(path: string): AgentState {
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as AgentState;
    if (data.version !== 1 || typeof data.spentByDay !== "object" || typeof data.payees !== "object") {
      throw new Error("bad state file");
    }
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new Error(`cannot read state ${path}: ${(err as Error).message}`);
  }
}

export function saveState(path: string, state: AgentState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export interface DuePayment {
  payee: Payee;
  amountUqor: bigint;
  /** Unix seconds the payment became due. */
  dueUnix: number;
}

/** A payee is due when it has never been paid or its interval has elapsed. */
export function duePayments(
  payees: Payee[],
  state: AgentState,
  nowUnix: number,
): DuePayment[] {
  const due: DuePayment[] = [];
  for (const payee of payees) {
    const st = state.payees[payee.id];
    const last = st?.lastPaidUnix ?? null;
    if (last === null) {
      due.push({ payee, amountUqor: BigInt(payee.amountUqor), dueUnix: nowUnix });
    } else if (nowUnix - last >= payee.everyHours * 3600) {
      due.push({ payee, amountUqor: BigInt(payee.amountUqor), dueUnix: last + payee.everyHours * 3600 });
    }
  }
  return due;
}

export function spentToday(state: AgentState, now: Date = new Date()): bigint {
  return BigInt(state.spentByDay[utcDayKey(now)] ?? "0");
}

export function recordSent(
  state: AgentState,
  payeeId: string,
  amountUqor: bigint,
  txHash: string,
  nowUnix: number,
  now: Date = new Date(),
): AgentState {
  const day = utcDayKey(now);
  const spent = BigInt(state.spentByDay[day] ?? "0") + amountUqor;
  return {
    ...state,
    spentByDay: { ...state.spentByDay, [day]: spent.toString() },
    payees: {
      ...state.payees,
      [payeeId]: { lastPaidUnix: nowUnix, lastTxHash: txHash },
    },
  };
}
