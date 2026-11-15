/**
 * window.ts — the scoped EVM authorisation window, the agent's first
 * on-chain enforcement layer.
 *
 * A window bounds, on-chain, what the agent's own EVM address may do:
 *   blocks   1..17,280  (a block count, not a duration; ~5h max on testnet)
 *   max_txs  1..1,000
 *   max_value  uqor: transferred value PLUS the maximum fee of every tx
 *   allowed_targets  at most 16 addresses; a scoped window refuses anything
 *                    else (and refuses contract creation)
 *
 * The agent opens a window scoped to exactly its payees, sized for exactly
 * the payments due in this run. Opening is a hybrid-signed native message
 * (secp256k1 + ML-DSA-87) — the classical key alone can never open one.
 * Every EVM payment is then admitted only while the window covers it; the
 * chain charges value + max fee (wei -> uqor, rounded up) and a reverted tx
 * still consumes its share.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  closeEvmWindowMsg,
  fetchPqcStatus,
  isRegisteredPqcKey,
  openEvmWindowMsg,
  type UnifiedAccount,
} from "@qorechain/sdk";
import {
  MAX_EVM_WINDOW_BLOCKS,
  MAX_EVM_WINDOW_TARGETS,
  MAX_EVM_WINDOW_TXS,
  classifyEvmWindowRejection,
  evmWindowCost,
  evmWindowStatus,
  type EvmWindow,
} from "@qorechain/evm";
import { TESTNET } from "./config.js";
import type { WindowSnapshot } from "./policy.js";

export { classifyEvmWindowRejection };

/** Worst-case fee the agent assumes per plain transfer (gas x fee cap). */
export const PAYMENT_GAS_LIMIT = 100_000n;
export const PAYMENT_MAX_FEE_PER_GAS_WEI = 250_000_000_000n; // 250 gwei

export interface WindowPlan {
  blocks: bigint;
  maxTxs: bigint;
  maxValue: bigint;
  allowedTargets: string[];
}

/**
 * Size a scoped window for a batch of payments. maxValue covers every
 * payment's value plus its worst-case fee (the chain charges value + max
 * fee per admitted tx). Throws when any bound is outside the chain's limits.
 */
export function planWindow(
  payments: { to: string; amountUqor: bigint }[],
  blocks: bigint,
): WindowPlan {
  if (payments.length === 0) throw new Error("planWindow: nothing to pay");
  if (blocks < 1n || blocks > MAX_EVM_WINDOW_BLOCKS) {
    throw new Error(
      `planWindow: blocks must be 1..${MAX_EVM_WINDOW_BLOCKS}, got ${blocks}`,
    );
  }
  if (BigInt(payments.length) > MAX_EVM_WINDOW_TXS) {
    throw new Error(
      `planWindow: ${payments.length} payments exceed the max ${MAX_EVM_WINDOW_TXS} txs per window`,
    );
  }
  const targets = [...new Set(payments.map((p) => p.to.toLowerCase()))];
  if (targets.length > MAX_EVM_WINDOW_TARGETS) {
    throw new Error(
      `planWindow: ${targets.length} distinct targets exceed the max ${MAX_EVM_WINDOW_TARGETS} allowed_targets`,
    );
  }
  // Per-tx worst-case fee, in uqor, the way the chain charges it.
  const perTxFeeUqor = evmWindowCost({
    gas: PAYMENT_GAS_LIMIT,
    maxFeePerGas: PAYMENT_MAX_FEE_PER_GAS_WEI,
  });
  let maxValue = 0n;
  for (const p of payments) maxValue += p.amountUqor + perTxFeeUqor;
  return {
    blocks,
    maxTxs: BigInt(payments.length),
    maxValue,
    allowedTargets: targets,
  };
}

/** The worst-case fee (uqor) one payment consumes from a window. */
export function maxFeePerPaymentUqor(): bigint {
  return evmWindowCost({ gas: PAYMENT_GAS_LIMIT, maxFeePerGas: PAYMENT_MAX_FEE_PER_GAS_WEI });
}

export function toWindowSnapshot(w: EvmWindow): WindowSnapshot {
  return {
    found: w.found,
    live: w.live,
    remainingBlocks: w.remainingBlocks,
    remainingTxs: w.remainingTxs,
    remainingValue: w.remainingValue,
    allowedTargets: w.allowedTargets,
    openedHeight: w.openedHeight,
    expiryHeight: w.expiryHeight,
  };
}

/** Short window id for the decision log: openedHeight-expiryHeight. */
export function windowId(w: WindowSnapshot | EvmWindow): string {
  return `${w.openedHeight}-${w.expiryHeight}`;
}

export async function fetchWindow(address: string): Promise<EvmWindow> {
  return evmWindowStatus({ rest: TESTNET.rest, address });
}

export async function fetchPqcRegistered(address: string): Promise<boolean> {
  const pqc = await fetchPqcStatus({ rest: TESTNET.rest, address });
  return pqc.registered;
}

export async function assertPqcKeyRegistered(
  acc: UnifiedAccount,
): Promise<void> {
  const pqc = await fetchPqcStatus({ rest: TESTNET.rest, address: acc.cosmos });
  if (!pqc.registered) {
    throw new Error(
      "account has no PQC key registered — run the Workshop 1 flow first (`pnpm window register` in qday-demo), then open a window",
    );
  }
  if (!isRegisteredPqcKey(pqc, acc.pqc.publicKey)) {
    throw new Error("registered PQC key is NOT this account's key — check QORE_PQC_RECOVERY_CODE in .env");
  }
}

const NATIVE_FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

async function accountSequence(address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const res = await fetch(`${TESTNET.rest}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) {
    throw new Error(`${address} does not exist on chain yet: send it some QOR first (faucet)`);
  }
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

async function broadcastHybrid(
  acc: UnifiedAccount,
  messages: Parameters<EthNativeSigner["sign"]>[0]["messages"],
): Promise<string> {
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: "hybrid", rest: TESTNET.rest });
  const transport = await StargateClient.connect(TESTNET.rpc);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: TESTNET.chainId,
      accountNumber,
      sequence,
      fee: NATIVE_FEE,
      messages,
    });
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

/** Open a scoped window (hybrid-signed). Returns the opening tx hash. */
export async function openScopedWindow(
  acc: UnifiedAccount,
  plan: WindowPlan,
): Promise<{ txHash: string; plan: WindowPlan }> {
  const msg = openEvmWindowMsg({
    sender: acc.cosmos,
    blocks: plan.blocks,
    maxTxs: plan.maxTxs,
    maxValue: plan.maxValue,
    allowedTargets: plan.allowedTargets,
  });
  const txHash = await broadcastHybrid(acc, [msg]);
  return { txHash, plan };
}

/** Close the agent's window early (hybrid-signed). */
export async function closeWindow(acc: UnifiedAccount): Promise<string> {
  return broadcastHybrid(acc, [closeEvmWindowMsg(acc.cosmos)]);
}
