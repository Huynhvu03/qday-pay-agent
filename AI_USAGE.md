# AI Usage — QDay Pay Agent

This file documents how AI was used to build this entry, for the
**Best AI-Native Build** special award. It is a factual record, not a
claim of autonomy: the human owner set the goal, the category and the
safety rules; the AI did the research, design and implementation under
those rules; the owner reviews, funds and submits.

## The AI system

- **Agent:** Muse (Meta's personal AI agent), running as the owner's
  main agent, with a delegated builder subagent for this entry.
- **Models:** the builder subagent ran on the Muse Spark model family
  (the same family as the main agent). No other model was used.
- **Tools the AI used:** web reading (QoreChain docs), terminal
  (Node.js, pnpm, git), file editing, unit tests, and live read-only
  queries against the QoreChain testnet REST/EVM endpoints.
- **No AI-generated secrets.** The agent's throwaway testnet key and
  QRC1 recovery code were generated locally by scripts
  (`scripts/make-key.mjs`, `scripts/make-recovery-code.mjs`) that write
  straight into `.env` and never print the values. The AI never saw,
  quoted, or stored them. The only key material the AI handled is the
  throwaway testnet identity, which holds no real funds.

## What the AI did

1. **Research (read-only).** Workshop 1, the EVM window reference
   (v3.2.8), the account-abstraction guide, and the QoreX extension docs
   on `docs.qorechain.io`; the fest rules on `build.qorechain.io`.
   Verified the testnet live: `abstractaccount` config
   (`enabled: true`), EVM limits, latest block.
2. **Learned the flow first.** Scaffolded the Workshop 1 demo
   (`create-qorechain-dapp@0.14.0`, Hardhat template) in `../qday-demo/`
   and ran its 2 sample tests — before designing the agent.
3. **Designed the agent** from the category requirements (scoped EVM
   window; tx/value/duration/target limits; smart-account spending
   rules; authenticated messaging): a scheduled-payment treasury agent
   with two on-chain enforcement layers, reusing the *policy concepts*
   (allowlist + caps → verdict + reason) from the author's existing
   LogiGuard wallet guard, adapted to QoreChain windows + smart accounts.
   No chain code was copied from LogiGuard (different chain, different
   mechanisms); the verdict model was.
4. **Implemented it** (~2,300 lines of TypeScript + 41 unit tests):
   policy engine, window manager, abstract-account link/execute/relay,
   float payments, scheduler, decision log, CLI.
5. **Verified it:** `tsc --noEmit` clean, 41/41 tests passing, and live
   read-only runs against the testnet (`status`, `plan`, `run-once`
   refusing with `INSUFFICIENT_FLOAT` and logging the refusals).
6. **Documented it:** this file, `README.md`, and the journal
   `../journal.md`.

## What the AI did NOT do (human / owner steps)

- **No wallet, no seed phrase.** The owner creates the QoreX wallet and
  keeps the 24-word phrase. The AI never asks for or handles one.
- **No faucet claim.** The faucet needs a dashboard login the owner has
  not done. The agent is funded only when the owner claims 100 QOR for
  its throwaway address — until then it fails closed, by design.
- **No registration or submission.** GitHub sign-in, the fest form, the
  X post, QoreX connect, repo creation and the entry submission on
  `build.qorechain.io` are the owner's steps.
- **No on-chain writes yet.** PQC key registration, window opens,
  authenticator linking and the first live payment all await funding.
  The code paths are written and unit-tested; the live runs are the
  owner's to trigger and witness.
- **No mainnet, no real money.** The code refuses any network but the
  Diana testnet, and the agent's key holds test QOR only.

## Decisions the AI made on its own (within the owner's brief)

- Scheduled payments over a DCA/swap variant (no swap path is shown in
  the docs/testnet — the simpler shape satisfies every requirement).
- Two enforcement layers (window for the float, spending rules for the
  treasury) instead of one, so each requirement has a real on-chain
  mechanism behind it.
- Decide-before-sign ordering in `run-once`: refusals are logged before
  any window is opened, so a refused batch costs no gas.
- The agent's key is linked by its 20-byte Ethereum address
  (MetaMask-style) so one pubkey form is used consistently across the
  link proof, the execute digests and the message fields.
- Fail-closed everywhere: unknown expiry, missing window, unreadable
  chain state, or any send error all end in `REFUSE`, never in a retry
  or a silent success.

## Verification a reviewer can repeat

```bash
pnpm install
pnpm typecheck   # clean
pnpm test        # 41 passing
pnpm status      # live read-only read of the testnet
pnpm plan        # dry-run verdicts, signs nothing
```

After the owner funds the agent (100 QOR from the faucet):

```bash
pnpm open-window   # scoped window for the due payments
pnpm run-once      # pays them; decisions land in logs/decisions.jsonl
```
