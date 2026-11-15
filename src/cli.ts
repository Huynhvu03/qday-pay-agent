#!/usr/bin/env node
/**
 * cli.ts — QDay Pay Agent command line.
 *
 *   pnpm status            read-only: account, PQC key, window, balances, due payments
 *   pnpm plan               dry-run: due payments + policy verdicts (signs nothing)
 *   pnpm open-window        open a scoped window sized for the due payments
 *   pnpm close-window       close the agent's window early
 *   pnpm run-once [--mode float|treasury-direct]
 *                           one full payment cycle (default: float mode)
 *   pnpm link [--broadcast] prepare (and optionally broadcast) the owner-signed
 *                           messages that link the agent key to the treasury
 *   pnpm daemon [--mode ...] run run-once every AGENT_TICK_SECONDS
 *
 * Modes:
 *   float (default) — the agent pays plain QOR transfers from its own float
 *     inside a scoped EVM window (allowed_targets = payees, exact tx count
 *     and value cap). The float is topped up from the treasury under the
 *     on-chain spending rules when one is configured.
 *   treasury-direct — each payment is a MsgExecuteEVM authorization signed
 *     by the agent key and self-relayed from the treasury; the window does
 *     not govern this lane, the abstract-account spending rules do.
 *
 * TESTNET ONLY (qorechain-diana, chain ID 9800). No mainnet path exists.
 */
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";

try {
  process.loadEnvFile();
} catch {
  // No .env — commands that need keys will fail with a clear message.
}

import { TESTNET, loadConfig, loadSchedule, uqorToWei } from "./config.js";
import type { UnifiedAccount } from "@qorechain/sdk";
import { agentPrivateKeyHex, loadAgentAccount } from "./keys.js";
import { evaluatePayment, utcDayKey, type WindowSnapshot } from "./policy.js";
import {
  assertPqcKeyRegistered,
  closeWindow,
  fetchPqcRegistered,
  fetchWindow,
  maxFeePerPaymentUqor,
  openScopedWindow,
  planWindow,
  toWindowSnapshot,
  windowId,
} from "./window.js";
import {
  duePayments,
  loadState,
  recordSent,
  saveState,
  spentToday,
  type DuePayment,
} from "./scheduler.js";
import { logDecision } from "./logger.js";
import {
  buildExecuteCosmosAuthorization,
  buildExecuteEvmAuthorization,
  buildLinkMessages,
  fetchAgentAuthNonce,
  fetchTreasuryAccount,
  selfRelay,
} from "./treasury.js";
import { createClients, floatBalanceUqor, sendFloatPayment, waitForReceipt } from "./payments.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function mode(): "float" | "treasury-direct" {
  const m = arg("--mode") ?? "float";
  if (m !== "float" && m !== "treasury-direct") throw new Error(`--mode must be float|treasury-direct, got ${m}`);
  return m;
}

