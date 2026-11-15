/**
 * logger.ts — the decision log.
 *
 * Every agent decision is appended as one JSON line: the window id, the
 * limits in force, the payment, the verdict, and the tx hash or the refusal
 * reason. This is the audit trail the category asks for ("every agent
 * decision must be logged with its window id, the limits in force, and the
 * tx hash or the refusal reason").
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PolicyDecision } from "./policy.js";

export interface DecisionRecord {
  ts: string; // ISO timestamp
  decision: "ALLOW" | "REFUSE";
  reasonCode: string;
  reason: string;
  paymentId: string;
  to: string;
  amountUqor: string;
  windowId: string | null;
  limits: PolicyDecision["limits"];
  txHash: string | null;
  mode: "float" | "treasury-direct";
}

export function logDecision(
  path: string,
  record: Omit<DecisionRecord, "ts">,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  appendFileSync(path, line + "\n", "utf8");
}
