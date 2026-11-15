/**
 * config.ts — environment + schedule loading for the QDay Pay Agent.
 *
 * TESTNET ONLY. The agent refuses to run against any network but
 * qorechain-diana (EVM chain ID 9800). There is no mainnet path in this file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TESTNET = {
  chainId: "qorechain-diana",
  evmChainId: 9800,
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
  evmRpc: "https://evm-testnet.qore.host",
  explorer: "https://explore.qore.network",
} as const;

/** 1 QOR = 1,000,000 uqor = 10^18 wei. So 1 uqor = 10^12 wei. */
export const UQOR_PER_QOR = 1_000_000n;
export const WEI_PER_UQOR = 10n ** 12n;

export interface Payee {
  id: string;
  to: string; // 0x 20-byte EOA address
  amountUqor: string; // decimal uqor string
  everyHours: number;
  label?: string;
}

export interface Schedule {
  payees: Payee[];
}

export interface AgentConfig {
  network: "testnet";
  treasuryAccount: string; // "" = float-only mode
  perTxCapUqor: bigint;
  dailyCapUqor: bigint;
  authExpiryDays: number;
  windowBlocks: bigint;
  maxFeePerTxUqor: bigint;
  scheduleFile: string;
  stateFile: string;
  logFile: string;
  tickSeconds: number;
  projectRoot: string;
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = BigInt(raw);
  if (v <= 0n) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return v;
}

export function loadConfig(projectRoot: string = process.cwd()): AgentConfig {
  // Hard guard: testnet only. Any other value is a refusal, not a fallback.
  const network = (process.env.QORE_NETWORK ?? "testnet").trim();
  if (network !== "testnet") {
    throw new Error(
      `QORE_NETWORK must be "testnet" — this agent never runs on mainnet (got "${network}")`,
    );
  }
  return {
    network: "testnet",
    treasuryAccount: (process.env.TREASURY_ACCOUNT ?? "").trim(),
    perTxCapUqor: envBigInt("AGENT_PER_TX_CAP_UQOR", 500_000n),
    dailyCapUqor: envBigInt("AGENT_DAILY_CAP_UQOR", 1_000_000n),
    authExpiryDays: envInt("AGENT_AUTH_EXPIRY_DAYS", 30),
    windowBlocks: envBigInt("QORE_WINDOW_BLOCKS", 600n),
    maxFeePerTxUqor: envBigInt("AGENT_MAX_FEE_PER_TX_UQOR", 25_000n),
    scheduleFile: resolve(projectRoot, process.env.AGENT_SCHEDULE_FILE ?? "schedule.json"),
    stateFile: resolve(projectRoot, process.env.AGENT_STATE_FILE ?? "state.json"),
    logFile: resolve(projectRoot, process.env.AGENT_LOG_FILE ?? "logs/decisions.jsonl"),
    tickSeconds: envInt("AGENT_TICK_SECONDS", 60),
    projectRoot,
  };
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function validatePayee(p: Payee): void {
  if (!p.id || typeof p.id !== "string") throw new Error("schedule payee is missing an id");
  if (!EVM_ADDRESS.test(p.to)) throw new Error(`payee ${p.id}: "to" is not a 0x address: ${p.to}`);
  const amount = BigInt(p.amountUqor);
  if (amount <= 0n) throw new Error(`payee ${p.id}: amountUqor must be positive`);
  if (!Number.isFinite(p.everyHours) || p.everyHours <= 0) {
    throw new Error(`payee ${p.id}: everyHours must be a positive number`);
  }
}

export function loadSchedule(path: string): Schedule {
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw) as Schedule;
  if (!Array.isArray(data.payees) || data.payees.length === 0) {
    throw new Error(`schedule ${path}: "payees" must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const p of data.payees) {
    validatePayee(p);
    const key = p.to.toLowerCase();
    if (seen.has(key)) throw new Error(`schedule ${path}: duplicate payee address ${p.to}`);
    seen.add(key);
  }
  return data;
}

/** uqor -> wei (EVM view), exact. */
export function uqorToWei(uqor: bigint): bigint {
  return uqor * WEI_PER_UQOR;
}

/** wei -> uqor, rounding UP the way the chain charges a window. */
export function weiToUqorCeil(wei: bigint): bigint {
  return (wei + WEI_PER_UQOR - 1n) / WEI_PER_UQOR;
}
