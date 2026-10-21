// Delivery of a coin spend to stream-api POST /chat/event, with the refund
// decision made HONESTLY.
//
// Refunding on any falsy/!ok result (`streamApiFetch(...).catch(() => null)`)
// is wrong: the 10s deadline aborts the WAIT, not stream-api's WORK, so a slow
// DB would let the handler credit the ledger/bar/timer while this side refunds
// the coins. Both ends would credit, on every concurrent spend, for the stall's
// duration.
//
// Four outcomes; only `refused` and `undelivered` may refund:
//   delivered    — 2xx (including a deduped replay of the first delivery).
//   refused      — stream-api ANSWERED with a refusal that provably credited
//                  nothing: 4xx validation, or `effects_failed`, whose
//                  handler documents that an escaping throw can only mean
//                  "nothing was credited".
//   undelivered  — the request never left (connection refused / DNS). Nothing
//                  exists on the other side to double-credit.
//   unconfirmed  — timeout, 409 in_flight, or an unclassifiable 5xx (the
//                  crash may sit AFTER the credit). NO refund: refunding an
//                  unconfirmed spend is exactly the double-credit. The
//                  recorded spendId outcome on stream-api keeps a later
//                  manual refund safe if the effect truly never ran.
//                  `ledgerPending`: stream-api's 503 `ledger_unavailable` — its
//                  ledger could not record a money event (nothing fired, the
//                  event may be kept for reconciliation, the spendId released).
//                  Never refunded; broadcastChatEvent RETRIES it.
//
// A timeout gets ONE immediate retry before landing in unconfirmed — legal
// only because /chat/event dedups on `spendId` (the spend's coin-ledger ref)
// and replays the original outcome verbatim. A payload without a spendId is
// never retried: an id-less retry would re-RUN the effect, not replay it.
//
// Server-only (rides streamApi.ts and its secret).

import { streamApiFetch } from "./streamApi.ts";
import { networkFailureKind } from "./http.ts";

export type ChatEventOutcome =
  | { outcome: "delivered"; body: Record<string, unknown> }
  | { outcome: "refused"; status: number; body: Record<string, unknown> }
  | { outcome: "undelivered" }
  | { outcome: "unconfirmed"; ledgerPending?: true; inFlight?: true };

type SpendEventPayload = Record<string, unknown> & { kind: string; spendId?: string };

