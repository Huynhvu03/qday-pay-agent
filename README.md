# QDay Pay Agent

An autonomous scheduled-payment treasury agent for the **QoreChain
Developer Fest — "Build Before Q-Day"**, category **Post-Quantum AI Agents**.

The agent pays fixed amounts to allowlisted addresses on a schedule — and
nothing else. Every limit is enforced **on-chain**, in two independent
layers, and every decision is logged with its window id, the limits in
force, and the tx hash or the refusal reason.

> **Testnet only** — `qorechain-diana`, EVM chain ID 9800. There is no
> mainnet path in this code: `loadConfig()` refuses any `QORE_NETWORK`
> other than `testnet`. Test QOR has no value.

## How it works

```
schedule.json (payees + amounts + intervals)
        │
        ▼
┌──────────────┐   policy engine (src/policy.ts)    ┌─────────────────────┐
│  QDay Pay    │ ── allowlist? per-tx cap? daily ──▶│  ALLOW → pay        │
│  Agent       │    cap? float? authenticator       │  REFUSE → log + skip│
│  (Node + TS) │    expiry? window live/txs/value?  └─────────────────────┘
└──────┬───────┘
       │  Layer 1 — scoped EVM window (on-chain)
       │  Layer 2 — abstract-account spending rules (on-chain)
       ▼
   QoreChain testnet diana
```

### Layer 1 — scoped EVM authorisation window

The agent's own float address pays plain QOR transfers **inside a window it
opens for exactly the due payees**:

- `allowed_targets` = the payees due in this run (at most 16)
- `max_txs` = the number of due payments
- `max_value` = Σ (payment value + worst-case fee), in uqor
- `blocks` = 600 by default (1..17,280 on-chain)

Opening is a hybrid-signed native message (secp256k1 + ML-DSA-87) — the
classical key alone can never open one. While the window is live the chain
admits only transfers to those targets, charges value + max fee per tx
(wei → uqor, rounded up), and refuses anything outside it with
`EVM authorisation window exhausted` / `no open EVM authorisation window`.

### Layer 2 — smart-account spending rules

The treasury is the owner's canonical account. The owner links the agent's
secp256k1 key as an **authenticator** (`x/abstractaccount`, enabled on the
testnet) with:

- permissions `["evm", "send"]` — least privilege, no `deploy`, no `all`
- a 30-day expiry (revocable any time with `MsgRevokeAuthenticator`)
- a possession proof: the agent key signs the v3.2.8 link text
  (`QoreChain authenticator link v1`, EIP-191) to prove it consents
- an on-chain spending rule: per-tx cap + daily cap, `allowed_denoms:
  ["uqor"]` only (defaults 0.5 QOR / 1 QOR per UTC day)

The agent tops its float up from the treasury with a `MsgExecuteCosmos`
authorization (domain-separated digest, per-authenticator sequence), and
can pay directly from the treasury with `MsgExecuteEVM` (v2 digest, binds
the gas limit) in `--mode treasury-direct`. It self-relays: the
authorization travels inside a native tx the agent signs hybrid with its
own account, so the agent never holds the owner's key.

### Authenticated messaging

- Window open/close: hybrid-signed native messages.
- `MsgExecuteEVM` / `MsgExecuteCosmos`: domain-separated digests
  (`qorechain-evm-auth-v2`, `qorechain-cosmos-auth-v1`), length-prefixed
  fields, replay-bound by the authenticator's own sequence
  (`fetchAuthNonce`), signed EIP-191 by the linked key.
- Every decision is appended to `logs/decisions.jsonl`:
  `{ts, decision, reasonCode, reason, paymentId, to, amountUqor, windowId,
  limits, txHash, mode}`.

### Policy engine (adapted from LogiGuard)

