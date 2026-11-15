/**
 * make-key.mjs — generate the agent's throwaway testnet key into .env.
 *
 * Same idea as Workshop 1's make-key.mjs: the key is written straight into
 * .env and NEVER printed. Run once; a second run makes a different account.
 */
import { generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const env = readFileSync(".env", "utf8");
if (!/^PRIVATE_KEY=0x0{64}$/m.test(env)) {
  console.log("PRIVATE_KEY is already set in .env — refusing to overwrite it. Delete the line to regenerate.");
  process.exit(1);
}
writeFileSync(".env", env.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${generatePrivateKey()}`));
console.log("New private key saved in .env (not shown). Next: pnpm window recovery-code in qday-demo, or generate a QRC1 code here.");