async function attempt(payload: SpendEventPayload): Promise<ChatEventOutcome> {
  const res = await streamApiFetch("/chat/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { outcome: "delivered", body };
  if (res.status === 409) return { outcome: "unconfirmed", inFlight: true };
  if (res.status === 503 && body.error === "ledger_unavailable") return { outcome: "unconfirmed", ledgerPending: true };
  if (res.status >= 500 && body.error !== "effects_failed") return { outcome: "unconfirmed" };
  return { outcome: "refused", status: res.status, body };
}

export async function deliverChatEvent(payload: SpendEventPayload): Promise<ChatEventOutcome> {
  try {
    return await attempt(payload);
  } catch (err) {
    const kind = networkFailureKind(err);
    if (kind === "unreachable") return { outcome: "undelivered" };
    if (kind !== "timeout") throw err; // an unrelated bug must reach the error sink, not wear a refund
    if (!payload.spendId) return { outcome: "unconfirmed" };
    try {
      return await attempt(payload);
    } catch (err2) {
      const kind2 = networkFailureKind(err2);
      // A second deadline: stream-api is most likely still holding the event for its ledger.
      if (kind2 === "timeout") return { outcome: "unconfirmed", inFlight: true };
      if (kind2) return { outcome: "unconfirmed" };
      throw err2;
    }
  }
}

// ── Billing celebrations ─────────────────────────────────────────────────────
//
// The Stripe webhook's donation/sub/gift cards are what write support_events
// and move the bar for NATIVE money — they are not decoration. A single-shot
// `.catch(() => undefined)` would let one lost during a stream-api restart leave
// the bar permanently short on real money: site.donations stays durable,
// nothing flags the gap, and Stripe's own redelivery is useless here because
// the recording routes dedup on the session id and return before re-announcing.
//
// So the retry has to be LOCAL, and it is legal only because every payload
// carries a Stripe-derived spendId (`donation:<session>` / `sub:<subId>` /
// `gift:<session>`) that /chat/event's outcome store dedups on.
//
// Retry policy mirrors the spend classifier above:
//   undelivered → retry with backoff. The request never left; this is exactly
//                 the restart window the loss lives in, and re-sending is safe.
//   refused     → stop. A 4xx is a payload bug; retrying a refusal on a money
//                 path is illegal (postAlert rule: 4xx never).
//   unconfirmed → stop. deliverChatEvent already spent its one deduped retry;
//                 blocking the webhook for more 10s deadlines buys little —
//                 EXCEPT `ledgerPending` (stream-api's ledger refused the write and
//                 released the spendId): retried like undelivered, never refunded.
// A payload without a spendId gets ONE attempt — a blind retry can re-run.
//
// Never throws: a celebration must not 500 the webhook that already recorded
// the money. Every final line says what is KNOWN — spendId in the journal is the
// recovery handle (replay the event id against /chat/event by hand):
//   LOST          refused (nothing was credited) or never delivered.
//   NOT CREDITED  ledger_unavailable to the end: stream-api's ledger refused it and kept it, when it
//                 could, as 'ledger_failed' in stream.unpriced_support for /support/reconcile.
//   UNCONFIRMED   an unclassifiable 5xx, or still in flight when patience ran out: stream-api MAY
//                 have credited it — check its journal for the spendId before re-posting.
//
// Still IN FLIGHT (a deadline, or 409 in_flight): stream-api holds a money event until its ledger
// answers and retries a failed write for ~108 s (alert.js LEDGER_RETRY_MS × LEDGER_MAX_ATTEMPTS),
// far past this side's 10 s deadline, so "LOST" there would be wrong for payments
// that then land. The webhook is not held for that: a background follow-up re-asks with the same
// spendId (deduped: 409 while it works, the original outcome once it is done) on the
// CELEBRATION_FOLLOW_UP_MS schedule, which outlasts that window (chatEventDelivery.test.ts derives
// the bound from alert.js). A crash of THIS process during the follow-up loses only the log line —
// stream-api finishes the work either way.
const CELEBRATION_BACKOFF_MS = [1_000, 3_000];

/** @test-only exported so chatEventDelivery.test.ts can hold its total above stream-api's ledger
 *  retry window. Gaps between the background follow-up's re-asks: 300 s in all. */
export const CELEBRATION_FOLLOW_UP_MS: readonly number[] = [5_000, 10_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];

type CelebrationOpts = {
  sleep?: (ms: number) => Promise<void>;
  /** Where the in-flight follow-up runs; default: detached (never awaited by the webhook). */
  background?: (p: Promise<void>) => void;
};

function logFinal(outcome: string, event: SpendEventPayload): void {
  const spend = event.spendId ?? "(none)";
  if (outcome === "delivered_late") {
    console.warn("[billing] money celebration landed LATE (stream-api's ledger was slow) — kind=%s spendId=%s", event.kind, spend);
  } else if (outcome === "ledger_unavailable") {
    console.error(
      "[billing] money celebration NOT CREDITED — stream-api's ledger refused it to the end; it is kept as 'ledger_failed' in stream.unpriced_support when the database took even that.",
      "kind=%s spendId=%s (recovery: POST /support/reconcile, or re-POST /chat/event with this spendId)", event.kind, spend);
  } else if (outcome.startsWith("unconfirmed") || outcome === "error") {
    console.error(
      "[billing] money celebration UNCONFIRMED — stream-api MAY have credited it.",
      "outcome=%s kind=%s spendId=%s (check stream-api's journal for this spendId before re-POSTing /chat/event; the outcome store dedups a re-post while it lives)",
      outcome, event.kind, spend);
  } else {
    console.error(
      "[billing] LOST money celebration — the bar/support_events were NOT credited for a recorded payment.",
      "outcome=%s kind=%s spendId=%s (recovery: re-POST /chat/event with this spendId; the outcome store dedups it)",
      outcome, event.kind, spend);
  }
}

async function followUp(event: SpendEventPayload, sleep: (ms: number) => Promise<void>): Promise<void> {
  let last = "unconfirmed_in_flight";
  for (const gap of CELEBRATION_FOLLOW_UP_MS) {
    await sleep(gap);
    try {
      const out = await deliverChatEvent(event);
      if (out.outcome === "delivered") { logFinal("delivered_late", event); return; }
      if (out.outcome === "refused") { logFinal(`refused_${out.status}`, event); return; }
      last = out.outcome === "unconfirmed" && out.ledgerPending ? "ledger_unavailable"
        : out.outcome === "unconfirmed" && out.inFlight ? "unconfirmed_in_flight"
        : out.outcome;
      // An unclassifiable 5xx: the crash may sit after the credit — re-asking learns nothing more.
      if (out.outcome === "unconfirmed" && !out.inFlight && !out.ledgerPending) break;
    } catch {
      last = "error";
      break;
    }
  }
  logFinal(last, event);
}

export async function broadcastChatEvent(
  event: SpendEventPayload,
  opts?: CelebrationOpts,
): Promise<void> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = event.spendId ? CELEBRATION_BACKOFF_MS.length + 1 : 1;
  let finalOutcome = "error";
  let inFlight = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await deliverChatEvent(event);
      if (out.outcome === "delivered") return;
      finalOutcome = out.outcome === "refused" ? `refused_${out.status}` : out.outcome;
      if (out.outcome === "unconfirmed" && out.ledgerPending) finalOutcome = "ledger_unavailable";
      inFlight = out.outcome === "unconfirmed" && !!out.inFlight;
      if (out.outcome !== "undelivered" && !(out.outcome === "unconfirmed" && out.ledgerPending)) break;
    } catch {
      break; // an unrelated bug — logged below with the spendId, never rethrown
    }
    if (i < attempts - 1) await sleep(CELEBRATION_BACKOFF_MS[i]!);
  }
  if (inFlight && event.spendId) {
    const p = followUp(event, sleep).catch((e: unknown) => {
      console.error("[billing] celebration follow-up failed — spendId=%s: %s", event.spendId, e instanceof Error ? e.message : String(e));
    });
    if (opts?.background) opts.background(p); else void p;
    return;
  }
  logFinal(finalOutcome, event);
}