The decision model comes from the LogiGuard wallet guard
(`agentgames/guard`): allowlist + caps → verdict + reason, never a bare
boolean. Here the caps are the on-chain rules mirrored locally, so a
refused payment never costs a fee. Reason codes: `NOT_ALLOWLISTED`,
`AMOUNT_ZERO`, `OVER_PER_TX_CAP`, `OVER_DAILY_CAP`,
`AUTHENTICATOR_EXPIRED`, `NO_WINDOW`, `WINDOW_NOT_LIVE`,
`WINDOW_TXS_EXHAUSTED`, `WINDOW_VALUE_EXHAUSTED`,
`WINDOW_BLOCKS_EXHAUSTED`, `WINDOW_TARGET_NOT_LISTED`,
`INSUFFICIENT_FLOAT`. Fail-closed throughout: any uncertainty refuses.

## Project layout

```
src/
  config.ts     env + schedule loading, testnet-only guard, uqor/wei math
  keys.ts       the agent's throwaway identity (PRIVATE_KEY + QRC1 / mnemonic)
  policy.ts     the decision engine (pure — fully unit tested)
  window.ts     window sizing, open/fetch/close, rejection classification
  treasury.ts   authenticator link, spending rules, ExecuteEVM/Cosmos, relay
  payments.ts   float EVM transfers (viem), balances, receipts
  scheduler.ts  due computation + persistent state (state.json)
  logger.ts     JSONL decision log
  cli.ts        status | plan | open-window | close-window | run-once | link | daemon
scripts/
  make-key.mjs            generate the agent key into .env (never prints it)
  make-recovery-code.mjs  print a fresh QRC1 code for .env
test/           41 unit tests (node:test) — policy, window, scheduler,
                digests + link proofs, config guards
```

The Workshop 1 learning project (scaffolded Counter, 2 tests passing) lives
in `../qday-demo/` — this agent reuses its SDK patterns, not its contract:
no custom contract is needed, because the enforcement is protocol-level
(window + abstract account), which is the point of the category.

## Quickstart

```bash
pnpm install
cp .env.example .env
cp schedule.example.json schedule.json   # fill in REAL payee addresses
node scripts/make-key.mjs               # agent key -> .env (never shown)
node scripts/make-recovery-code.mjs     # QRC1 code -> paste into .env
```

Then (owner steps first — see below) fund the agent, register its PQC key,
and run:

```bash
pnpm status      # read-only: account, PQC key, window, balances, due payments
pnpm plan        # dry-run: verdicts for due payments, signs nothing
pnpm run-once    # one payment cycle (float mode, the default)
pnpm daemon      # run-once every AGENT_TICK_SECONDS (default 60)
pnpm open-window # open a scoped window for the due payments
pnpm close-window
pnpm run-once --mode treasury-direct   # pay from the treasury via MsgExecuteEVM
pnpm link-agent  # build the owner-signed link messages (out/link-messages.json)
```

## Owner-only steps (before the first live payment)

These need the owner's accounts — the agent cannot do them:

1. **Fund the agent** — the agent's throwaway testnet account is
   `0x3Ac5f1ed23B7f2aA6577917c9Dd7B3af1A29f789`
   (`qor18tzlrmfrkle25ethj97fm4an4udznaufmk2uv9`). Claim 100 QOR for it
   at <https://dashboard.qorechain.io/faucet> (dashboard sign-in required,
   1x/24h). Without this, every payment is refused `INSUFFICIENT_FLOAT`
   and the PQC key cannot be registered — the agent fails closed, which is
   the correct behaviour and is already demonstrated in `logs/decisions.jsonl`.
2. **Register the agent's PQC key + open its first window** — the Workshop 1
   flow (`pnpm window register`, then `pnpm window open` in `../qday-demo/`
   with the same `.env`, or `pnpm open-window` here once the key is
   registered). One-time fee ~0.09 QOR.
3. **(Optional, for treasury mode) Link the agent key to your treasury** —
   `TREASURY_ACCOUNT=qor1... pnpm link-agent`, then broadcast the two
   messages with your key (`pnpm link-agent --broadcast` with
   `OWNER_PRIVATE_KEY` / `OWNER_QRC1` in the environment), or broadcast
   `out/link-messages.json` with `qorechaind` / QoreX. This sets the
   spending rule and registers the authenticator in one owner-signed tx.
   Revoke any time with `MsgRevokeAuthenticator`.
