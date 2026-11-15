/**
 * make-recovery-code.mjs — print a fresh QRC1 recovery code for the agent.
 * Paste it into .env as QORE_PQC_RECOVERY_CODE. Keep a copy apart from
 * PRIVATE_KEY and keep using the same one (a new code = a different PQC key).
 */
import { generatePqcRecoveryCode } from "@qorechain/sdk";

console.log(generatePqcRecoveryCode());
console.log("Put it in .env as QORE_PQC_RECOVERY_CODE and keep a copy apart from PRIVATE_KEY.");
