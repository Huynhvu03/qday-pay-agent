/**
 * keys.ts — the agent's own throwaway testnet identity.
 *
 * Same account model as Workshop 1 (`scripts/window.ts` in qday-demo):
 * a secp256k1 key (PRIVATE_KEY) plus the ML-DSA-87 recovery code
 * (QORE_PQC_RECOVERY_CODE, QRC1...), or a single BIP-39 mnemonic.
 * The agent holds this key and NOTHING else: it never sees the owner's key,
 * the treasury owner's key, or any seed phrase.
 *
 * TEST QOR ONLY. Never put a key that holds real funds here.
 */
import {
  deriveUnifiedAccount,
  isValidRecoveryCode,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";

export async function loadAgentAccount(): Promise<UnifiedAccount> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (mnemonic) return deriveUnifiedAccount(mnemonic, 0);
  const key = process.env.PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "Set QORE_MNEMONIC, or PRIVATE_KEY as 0x followed by 64 hex characters, in .env",
    );
  }
  const recoveryCode = process.env.QORE_PQC_RECOVERY_CODE?.trim();
  if (!recoveryCode) {
    throw new Error(
      "Set QORE_PQC_RECOVERY_CODE in .env (create one with `pnpm window recovery-code` in qday-demo, or `node scripts/make-key.mjs`), or set QORE_MNEMONIC instead.",
    );
  }
  if (!isValidRecoveryCode(recoveryCode)) {
    throw new Error("QORE_PQC_RECOVERY_CODE is not a valid QRC1 recovery code (check for a typo)");
  }
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), {
    recoveryCode,
  });
}

/** The agent's raw secp256k1 private key as a 0x-hex string (for viem signing). */
export function agentPrivateKeyHex(): `0x${string}` {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (mnemonic) {
    throw new Error(
      "Mnemonic mode: authenticator signing needs PRIVATE_KEY in .env — derive the agent key with `node scripts/make-key.mjs` instead of a mnemonic.",
    );
  }
  const key = process.env.PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Set PRIVATE_KEY as 0x followed by 64 hex characters, in .env");
  }
  return key as `0x${string}`;
}
