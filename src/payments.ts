/**
 * payments.ts — the agent float's EVM payments.
 *
 * The agent pays plain QOR transfers from its own float address, inside the
 * scoped window it opened for exactly the due payees. A plain transfer is
 * the smallest thing the window admits: `nativeOnly` would also admit it,
 * but the agent uses `allowedTargets` so the window itself refuses any other
 * recipient even if the policy engine were bypassed.
 *
 * Amounts: the schedule is uqor; the EVM lane is 18-decimal wei
 * (1 uqor = 10^12 wei). Gas is capped explicitly (100,000) with a 250 gwei
 * fee cap so the window charge stays inside the planned maxValue.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TESTNET, uqorToWei, weiToUqorCeil } from "./config.js";

export const QORE_TESTNET_CHAIN = {
  id: TESTNET.evmChainId,
  name: "QoreChain Testnet Diana",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [TESTNET.evmRpc] } },
} as const;

export function createClients(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: QORE_TESTNET_CHAIN,
    transport: http(TESTNET.evmRpc),
  });
  const walletClient = createWalletClient({
    account,
    chain: QORE_TESTNET_CHAIN,
    transport: http(TESTNET.evmRpc),
  });
  return { account, publicClient, walletClient };
}

/** Float balance in uqor (wei read from the chain, rounded down). */
export async function floatBalanceUqor(
  publicClient: ReturnType<typeof createClients>["publicClient"],
  address: `0x${string}`,
): Promise<bigint> {
  const wei = await publicClient.getBalance({ address });
  return wei / 10n ** 12n;
}

/** Current EVM nonce of an address (for diagnostics only). */
export async function evmNonce(
  publicClient: ReturnType<typeof createClients>["publicClient"],
  address: `0x${string}`,
): Promise<number> {
  return publicClient.getTransactionCount({ address });
}

/**
 * Send one plain QOR transfer inside the open window. Returns the tx hash.
 * The window must already be open and cover this payment — the chain
 * refuses the tx otherwise ("EVM authorisation window exhausted" / "no
 * window"), which surfaces here as a thrown error, never a silent success.
 */
export async function sendFloatPayment(input: {
  walletClient: ReturnType<typeof createClients>["walletClient"];
  from: `0x${string}`;
  to: `0x${string}`;
  amountUqor: bigint;
}): Promise<`0x${string}`> {
  const hash = await input.walletClient.sendTransaction({
    // Sign locally with the wallet client's own account (built from the
    // agent private key in createClients). Passing the raw `from` address
    // here would make viem treat it as a node-managed JSON-RPC account and
    // the node refuses with "account unlock with HTTP access is forbidden".
    account: input.walletClient.account,
    to: input.to,
    value: uqorToWei(input.amountUqor),
    gas: 100_000n,
    maxFeePerGas: 250_000_000_000n, // 250 gwei
    maxPriorityFeePerGas: 1_000_000_000n, // 1 gwei
    chain: QORE_TESTNET_CHAIN,
  });
  return hash;
}

/** Wait for a tx receipt; returns true when it succeeded on-chain. */
export async function waitForReceipt(
  publicClient: ReturnType<typeof createClients>["publicClient"],
  hash: `0x${string}`,
  timeoutMs = 120_000,
): Promise<boolean> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  return receipt.status === "success";
}

export { weiToUqorCeil };