4. **Fill in `schedule.json`** with real payee addresses, amounts (uqor)
   and intervals. The example file's addresses are placeholders.
5. **QoreX wallet** (for the fest registration): install the extension,
   create a wallet, keep the 24-word phrase yourself — the agent never
   touches it. Switch to testnet diana (tap the version 7 times →
   "Switch to testnet (diana)").
6. **Fest registration + submission** on <https://build.qorechain.io>:
   GitHub sign-in → form → X connect + follow @QoreChain + post
   `#BuildBeforeQDay` → QoreX connect. Then create the public repo
   (MIT license), push this code, and submit before **2 Dec 2026 23:59 UTC**.

## What is tested

- **41 unit tests, all passing** (`pnpm test`): every policy verdict, window
  sizing + bounds (17,280 blocks / 1,000 txs / 16 targets), schedule/state
  accounting, digest determinism + field binding (v2 EVM digest,
  Cosmos digest), link-proof sign/verify round-trip, EIP-191 execute
  signature recovery, config guards (mainnet refused, bad addresses,
  duplicate payees).
- **Live read-only checks on the testnet** (15 Nov 2026, no funds):
  `abstractaccount` config `enabled: true`, EVM limits
  (`tx_max_gas` 30,000,000), latest block read, `pnpm status` and
  `pnpm plan` against the real REST/EVM endpoints, `pnpm run-once`
  refusing both due payments with `INSUFFICIENT_FLOAT` and logging them.
- **Live on-chain run** (25 Nov 2026, agent funded by the owner):
  the full float flow executed on `qorechain-diana` —
  PQC key registration tx
  `6F5D1FCE744686A1A932CCFBC7175C3A6426989169D6712E606BE41AD5241F18`;
  scoped window opened by tx
  `04F65CFDA2EA83ABEEEB1EB5DADB11268A1AEF21F54E72369A022D5C9A3D841E`
  (window `10727476-10728076`: 600 blocks, 1 tx, 125,000 uqor, single
  allowlisted target); first real payment inside the window —
  100,000 uqor paid, tx
  `0xbbc4d5e1cf080dbec5583b742fe8c54e6afd272f2f9eb36231169d67505955b9`,
  receipt success, window consumed exactly (0 txs / 0 uqor left).
  The live run found and fixed two bugs: a local schedule with two
  entries paying the same address is rejected by the schedule loader
  (`duplicate payee address`), and `sendFloatPayment` passed the raw
  sender address as the viem account, which the node refuses
  ("account unlock with HTTP access is forbidden") — it now signs
  with the wallet client's local account. Tests still 41/41.
- **Not yet tested on-chain**: authenticator link (treasury mode) and
  `MsgExecuteCosmos` execution.

## Known limitations (honest)

- **No swap / DCA.** The docs and testnet show no swap path the agent
  could use, so the agent is scheduled payments only — the simplest
  demoable shape that satisfies every category requirement.
- **Execute-signature form.** The agent signs `MsgExecuteEVM` digests
  EIP-191 (the documented MetaMask flow, replicated with a local key).
  The 33-byte-key raw-signing variant is documented in the code as the
  fallback if the testnet refuses the EIP-191 form on the first live run.
- **Nonce source.** The SDK (0.14.0, matching chain v3.2.8) reads the
  authenticator sequence from `fetchAuthNonce`; the developer-guide page
  still says the EVM nonce for `MsgExecuteEVM`. The agent trusts the SDK
  and reads the sequence live before every authorization — the first
  live run is the arbiter.
- **Relayer.** The agent self-relays its own authorizations (its own
  account pays the envelope fee). In production the owner may run a
  separate relayer; the code path is the same message either way.
- **No contract.** Enforcement is protocol-level (window + abstract
  account). A custom contract would duplicate it and add attack surface.

## License

MIT — see `LICENSE`.