async function fetchTx(hash: string): Promise<{ code: number; events: { type: string; attributes: { key: string; value: string }[] }[] }> {
  const res = await fetch(`${TESTNET.rest}/cosmos/tx/v1beta1/txs/${hash}`);
  if (!res.ok) throw new Error(`tx query failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    tx_response?: { code?: number; events?: { type: string; attributes: { key: string; value: string }[] }[] };
  };
  return {
    code: body.tx_response?.code ?? -1,
    events: body.tx_response?.events ?? [],
  };
}

/** True when a delivered tx's abstract-account execution actually succeeded. */
function executionFailed(events: { type: string }[]): boolean {
  return events.some((e) => e.type === "abstractaccount_execution_failed");
}

async function latestHeight(): Promise<string> {
  const res = await fetch(`${TESTNET.rest}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  const body = (await res.json()) as { block?: { header?: { height?: string } } };
  return body.block?.header?.height ?? "?";
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const acc = await loadAgentAccount();
  console.log(`network:  ${TESTNET.chainId} (EVM ${TESTNET.evmChainId}) — height ${await latestHeight()}`);
  console.log(`agent:    ${acc.evm}  (${acc.cosmos})`);
  console.log(`PQC key:  ${(await fetchPqcRegistered(acc.cosmos)) ? "registered" : "NOT registered (run Workshop 1 flow first)"}`);
  const w = await fetchWindow(acc.cosmos);
  if (!w.found) {
    console.log("window:   none");
  } else {
    console.log(
      `window:   ${w.live ? "live" : "not usable"}; ${w.remainingBlocks} blocks, ${w.remainingTxs} txs, ${w.remainingValue} uqor left; id ${windowId(w)}`,
    );
    if (w.allowedTargets.length > 0) console.log(`          allowed_targets: ${w.allowedTargets.join(", ")}`);
  }
  const key = agentPrivateKeyHex();
  const { publicClient } = createClients(key);
  console.log(`float:    ${await floatBalanceUqor(publicClient, acc.evm as `0x${string}`)} uqor`);
  if (cfg.treasuryAccount) {
    console.log(`treasury: ${cfg.treasuryAccount}`);
    try {
      const rec = (await fetchTreasuryAccount(cfg.treasuryAccount)) as {
        account?: { rules?: unknown; authenticators?: unknown[] };
      };
      console.log(`          rules: ${JSON.stringify(rec.account?.rules ?? rec)}`);
      const { nonce, linked } = await fetchAgentAuthNonce(cfg.treasuryAccount, key);
      console.log(`          agent authenticator: linked=${linked}, sequence=${nonce}`);
    } catch (e) {
      console.log(`          (treasury read failed: ${(e as Error).message})`);
    }
  } else {
    console.log("treasury: (not configured — float-only mode)");
  }
  const schedule = loadSchedule(cfg.scheduleFile);
  const state = loadState(cfg.stateFile);
  const due = duePayments(schedule.payees, state, Math.floor(Date.now() / 1000));
  console.log(`due:      ${due.length} payment(s); spent today (${utcDayKey()}): ${spentToday(state)} uqor`);
  for (const d of due) console.log(`          - ${d.payee.id}: ${d.amountUqor} uqor -> ${d.payee.to}`);
}

async function cmdPlan(): Promise<void> {
  const cfg = loadConfig();
  const acc = await loadAgentAccount();
  const schedule = loadSchedule(cfg.scheduleFile);
  const state = loadState(cfg.stateFile);
  const nowUnix = Math.floor(Date.now() / 1000);
  const due = duePayments(schedule.payees, state, nowUnix);
  if (due.length === 0) {
    console.log("plan: nothing due.");
    return;
  }
  const w = await fetchWindow(acc.cosmos);
  const snapshot: WindowSnapshot | null = w.found ? toWindowSnapshot(w) : null;
  const allowlist = new Set(schedule.payees.map((p) => p.to.toLowerCase()));
  const key = agentPrivateKeyHex();
  const { publicClient } = createClients(key);
  const float = await floatBalanceUqor(publicClient, acc.evm as `0x${string}`);
  console.log(`plan: ${due.length} due payment(s), mode=${mode()}, window=${snapshot ? windowId(snapshot) : "none"}`);
  for (const d of due) {
    const dec = evaluatePayment({
      payment: { id: d.payee.id, to: d.payee.to.toLowerCase(), amountUqor: d.amountUqor },
      allowlist,
      perTxCapUqor: cfg.perTxCapUqor,
      dailyCapUqor: cfg.dailyCapUqor,
      spentTodayUqor: spentToday(state),
      authenticatorExpiryUnix: 0, // plan is keyless: expiry is checked at run time
      nowUnix,
      window: snapshot,
      maxFeePerTxUqor: maxFeePerPaymentUqor(),
      requireWindow: mode() === "float",
      floatBalanceUqor: mode() === "float" ? float : null,
    });
    console.log(`  ${dec.verdict} ${d.payee.id}: ${d.amountUqor} uqor -> ${d.payee.to} — ${dec.reason}`);
  }
  console.log("(dry-run: nothing signed, nothing sent)");
}

async function cmdOpenWindow(): Promise<void> {
  const cfg = loadConfig();
  const acc = await loadAgentAccount();
  await assertPqcKeyRegistered(acc);
  const schedule = loadSchedule(cfg.scheduleFile);
  const state = loadState(cfg.stateFile);
  const due = duePayments(schedule.payees, state, Math.floor(Date.now() / 1000));
  if (due.length === 0) {
    console.log("open-window: nothing due — no window opened.");
    return;
  }
  const plan = planWindow(
    due.map((d) => ({ to: d.payee.to, amountUqor: d.amountUqor })),
    cfg.windowBlocks,
  );
  const { txHash } = await openScopedWindow(acc, plan);
  const w = await fetchWindow(acc.cosmos);
  console.log(`opened: ${txHash}`);
  console.log(`window: ${plan.blocks} blocks, ${plan.maxTxs} txs, ${plan.maxValue} uqor; id ${windowId(w)}`);
  console.log(`targets: ${plan.allowedTargets.join(", ")}`);
}

async function cmdCloseWindow(): Promise<void> {
  const acc = await loadAgentAccount();
  console.log(`closed: ${await closeWindow(acc)}`);
}

async function topUpIfNeeded(input: {
  cfg: ReturnType<typeof loadConfig>;
  acc: UnifiedAccount;
  neededUqor: bigint;
  floatUqor: bigint;
}): Promise<bigint> {
  const { cfg, acc, neededUqor } = input;
  let float = input.floatUqor;
  if (float >= neededUqor || !cfg.treasuryAccount) return float;
  const shortfall = neededUqor - float;
  const topUp = shortfall + 50_000n; // small buffer for envelope fees
  console.log(`top-up: float ${float} uqor < needed ${neededUqor} — requesting ${topUp} uqor from treasury`);
  const key = agentPrivateKeyHex();
  const auth = await buildExecuteCosmosAuthorization({
    treasury: cfg.treasuryAccount,
    relayer: acc.cosmos,
    agentPrivateKey: key,
    toCosmos: acc.cosmos,
    amountUqor: topUp,
  });
  const txHash = await selfRelay(acc, [auth.message]);
  const tx = await fetchTx(txHash);
  if (tx.code !== 0 || executionFailed(tx.events)) {
    console.log(`top-up FAILED: tx ${txHash} code=${tx.code} (execution failed) — payments will be refused`);
    return float;
  }
  console.log(`top-up sent: ${txHash}`);
  await sleep(3000);
  const { publicClient } = createClients(key);
  float = await floatBalanceUqor(publicClient, acc.evm as `0x${string}`);
  console.log(`float after top-up: ${float} uqor`);
  return float;
}

async function runOnce(m: "float" | "treasury-direct"): Promise<void> {
  const cfg = loadConfig();
  const acc = await loadAgentAccount();
  const schedule = loadSchedule(cfg.scheduleFile);
  let state = loadState(cfg.stateFile);
  const nowUnix = Math.floor(Date.now() / 1000);
  const due = duePayments(schedule.payees, state, nowUnix);
  if (due.length === 0) {
    console.log("run-once: nothing due.");
    return;
  }
  const allowlist = new Set(schedule.payees.map((p) => p.to.toLowerCase()));
  const key = agentPrivateKeyHex();
  const { publicClient, walletClient } = createClients(key);

  if (m === "float") {
    // 1. Decide FIRST against the current state (window as-is, float as-is).
    // Refusals are logged and never reach the signing step — and no window
    // is opened (and paid for) when every payment is refused anyway.
    const total = due.reduce((s, d) => s + d.amountUqor + maxFeePerPaymentUqor(), 0n);
    let float = await floatBalanceUqor(publicClient, acc.evm as `0x${string}`);
    float = await topUpIfNeeded({ cfg, acc, neededUqor: total, floatUqor: float });
    const w0 = await fetchWindow(acc.cosmos);
    const snap0: WindowSnapshot | null = w0.found ? toWindowSnapshot(w0) : null;
    const allowed: DuePayment[] = [];
    for (const d of due) {
      const dec = evaluatePayment({
        payment: { id: d.payee.id, to: d.payee.to.toLowerCase(), amountUqor: d.amountUqor },
        allowlist,
        perTxCapUqor: cfg.perTxCapUqor,
        dailyCapUqor: cfg.dailyCapUqor,
        spentTodayUqor: spentToday(state),
        authenticatorExpiryUnix: 0, // float mode pays from the agent's own float
        nowUnix,
        window: snap0,
        maxFeePerTxUqor: maxFeePerPaymentUqor(),
        requireWindow: true,
        floatBalanceUqor: float,
      });
      if (dec.verdict === "REFUSE") {
        console.log(`REFUSE ${d.payee.id}: ${dec.reason}`);
        logDecision(cfg.logFile, {
          decision: "REFUSE",
          reasonCode: dec.reasonCode,
          reason: dec.reason,
          paymentId: d.payee.id,
          to: d.payee.to,
          amountUqor: d.amountUqor.toString(),
          windowId: snap0 ? windowId(snap0) : null,
          limits: dec.limits,
          txHash: null,
          mode: "float",
        });
      } else {
        allowed.push(d);
      }
    }
    if (allowed.length === 0) {
      console.log("run-once: all due payments refused — nothing to send.");
      return;
    }

    // 2. A live window that covers the allowed batch? Open a scoped one if not.
    let w = await fetchWindow(acc.cosmos);
    const allowedTotal = allowed.reduce((s, d) => s + d.amountUqor + maxFeePerPaymentUqor(), 0n);
    const needWindow =
      !w.found ||
      !w.live ||
      w.remainingTxs < BigInt(allowed.length) ||
      w.remainingValue < allowedTotal ||
      (w.allowedTargets.length > 0 &&
        !allowed.every((d) => w.allowedTargets.some((t) => t.toLowerCase() === d.payee.to.toLowerCase())));
    if (needWindow) {
      await assertPqcKeyRegistered(acc);
      const plan = planWindow(
        allowed.map((d) => ({ to: d.payee.to, amountUqor: d.amountUqor })),
        cfg.windowBlocks,
      );
      const opened = await openScopedWindow(acc, plan);
      console.log(`window opened: ${opened.txHash} (${plan.blocks} blocks, ${plan.maxTxs} txs, ${plan.maxValue} uqor)`);
      await sleep(3000);
      w = await fetchWindow(acc.cosmos);
    }
    const wid = windowId(w);

    // 3. Re-decide each allowed payment against the fresh window, then pay.
    for (const d of allowed) {
      const snap = toWindowSnapshot(await fetchWindow(acc.cosmos));
      const currentFloat = await floatBalanceUqor(publicClient, acc.evm as `0x${string}`);
      const dec = evaluatePayment({
        payment: { id: d.payee.id, to: d.payee.to.toLowerCase(), amountUqor: d.amountUqor },
        allowlist,
        perTxCapUqor: cfg.perTxCapUqor,
        dailyCapUqor: cfg.dailyCapUqor,
        spentTodayUqor: spentToday(state),
        authenticatorExpiryUnix: 0, // float mode pays from the agent's own float
        nowUnix,
        window: snap,
        maxFeePerTxUqor: maxFeePerPaymentUqor(),
        requireWindow: true,
        floatBalanceUqor: currentFloat,
      });
      if (dec.verdict === "REFUSE") {
        console.log(`REFUSE ${d.payee.id}: ${dec.reason}`);
        logDecision(cfg.logFile, {
          decision: "REFUSE",
          reasonCode: dec.reasonCode,
          reason: dec.reason,
          paymentId: d.payee.id,
          to: d.payee.to,
          amountUqor: d.amountUqor.toString(),
          windowId: wid,
          limits: dec.limits,
          txHash: null,
          mode: "float",
        });
        continue;
      }
      try {
        const hash = await sendFloatPayment({
          walletClient,
          from: acc.evm as `0x${string}`,
          to: d.payee.to as `0x${string}`,
          amountUqor: d.amountUqor,
        });
        const ok = await waitForReceipt(publicClient, hash);
        if (!ok) throw new Error(`tx ${hash} reverted on-chain`);
        console.log(`PAID ${d.payee.id}: ${d.amountUqor} uqor -> ${d.payee.to} (${hash})`);
        logDecision(cfg.logFile, {
          decision: "ALLOW",
          reasonCode: "OK",
          reason: dec.reason,
          paymentId: d.payee.id,
          to: d.payee.to,
          amountUqor: d.amountUqor.toString(),
          windowId: wid,
          limits: dec.limits,
          txHash: hash,
          mode: "float",
        });
        state = recordSent(state, d.payee.id, d.amountUqor, hash, Math.floor(Date.now() / 1000));
        saveState(cfg.stateFile, state);
      } catch (e) {
        const msg = (e as Error).message;
        console.log(`FAILED ${d.payee.id}: ${msg}`);
        logDecision(cfg.logFile, {
          decision: "REFUSE",
          reasonCode: "WINDOW_VALUE_EXHAUSTED",
          reason: `send failed: ${msg}`,
          paymentId: d.payee.id,
          to: d.payee.to,
          amountUqor: d.amountUqor.toString(),
          windowId: wid,
          limits: dec.limits,
          txHash: null,
          mode: "float",
        });
      }
    }
    return;
  }

  // ---- treasury-direct mode ----
  if (!cfg.treasuryAccount) {
    throw new Error("treasury-direct mode needs TREASURY_ACCOUNT in .env");
  }
  const treasury = cfg.treasuryAccount;
  // Authenticator expiry, read from the treasury record when available.
  let expiryUnix = 0;
  try {
    const rec = (await fetchTreasuryAccount(treasury)) as {
      account?: { authenticators?: { expiry?: string; pubkey?: string }[] };
    };
    const agentAddr = acc.evm.toLowerCase();
    const auth = rec.account?.authenticators?.find(
      (a) => a.pubkey?.toLowerCase().includes(agentAddr.slice(2)),
    );
    if (auth?.expiry) expiryUnix = Number(auth.expiry);
  } catch {
    // Unknown expiry: the chain still enforces it; the local check is skipped.
  }
  for (const d of due) {
    const dec = evaluatePayment({
      payment: { id: d.payee.id, to: d.payee.to.toLowerCase(), amountUqor: d.amountUqor },
      allowlist,
      perTxCapUqor: cfg.perTxCapUqor,
      dailyCapUqor: cfg.dailyCapUqor,
      spentTodayUqor: spentToday(state),
      authenticatorExpiryUnix: expiryUnix,
      nowUnix,
      window: null,
      maxFeePerTxUqor: 0n,
      requireWindow: false,
      floatBalanceUqor: null,
    });
    if (dec.verdict === "REFUSE") {
      console.log(`REFUSE ${d.payee.id}: ${dec.reason}`);
      logDecision(cfg.logFile, {
        decision: "REFUSE",
        reasonCode: dec.reasonCode,
        reason: dec.reason,
        paymentId: d.payee.id,
        to: d.payee.to,
        amountUqor: d.amountUqor.toString(),
        windowId: null,
        limits: dec.limits,
        txHash: null,
        mode: "treasury-direct",
      });
      continue;
    }
    try {
      const auth = await buildExecuteEvmAuthorization({
        treasury,
        relayer: acc.cosmos,
        agentPrivateKey: key,
        to: d.payee.to,
        amountUqor: d.amountUqor,
      });
      const txHash = await selfRelay(acc, [auth.message]);
      const tx = await fetchTx(txHash);
      if (tx.code !== 0 || executionFailed(tx.events)) {
        throw new Error(`relay tx ${txHash} code=${tx.code} (execution failed — see abstractaccount_execution_failed)`);
      }
      console.log(`PAID ${d.payee.id}: ${d.amountUqor} uqor -> ${d.payee.to} (relay ${txHash})`);
      logDecision(cfg.logFile, {
        decision: "ALLOW",
        reasonCode: "OK",
        reason: dec.reason,
        paymentId: d.payee.id,
        to: d.payee.to,
        amountUqor: d.amountUqor.toString(),
        windowId: null,
        limits: dec.limits,
        txHash,
        mode: "treasury-direct",
      });
      state = recordSent(state, d.payee.id, d.amountUqor, txHash, Math.floor(Date.now() / 1000));
      saveState(cfg.stateFile, state);
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`FAILED ${d.payee.id}: ${msg}`);
      logDecision(cfg.logFile, {
        decision: "REFUSE",
        reasonCode: "WINDOW_VALUE_EXHAUSTED",
        reason: `treasury-direct execution failed: ${msg}`,
        paymentId: d.payee.id,
        to: d.payee.to,
        amountUqor: d.amountUqor.toString(),
        windowId: null,
        limits: dec.limits,
        txHash: null,
        mode: "treasury-direct",
      });
    }
  }
}

