import test from "node:test";
import assert from "node:assert/strict";
import {
  cosmosAuthSignBytes,
  evmAuthSignBytesV2,
  signAuthenticatorLinkEip191,
  verifyAuthenticatorLinkProof,
} from "@qorechain/sdk";
import { generatePrivateKey, privateKeyToAccount, signMessage } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { agentSpendingRule, agentEthAddressBytes } from "../src/treasury.ts";

const CHAIN = "qorechain-diana";
const TREASURY = "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2rq73l";

function throwawayKey(): `0x${string}` {
  return generatePrivateKey();
}

test("evmAuthSignBytesV2: deterministic, and bound to every field", () => {
  const key = throwawayKey();
  const pubkey = agentEthAddressBytes(key);
  const input = {
    chainId: CHAIN,
    account: TREASURY,
    pubkey,
    to: "0x1111111111111111111111111111111111111111",
    value: "100000000000000000",
    data: new Uint8Array(0),
    nonce: 0n,
    gasLimit: 100_000n,
  };
  const a = evmAuthSignBytesV2(input);
  const b = evmAuthSignBytesV2(input);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  // Changing any bound field changes the digest.
  assert.notDeepEqual(a, evmAuthSignBytesV2({ ...input, value: "200000000000000000" }));
  assert.notDeepEqual(a, evmAuthSignBytesV2({ ...input, nonce: 1n }));
  assert.notDeepEqual(a, evmAuthSignBytesV2({ ...input, gasLimit: 200_000n }));
  assert.notDeepEqual(a, evmAuthSignBytesV2({ ...input, to: "0x2222222222222222222222222222222222222222" }));
});

test("cosmosAuthSignBytes: deterministic and bound to amount + nonce", () => {
  const key = throwawayKey();
  const pubkey = agentEthAddressBytes(key);
  const input = {
    chainId: CHAIN,
    account: TREASURY,
    pubkey,
    to: "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2rq73l",
    amount: "100000uqor",
    nonce: 0n,
  };
  const a = cosmosAuthSignBytes(input);
  assert.equal(a.length, 32);
  assert.deepEqual(a, cosmosAuthSignBytes(input));
  assert.notDeepEqual(a, cosmosAuthSignBytes({ ...input, amount: "200000uqor" }));
  assert.notDeepEqual(a, cosmosAuthSignBytes({ ...input, nonce: 1n }));
});

test("link possession proof: EIP-191 proof verifies the way the chain does", () => {
  const key = throwawayKey();
  const proof = signAuthenticatorLinkEip191({ chainId: CHAIN, account: TREASURY, privateKey: key });
  assert.equal(proof.possessionProof.length, 65); // r || s || v
  const ok = verifyAuthenticatorLinkProof({
    chainId: CHAIN,
    account: TREASURY,
    scheme: "secp256k1",
    pubkey: agentEthAddressBytes(key),
    possessionProof: proof.possessionProof,
  });
  assert.equal(ok, true);
  // A proof for another account does not verify.
  const wrong = verifyAuthenticatorLinkProof({
    chainId: CHAIN,
    account: "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    scheme: "secp256k1",
    pubkey: agentEthAddressBytes(key),
    possessionProof: proof.possessionProof,
  });
  assert.equal(wrong, false);
});

test("execute signature: EIP-191 personal_sign of the digest recovers the agent address", async () => {
  const key = throwawayKey();
  const account = privateKeyToAccount(key);
  const digest = evmAuthSignBytesV2({
    chainId: CHAIN,
    account: TREASURY,
    pubkey: agentEthAddressBytes(key),
    to: "0x1111111111111111111111111111111111111111",
    value: "100000000000000000",
    data: new Uint8Array(0),
    nonce: 0n,
    gasLimit: 100_000n,
  });
  const signature = await signMessage({ message: { raw: digest }, privateKey: key });
  assert.equal(signature.length, 132); // 0x + 65 bytes
  const recovered = await recoverMessageAddress({ message: { raw: digest }, signature });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
});

test("agentSpendingRule: uqor-only, enabled, with both caps", () => {
  const rule = agentSpendingRule(500_000n, 1_000_000n);
  assert.equal(rule.id, "qday-pay-agent");
  assert.equal(rule.enabled, true);
  assert.equal(rule.perTxLimit, "500000");
  assert.equal(rule.dailyLimit, "1000000");
  assert.deepEqual(rule.allowedDenoms, ["uqor"]);
});
