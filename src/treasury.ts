/**
 * treasury.ts — the smart-account layer (`x/abstractaccount`).
 *
 * The treasury is the owner's canonical account. The agent NEVER holds the
 * owner's key. Instead the owner links the agent's secp256k1 key as an
 * *authenticator* on the treasury, with least-privilege permissions and an
 * on-chain spending rule. The chain then enforces, per execution:
 *   - the key is linked, not revoked, and not expired
 *   - the permission covers the action (`evm` for EVM calls, `send` for
 *     native bank sends)
 *   - the per-transaction and daily spending caps, in uqor
 *   - the authenticator's own replay-bound sequence (nonce)
 *
 * The agent's key is linked BY ITS 20-BYTE ETHEREUM ADDRESS (MetaMask-style,
 * scheme `secp256k1`). That keeps one pubkey form everywhere: the possession
 * proof (EIP-191 personal_sign of the link text), the execute digests
 * (pubkey = the 20-byte address) and the MsgExecuteEVM/Cosmos `pubkey` field.
 * Execute signatures are EIP-191 personal_signs of the 32-byte digest —
 * exactly the flow `buildMetaMaskExecuteEvm` uses, with a local key instead
 * of a provider.
 *
 * Nonce note: the SDK (0.14.0, matching chain v3.2.8) reads the nonce from
 * `fetchAuthNonce` — the per-authenticator sequence, NOT the account's EVM
 * nonce. The developer-guide page still says the EVM nonce for ExecuteEVM;
 * the SDK's byte-for-byte digest docs and `fetchAuthNonce` are authoritative
 * for v3.2.8, and the live testnet run is the arbiter. The agent reads the
 * sequence live before every authorization, so either way it signs the
 * current value.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  cosmosAuthSignBytes,
  evmAuthSignBytes,
  evmAuthSignBytesV2,
  executeCosmosMsg,
  executeEvmMsg,
  fetchAuthNonce,
  linkAuthenticatorMsgs,
  msg,
  resolveEvmAuthDigestVersion,
  signAuthenticatorLinkEip191,
  type EncodeObject,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { privateKeyToAccount, signMessage } from "viem/accounts";
import { TESTNET, uqorToWei } from "./config.js";

export const EXECUTE_EVM_GAS_LIMIT = 100_000n;
export const EXECUTE_COSMOS_GAS_LIMIT = 100_000n;

/** The agent's 20-byte address (the authenticator pubkey form). */
export function agentEthAddress(privateKey: `0x${string}`): `0x${string}` {
  return privateKeyToAccount(privateKey).address;
}

export function agentEthAddressBytes(privateKey: `0x${string}`): Uint8Array {
  const addr = agentEthAddress(privateKey);
  return Uint8Array.from(Buffer.from(addr.slice(2), "hex"));
}

/** The spending rule the owner sets for the agent key (uqor). */
export function agentSpendingRule(perTxCapUqor: bigint, dailyCapUqor: bigint) {
  return {
    id: "qday-pay-agent",
    enabled: true,
    dailyLimit: dailyCapUqor.toString(),
    perTxLimit: perTxCapUqor.toString(),
    allowedDenoms: ["uqor"],
  };
}

/**
 * Build the owner-signed messages that link the agent key to the treasury:
 * `[MsgUpdateSpendingRules, MsgRegisterAuthenticator]`. The owner broadcasts
 * these (one hybrid-signed native tx); the agent only prepares them.
 * The agent signs the possession proof itself — proving it holds the key.
 */
export function buildLinkMessages(input: {
  owner: string;
  treasury: string;
  agentPrivateKey: `0x${string}`;
  perTxCapUqor: bigint;
  dailyCapUqor: bigint;
  expiryUnix: number;
}): { messages: ReturnType<typeof linkAuthenticatorMsgs>; proofBase64: string } {
  const possessionProof = signAuthenticatorLinkEip191({
    chainId: TESTNET.chainId,
    account: input.treasury,
    privateKey: input.agentPrivateKey,
  });
  const messages = linkAuthenticatorMsgs({
    owner: input.owner,
    account: input.treasury,
    chainId: TESTNET.chainId,
    scheme: "secp256k1",
    pubkey: agentEthAddressBytes(input.agentPrivateKey),
    permissions: ["evm", "send"],
    expiryUnix: input.expiryUnix,
    label: "qday-pay-agent",
    possessionProof: possessionProof.possessionProof,
    spendingRule: agentSpendingRule(input.perTxCapUqor, input.dailyCapUqor),
  });
  return {
    messages,
    proofBase64: Buffer.from(possessionProof.possessionProof).toString("base64"),
  };
}

/** Create a separate session_based abstract account (owner-signed). */
export function buildCreateAccountMessage(owner: string) {
  return msg.abstractaccount.createAbstractAccount({
    owner,
    accountType: "session_based",
  });
}

export interface ExecuteEvmAuthorization {
  /** The MsgExecuteEVM ready to broadcast (relayer = the agent's account). */
  message: EncodeObject;
  nonce: bigint;
  digestVersion: "v1" | "v2";
  digestHex: string;
  signatureHex: string;
}