async function cmdLink(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.treasuryAccount) throw new Error("link needs TREASURY_ACCOUNT in .env (the owner's account)");
  const acc = await loadAgentAccount();
  const key = agentPrivateKeyHex();
  const expiryUnix = Math.floor(Date.now() / 1000) + cfg.authExpiryDays * 86400;
  const { messages, proofBase64 } = buildLinkMessages({
    owner: cfg.treasuryAccount,
    treasury: cfg.treasuryAccount,
    agentPrivateKey: key,
    perTxCapUqor: cfg.perTxCapUqor,
    dailyCapUqor: cfg.dailyCapUqor,
    expiryUnix,
  });
  console.log("Link the agent key to the treasury (owner-signed, one tx):");
  console.log(`  owner/treasury: ${cfg.treasuryAccount}`);
  console.log(`  agent address:  ${acc.evm}`);
  console.log(`  permissions:    evm, send`);
  console.log(`  expiry:         ${new Date(expiryUnix * 1000).toISOString()} (${cfg.authExpiryDays} days)`);
  console.log(`  rule:           per-tx ${cfg.perTxCapUqor} uqor, daily ${cfg.dailyCapUqor} uqor, denoms [uqor]`);
  console.log(`  proof (base64): ${proofBase64.slice(0, 24)}…`);
  console.log(`  messages:       ${messages.map((m) => m.typeUrl).join(", ")}`);
  mkdirSync("out", { recursive: true });
  // The SDK composers return message OBJECTS (encoded by the registry at
  // broadcast); serialize Uint8Array fields as base64 for the JSON file.
  const toJson = (v: unknown): unknown => {
    if (v instanceof Uint8Array) return { __base64: Buffer.from(v).toString("base64") };
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(toJson);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toJson(x)]));
    }
    return v;
  };
  writeFileSync(
    "out/link-messages.json",
    JSON.stringify(
      {
        owner: cfg.treasuryAccount,
        treasury: cfg.treasuryAccount,
        agentAddress: acc.evm,
        permissions: ["evm", "send"],
        expiryUnix,
        spendingRule: {
          id: "qday-pay-agent",
          perTxCapUqor: cfg.perTxCapUqor.toString(),
          dailyCapUqor: cfg.dailyCapUqor.toString(),
        },
        messages: messages.map((m) => ({ typeUrl: m.typeUrl, value: toJson(m.value) })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log("Wrote out/link-messages.json — broadcast it with the OWNER's key:");
  console.log("  OWNER_PRIVATE_KEY=0x... OWNER_QRC1=QRC1... pnpm link --broadcast");
  if (arg("--broadcast")) {
    const ownerKey = process.env.OWNER_PRIVATE_KEY?.trim();
    const ownerCode = process.env.OWNER_QRC1?.trim();
    if (!ownerKey || !/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) {
      throw new Error("link --broadcast needs OWNER_PRIVATE_KEY in the environment");
    }
    if (!ownerCode) throw new Error("link --broadcast needs OWNER_QRC1 in the environment");
    // Broadcast with the owner's identity (same shape as the agent's own key loading).
    const { unifiedAccountFromSeed, isValidRecoveryCode } = await import("@qorechain/sdk");
    if (!isValidRecoveryCode(ownerCode)) throw new Error("OWNER_QRC1 is not a valid QRC1 code");
    const ownerAcc = unifiedAccountFromSeed(Uint8Array.from(Buffer.from(ownerKey.slice(2), "hex")), {
      recoveryCode: ownerCode,
    });
    if (ownerAcc.cosmos !== cfg.treasuryAccount) {
      throw new Error(
        `OWNER_PRIVATE_KEY belongs to ${ownerAcc.cosmos}, not the treasury ${cfg.treasuryAccount} — refusing to broadcast`,
      );
    }
    const txHash = await selfRelay(ownerAcc, messages);
    console.log(`linked: ${txHash}`);
    console.log(`verify: curl ${TESTNET.rest}/qorechain/abstractaccount/v1/accounts/${cfg.treasuryAccount}`);
  }
}

async function cmdDaemon(m: "float" | "treasury-direct"): Promise<void> {
  const cfg = loadConfig();
  console.log(`daemon: mode=${m}, tick=${cfg.tickSeconds}s — Ctrl+C to stop`);
  for (;;) {
    try {
      await runOnce(m);
    } catch (e) {
      console.error(`daemon tick failed: ${(e as Error).message}`);
    }
    await sleep(cfg.tickSeconds * 1000);
  }
}

const cmd = process.argv[2] ?? "status";
const commands: Record<string, () => Promise<void>> = {
  status: cmdStatus,
  plan: cmdPlan,
  "open-window": cmdOpenWindow,
  "close-window": cmdCloseWindow,
  "run-once": () => runOnce(mode()),
  link: cmdLink,
  daemon: () => cmdDaemon(mode()),
};
const run = commands[cmd];
if (!run) {
  console.error(`Unknown command "${cmd}". Use: status | plan | open-window | close-window | run-once | link | daemon`);
  process.exit(1);
}
run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