/**
 * Build + sign a MsgExecuteEVM authorization for one treasury-direct payment.
 * The agent signs the domain-separated digest; the returned message is then
 * broadcast by a relayer (the agent self-relays with its own hybrid signer).
 */
export async function buildExecuteEvmAuthorization(input: {
  treasury: string;
  relayer: string;
  agentPrivateKey: `0x${string}`;
  to: string;
  amountUqor: bigint;
  gasLimit?: bigint;
}): Promise<ExecuteEvmAuthorization> {
  const gasLimit = input.gasLimit ?? EXECUTE_EVM_GAS_LIMIT;
  const pubkey = agentEthAddressBytes(input.agentPrivateKey);
  const { nonce } = await fetchAuthNonce({
    rest: TESTNET.rest,
    address: input.treasury,
    pubkey,
  });
  const digestVersion = await resolveEvmAuthDigestVersion({ rest: TESTNET.rest });
  const digestInput = {
    chainId: TESTNET.chainId,
    account: input.treasury,
    pubkey,
    to: input.to,
    value: uqorToWei(input.amountUqor).toString(),
    data: new Uint8Array(0),
    nonce,
    gasLimit,
  };
  const digest =
    digestVersion === "v2"
      ? evmAuthSignBytesV2(digestInput)
      : evmAuthSignBytes(digestInput);
  // EIP-191 personal_sign of the 32-byte digest (the MetaMask execute flow).
  const signature = await signMessage({
    message: { raw: digest },
    privateKey: input.agentPrivateKey,
  });
  const value = executeEvmMsg({
    relayer: input.relayer,
    account: input.treasury,
    scheme: "secp256k1",
    pubkey,
    signature: Uint8Array.from(Buffer.from(signature.slice(2), "hex")),
    to: input.to,
    value: uqorToWei(input.amountUqor).toString(),
    data: new Uint8Array(0),
    gasLimit,
    nonce,
  });
  return {
    message: value,
    nonce,
    digestVersion,
    digestHex: Buffer.from(digest).toString("hex"),
    signatureHex: signature,
  };
}

/**
 * Build + sign a MsgExecuteCosmos authorization: a native bank send from the
 * treasury to the agent's float (the top-up path). Same EIP-191 signing.
 */
export async function buildExecuteCosmosAuthorization(input: {
  treasury: string;
  relayer: string;
  agentPrivateKey: `0x${string}`;
  toCosmos: string;
  amountUqor: bigint;
}): Promise<{ message: EncodeObject; nonce: bigint }> {
  const pubkey = agentEthAddressBytes(input.agentPrivateKey);
  const { nonce } = await fetchAuthNonce({
    rest: TESTNET.rest,
    address: input.treasury,
    pubkey,
  });
  const amount = `${input.amountUqor.toString()}uqor`;
  const digest = cosmosAuthSignBytes({
    chainId: TESTNET.chainId,
    account: input.treasury,
    pubkey,
    to: input.toCosmos,
    amount,
    nonce,
  });
  const signature = await signMessage({
    message: { raw: digest },
    privateKey: input.agentPrivateKey,
  });
  const value = executeCosmosMsg({
    relayer: input.relayer,
    account: input.treasury,
    scheme: "secp256k1",
    pubkey,
    signature: Uint8Array.from(Buffer.from(signature.slice(2), "hex")),
    to: input.toCosmos,
    amount,
    nonce,
  });
  return {
    message: value,
    nonce,
  };
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

/**
 * Self-relay: broadcast native-lane messages in a tx signed hybrid by the
 * agent's own account (the agent's float pays the envelope fee). Used for
 * MsgExecuteEVM / MsgExecuteCosmos authorizations the agent signed.
 *
 * Note: the SDK's message composers return EncodeObjects whose `value` is
 * the plain message object (not encoded bytes); the signer's registry
 * encodes it at broadcast time — the same shape `openEvmWindowMsg` returns
 * in the Workshop 1 helper.
 */
export async function selfRelay(
  acc: UnifiedAccount,
  messages: EncodeObject[],
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
      messages: messages as Parameters<EthNativeSigner["sign"]>[0]["messages"],
    });
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

/** Read the treasury's abstract-account record (rules, linked keys) over REST. */
export async function fetchTreasuryAccount(treasury: string): Promise<unknown> {
  const res = await fetch(
    `${TESTNET.rest}/qorechain/abstractaccount/v1/accounts/${treasury}`,
  );
  if (!res.ok) throw new Error(`treasury account query failed: HTTP ${res.status}`);
  return res.json();
}

/** Read the agent key's authenticator sequence + linked state. */
export async function fetchAgentAuthNonce(
  treasury: string,
  agentPrivateKey: `0x${string}`,
): Promise<{ nonce: bigint; linked: boolean }> {
  return fetchAuthNonce({
    rest: TESTNET.rest,
    address: treasury,
    pubkey: agentEthAddressBytes(agentPrivateKey),
  });
}
