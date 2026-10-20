// PayPal webhook handlers. Injectable-pool factory, the SAME shape as
// paymentEventHandlers.ts: `@/lib/db` opens a real pg.Pool that plain
// `node --test` cannot resolve, so this file takes `pool` as a dependency and
// binds a production singleton at the bottom over the RELATIVE
// `../../lib/db.ts` import (Next's bundler resolves that and the `@/lib/db`
// alias to the exact same module — only `node --test`'s lack of a bundler
// cares about the difference).
//
// getChatIdentity (chatIdentity.ts) is an INJECTED dependency (`deps.getChatIdentity`),
// not a static import. chatIdentity.ts itself imports `@/lib/db` at module
// scope, and a static import of it here would make importing this whole file
// — including the idempotency guard and the refund/dispute recording, none of
// which touch identity at all — unloadable under `node --test`. It runs for
// EVERY signed-in, non-anonymous tip (colour + style always come from it;
// the stored display_name only wins the label), so it needs a REAL test, not
// a source scan. Making it an injectable dependency — defaulting to a lazy
// wrapper around the real module — lets the fake-pool tests drive it directly
// while keeping the module always loadable: the dynamic import inside
// `realGetChatIdentity` below is never evaluated unless something actually
// CALLS it, so a test that injects its own `getChatIdentity` never touches
// chatIdentity.ts at all.
import type { Pool } from "pg";
import { extractPaypalCapture } from "./paypalCapture.ts";
import { broadcastChatEvent } from "./chatEventDelivery.ts";
import { createPaymentEventsServer } from "./paymentEventsServer.ts";
import { moneyCredits, type MoneyCredits } from "./coinsServer.ts";
import { pointsOrderKey } from "./paypalPointsOrder.ts";
import pool from "../../lib/db.ts";

type PaypalWebhookEvent = { id: string; event_type: string; create_time: string; resource: unknown };

type ChatIdentityResult = { username: string; usernameColor: string | null; usernameStyle: object | null };
type GetChatIdentity = (matrixId: string) => Promise<ChatIdentityResult>;

/** The production default for `deps.getChatIdentity` — see the module header
 *  for why the import inside it must stay dynamic and deferred to call time. */
async function realGetChatIdentity(matrixId: string): Promise<ChatIdentityResult> {
  const { getChatIdentity } = await import("./chatIdentity.ts");
  return getChatIdentity(matrixId);
}

// ── Ruling 1: refunds and disputes carry NO custom_id — the capture id is the
// only join key, and it lives in a different place on each resource shape.

/** The `rel === "up"` link on a PAYMENT.CAPTURE.REFUNDED resource points at
 *  the capture it refunds: `.../v2/payments/captures/<CAPTURE_ID>`. */
export function captureIdFromRefund(resource: unknown): string | null {
  const links = (resource as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    const link = l as { rel?: unknown; href?: unknown } | null;
    if (!link || link.rel !== "up" || typeof link.href !== "string") continue;
    const m = /\/v2\/payments\/captures\/([^/?]+)\/?$/.exec(link.href);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** CUSTOMER.DISPUTE.RESOLVED's capture id is
 *  disputed_transactions[0].seller_transaction_id. */
export function captureIdFromDispute(resource: unknown): string | null {
  const txs = (resource as { disputed_transactions?: unknown } | null)?.disputed_transactions;
  const first = Array.isArray(txs) ? (txs[0] as { seller_transaction_id?: unknown } | null) : null;
  const id = first?.seller_transaction_id;
  return typeof id === "string" && id ? id : null;
}

/** A refund/dispute amount arrives as a decimal string. Unlike
 *  paypalCapture.ts's parsePositiveUsd, a malformed amount here must not
 *  block recording the event (Ruling 4) — it degrades to null instead. */
export function parsePositiveCents(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

function lowerCurrency(v: unknown): string | null {
  return typeof v === "string" && v ? v.toLowerCase() : null;
}

/** @parked consumed by the production binding below and by
 *  paypalWebhookHandlers.test.ts; exported so the test can drive a fake pool
 *  (and a fake getChatIdentity), the same shape as paymentEventHandlers.ts's
 *  createPaymentEventHandlers. `getChatIdentity` is optional: tests with
 *  no signed-in, non-anonymous tip never reach it. `credits`
 *  is REQUIRED, same as paymentEventHandlers.ts's `MoneyCredits` dep — every
 *  test construction must pass a fake, never the production `moneyCredits`
 *  singleton, which opens a real pool. */
export function createPaypalWebhookHandlers(deps: { pool: Pool; getChatIdentity?: GetChatIdentity; credits: MoneyCredits }) {
  const { recordPaymentEvent } = createPaymentEventsServer(deps);
  const getChatIdentity = deps.getChatIdentity ?? realGetChatIdentity;

  /** Who paid for a capture, and what it bought — for the payment_events row
   *  of a later refund/dispute/reversal (which carry NO custom_id). A tip is
   *  found in site.donations by provider_ref; a quiet Qorm purchase in
   *  site.paypal_coin_orders by capture_id. Unknown → matrix_id null, kind
   *  donation. */
  async function captureOwner(captureId: string): Promise<{ matrixId: string | null; kind: "donation" | "coin_purchase" }> {
    const tip = await deps.pool.query<{ matrix_id: string | null }>(
      `SELECT matrix_id FROM site.donations WHERE provider = 'paypal' AND provider_ref = $1`,
      [captureId],
    );
    if (tip.rows[0]) return { matrixId: tip.rows[0].matrix_id ?? null, kind: "donation" };
    const points = await deps.pool.query<{ matrix_id: string }>(
      `SELECT matrix_id FROM site.paypal_coin_orders WHERE capture_id = $1`,
      [captureId],
    );
    if (points.rows[0]) return { matrixId: points.rows[0].matrix_id, kind: "coin_purchase" };
    return { matrixId: null, kind: "donation" };
  }

  /** A quiet Qorm purchase captured. Credit BEFORE the completing UPDATE (same
   *  reason as the tip path below: a failed credit + PayPal retry must still
   *  credit; recordPurchaseCredit is idempotent on ref). No site.donations
   *  row, no broadcastChatEvent — a purchase is never on stream and never
   *  moves the bar. A missing order row is money we cannot place: throw, so
   *  PayPal retries and the failure stays visible in their dashboard. */
  async function completePointsOrder(cap: { captureId: string; externalId: string; grossUsd: number; currency: string }): Promise<void> {
    const externalId = cap.externalId;
    const captured = Math.round(cap.grossUsd * 100);
    const { rows } = await deps.pool.query<{ matrix_id: string; amount_cents: number }>(
      `SELECT matrix_id, amount_cents FROM site.paypal_coin_orders WHERE external_id = $1`,
      [externalId],
    );
    const orderRow = rows[0];
    if (!orderRow) throw new Error(`paypal capture ${cap.captureId}: no points order for it`);
    if (captured !== orderRow.amount_cents) {
      console.warn(
        "[paypal] points capture differs from the order — capture=%s ordered_cents=%d captured_cents=%d",
        cap.captureId, orderRow.amount_cents, captured,
      );
    }
    // Defensive floor, same as the tip path: extractPaypalCapture already
    // refuses non-USD, so this is unreachable.
    if (cap.currency !== "USD") {
      console.error("[paypal] non-USD points capture — skipping credit:", cap.captureId);
    } else {
      await deps.credits.recordPurchaseCredit({
        matrixId: orderRow.matrix_id,
        cents: Math.min(captured, orderRow.amount_cents),
        ref: `paypal:${cap.captureId}`,
        payment: { provider: "paypal", captureId: cap.captureId },
      });
    }
    await deps.pool.query(
      `UPDATE site.paypal_coin_orders
          SET status = 'completed', capture_id = $2, completed_at = NOW()
        WHERE external_id = $1 AND status = 'pending'`,
      [externalId, cap.captureId],
    );
  }

  /** Ruling 5. The idempotency guard is the WHERE clause (status='pending');
   *  the CTE exists only to log an honest warning if PayPal captured a
   *  different amount than the order asked for — Postgres RETURNING on an
   *  UPDATE reflects the NEW row, so reading the pre-update amount needs a
   *  snapshot taken before the UPDATE runs, in the same statement. */
  async function onCaptureCompleted(event: PaypalWebhookEvent): Promise<void> {
    const cap = extractPaypalCapture(event);
    // Ruling 4: an unreadable capture is a 500, never a silent 200 — money
    // arrived that we could not read; PayPal must retry and the failed
    // delivery must stay visible in their dashboard. extractPaypalCapture has
    // already logged the reason loudly — this throw does not repeat the payload.
    if (!cap.ok) throw new Error(`paypal capture extraction failed: ${cap.reason}`);
    if (!cap.customId) throw new Error(`paypal capture ${cap.captureId} carries no custom_id`);
    const pointsKey = pointsOrderKey(cap.customId);
    if (pointsKey !== null) return completePointsOrder({ ...cap, externalId: pointsKey });

    const cents = Math.round(cap.grossUsd * 100);

    // Qorm for the tip — read the donation row and credit BEFORE the
    // completing UPDATE below, not after. Crediting after the UPDATE breaks
    // retries: if the credit throws, this handler rejects, the webhook 500s,
    // PayPal retries, the completing UPDATE below now matches zero rows
    // (status is no longer 'pending'), and the handler would return early — so
    // the tip would never be announced on stream and never credit the support
    // bar (broadcastChatEvent does both of those, not this). Reading the row
    // and crediting first means a retry after a credit failure still reaches
    // the UPDATE and the celebration. recordTipCredit is idempotent on `ref`,
    // so a retry re-running it (a successful credit, redelivered anyway) is
    // harmless. Signed-in only — anonymous still pays; `anonymous` only hides
    // the name on stream, it does not change who gets paid.
    const { rows: donationRows } = await deps.pool.query<{ matrix_id: string | null }>(
      `SELECT matrix_id FROM site.donations WHERE external_id = $1 AND provider = 'paypal'`,
      [cap.customId],
    );
    const donorMatrixId = donationRows[0]?.matrix_id ?? null;
    if (donorMatrixId) {
      // Unreachable — extractPaypalCapture above already refuses a capture
      // whose currency isn't exactly USD, so `cap.currency` is always "USD"
      // here. Kept as a defensive floor, same shape as
      // paymentEventHandlers.ts's non-USD guards: never let a future
      // relaxation of that check silently mint Qorm at the wrong exchange rate.
      if (cap.currency === "USD") {
        await deps.credits.recordTipCredit({
          matrixId: donorMatrixId, cents, ref: `paypal:${cap.captureId}`,
          payment: { provider: "paypal", captureId: cap.captureId },
        });
      } else {
        console.error("[paypal] non-USD capture — skipping points credit:", cap.captureId);
      }
    }

    const { rows } = await deps.pool.query(
      `WITH old AS (
         SELECT amount_cents FROM site.donations
          WHERE external_id = $1 AND provider = 'paypal' AND status = 'pending'
       )
       UPDATE site.donations
          SET status = 'completed', provider_ref = $2, amount_cents = $3
        WHERE external_id = $1 AND provider = 'paypal' AND status = 'pending'
       RETURNING id, matrix_id, display_name, message, anonymous,
                 (SELECT amount_cents FROM old) AS ordered_cents`,
      [cap.customId, cap.captureId, cents],
    );
    if (rows.length === 0) {
      // No order of ours carries this custom_id (e.g. one opened under a retired prefix): the money
      // arrived and nothing will credit it. A retry cannot help, so log loudly for a by-hand payout.
      if (donationRows.length === 0) {
        console.error(`[paypal] capture ${cap.captureId} matched no order (custom_id ${cap.customId}) — pay by hand`);
      }
      return; // otherwise a retry, a duplicate, or a row already completed — never celebrate twice
    }

    const row = rows[0] as {
      id: number;
      matrix_id: string | null;
      display_name: string | null;
      message: string | null;
      anonymous: boolean;
      ordered_cents: number | null;
    };

    // Diagnostic only — never blocks or adjusts the recorded amount.
    // amount_cents above is already what PayPal actually captured (Ruling 5:
    // "the ledger records money that moved, not money that was asked for").
    if (row.ordered_cents != null && row.ordered_cents !== cents) {
      console.warn(
        "[paypal] captured amount differs from the ordered amount — capture=%s ordered_cents=%d captured_cents=%d",
        cap.captureId, row.ordered_cents, cents,
      );
    }

    // Donor label from the returned display_name, falling back to
    // getChatIdentity's username when blank — never from the PayPal payload.
    // Colour and style come from getChatIdentity for EVERY signed-in,
    // non-anonymous donor (app/api/billing/webhook/route.ts does the same):
    // gating the lookup on a blank name would send every named tipper out unstyled.
    let donor = row.display_name;
    let usernameColor: string | null = null;
    let usernameStyle: object | null = null;
    if (!row.anonymous && row.matrix_id) {
      const identity = await getChatIdentity(row.matrix_id);
      donor = donor || identity.username;
      usernameColor = identity.usernameColor;
      usernameStyle = identity.usernameStyle;
    }

    await broadcastChatEvent({
      kind: "donation",
      // /chat/event dedups on this — a redelivered PAYMENT.CAPTURE.COMPLETED
      // never re-celebrates (the UPDATE above already returned 0 rows for it).
      spendId: `donation:paypal:${cap.captureId}`,
      donor: row.anonymous ? "Anonymous" : donor || "Anonymous",
      donorMatrixId: row.anonymous ? null : row.matrix_id,
      anonymous: row.anonymous,
      amount: cents,
      currency: cap.currency.toLowerCase(),
      message: row.message,
      netUsd: cap.netUsd, // already net of paypal_fee AND platform_fees[] — never capped, never recomputed
      usernameColor,
      usernameStyle,
    });
  }

  /** The Qorm this capture's tip credited is taken back (clawback) — badges
   *  and the support bar are NOT touched, and nothing on stream is reversed
   *  by a refund. `refunded_at IS NULL` makes a redelivery a no-op for the
   *  refunded_at stamp; the clawback itself is independently idempotent on
   *  the refund id (`paypal:refund:<id>`), so a redelivery is harmless there
   *  too. */
  async function onCaptureRefunded(event: PaypalWebhookEvent): Promise<void> {
    const resource = event.resource as { amount?: { value?: unknown; currency_code?: unknown } | null } | null;
    const captureId = captureIdFromRefund(event.resource);
    if (!captureId) {
      // Ruling 4 — the OPPOSITE of onCaptureCompleted: a refund is not money
      // arriving, so losing the retry loses nothing the recorded row and this
      // log line don't already carry. Record and return, never throw.
      console.error(
        "[paypal] refund %s carries no capture id in resource.links (rel=up) — recording with matrix_id null",
        event.id,
      );
    }

    const owner = captureId ? await captureOwner(captureId) : { matrixId: null, kind: "donation" as const };

    await recordPaymentEvent({
      provider: "paypal",
      eventId: event.id,
      eventType: event.event_type,
      occurredAt: new Date(event.create_time),
      chargeId: captureId,
      matrixId: owner.matrixId,
      kind: owner.kind, // a capture is a tip or (Piece 2) a quiet Qorm purchase
      amountCents: parsePositiveCents(resource?.amount?.value),
      currency: lowerCurrency(resource?.amount?.currency_code),
      outcome: "refunded",
    });

    if (captureId) {
      await deps.pool.query(
        `UPDATE site.donations SET refunded_at = NOW()
          WHERE provider = 'paypal' AND provider_ref = $1 AND refunded_at IS NULL`,
        [captureId],
      );
    }

    // Qorm clawback. resource.id is the refund's OWN id (never the capture id)
    // and is what keys the clawback ref, so a redelivered
    // PAYMENT.CAPTURE.REFUNDED claws back exactly once.
    const refundId = (event.resource as { id?: unknown } | null)?.id;
    const refundCents = parsePositiveCents(resource?.amount?.value);
    if (captureId && refundCents && typeof refundId === "string" && refundId) {
      // resource.amount is the refund's settlement currency, not necessarily
      // USD cents — same non-USD guard as paymentEventHandlers.ts's Stripe
      // handlers. A non-USD refund claws back everything still held for this
      // capture instead of trusting the raw number as cents; never logs a
      // payer field.
      const usd = (lowerCurrency(resource?.amount?.currency_code) ?? "usd") === "usd";
      if (!usd) {
        console.warn("[paypal] non-USD refund settlement — clawing back everything held for capture", captureId);
      }
      await deps.credits.clawbackForPayment({
        payment: { provider: "paypal", captureId },
        cents: usd ? refundCents : Number.MAX_SAFE_INTEGER,
        ref: `paypal:refund:${refundId}`,
        reason: "refund",
      });
    }
  }

  /** Every resolved dispute is recorded; the wallet is touched only when
   *  PayPal's own `dispute_outcome.outcome_code` says the buyer won
   *  (`RESOLVED_BUYER_FAVOUR` — confirmed against PayPal's own
   *  `customer_disputes_v1` OpenAPI spec, since the sandbox's
   *  `simulate-event` only ever returns the canned `CANCELED_BY_BUYER`
   *  example no matter what `resource_version` is requested — there is no
   *  way to script a real buyer-won payload). Every other outcome
   *  (`RESOLVED_SELLER_FAVOUR`, `RESOLVED_WITH_PAYOUT`, `CANCELED_BY_BUYER`,
   *  and the deprecated `ACCEPTED`/`DENIED`) is recorded only. NO
   *  refunded_at stamp — a resolved dispute is not a refund. */
  async function onDisputeResolved(event: PaypalWebhookEvent): Promise<void> {
    const resource = event.resource as {
      dispute_id?: unknown;
      dispute_amount?: { value?: unknown; currency_code?: unknown } | null;
      reason?: unknown;
      dispute_outcome?: { outcome_code?: unknown } | null;
    } | null;
    const captureId = captureIdFromDispute(event.resource);
    if (!captureId) {
      console.error(
        "[paypal] dispute %s carries no capture id in resource.disputed_transactions[0].seller_transaction_id — recording with matrix_id null",
        event.id,
      );
    }

    const owner = captureId ? await captureOwner(captureId) : { matrixId: null, kind: "donation" as const };

    await recordPaymentEvent({
      provider: "paypal",
      eventId: event.id,
      eventType: event.event_type,
      occurredAt: new Date(event.create_time),
      chargeId: captureId,
      matrixId: owner.matrixId,
      kind: owner.kind,
      amountCents: parsePositiveCents(resource?.dispute_amount?.value),
      currency: lowerCurrency(resource?.dispute_amount?.currency_code),
      outcome: "dispute_closed",
      // A code, never the buyer's prose — resource.messages[] is never read.
      reasonCode: typeof resource?.reason === "string" ? resource.reason : null,
      reasonText: typeof resource?.dispute_outcome?.outcome_code === "string" ? resource.dispute_outcome.outcome_code : null,
    });

    // Qorm clawback. Only the buyer-won outcome takes money back — see the
    // docstring above for why RESOLVED_BUYER_FAVOUR is the only outcome that
    // does.
    //
    // Ref is `paypal:dispute-capture:<captureId>` — ONE ref per capture,
    // shared with onCaptureReversed below — NOT keyed on resource.dispute_id.
    // A buyer-won CUSTOMER.DISPUTE.RESOLVED and a PAYMENT.CAPTURE.REVERSED
    // for the same money are two different PayPal notifications carrying two
    // different ids; keying each on its own id would let a partial dispute be
    // taken twice (once per id) for a single real-world loss. Sharing one ref
    // per capture across both handlers makes whichever arrives first take
    // the money back, and the ledger's (kind, ref) unique index turns the
    // other into an idempotent no-op — see the "same capture" test.
    // (A REFUNDED event keeps its OWN ref, `paypal:refund:<refundId>` — a
    // refund is separate money, not dispute-driven.)
    const disputeCents = parsePositiveCents(resource?.dispute_amount?.value);
    const outcomeCode = resource?.dispute_outcome?.outcome_code;
    if (captureId && disputeCents && outcomeCode === "RESOLVED_BUYER_FAVOUR") {
      // dispute_amount is the disputed charge's settlement currency, not
      // necessarily USD cents — same non-USD guard as onCaptureRefunded.
      // Never logs a payer field.
      const usd = (lowerCurrency(resource?.dispute_amount?.currency_code) ?? "usd") === "usd";
      if (!usd) {
        console.warn("[paypal] non-USD dispute settlement — clawing back everything held for capture", captureId);
      }
      await deps.credits.clawbackForPayment({
        payment: { provider: "paypal", captureId },
        cents: usd ? disputeCents : Number.MAX_SAFE_INTEGER,
        ref: `paypal:dispute-capture:${captureId}`,
        reason: "dispute",
      });
    }
  }

  /** PAYMENT.CAPTURE.REVERSED's resource is "refund"-typed, not the old v1
   *  Payments shape — confirmed against the real sandbox via
   *  POST /v1/notifications/simulate-event with resource_version="2.0" (the
   *  default canned example with no resource_version is the OLD v1 shape:
   *  resource.amount.total, a /v1/payments/refund/ self link, no capture-id
   *  link at all). With resource_version 2.0 the shape is the same family as
   *  PAYMENT.CAPTURE.REFUNDED's (seller_payable_breakdown, resource.amount,
   *  resource.links with rel="up" pointing at the capture, resource.id the
   *  reversal's own id) — so this reuses captureIdFromRefund and
   *  parsePositiveCents unchanged. A capture reversal moves money away from
   *  the seller on its own (it is not always preceded by a
   *  CUSTOMER.DISPUTE.RESOLVED), so it claws back directly here. */
  async function onCaptureReversed(event: PaypalWebhookEvent): Promise<void> {
    const resource = event.resource as { amount?: { value?: unknown; currency_code?: unknown } | null; id?: unknown } | null;
    const captureId = captureIdFromRefund(event.resource);
    if (!captureId) {
      // Ruling 4's OPPOSITE, same as onCaptureRefunded: a reversal is not
      // money arriving, so losing the retry loses nothing this log line
      // doesn't already carry. Record and return, never throw.
      console.error(
        "[paypal] reversal %s carries no capture id in resource.links (rel=up) — recording with matrix_id null",
        event.id,
      );
    }

    const owner = captureId ? await captureOwner(captureId) : { matrixId: null, kind: "donation" as const };

    await recordPaymentEvent({
      provider: "paypal",
      eventId: event.id,
      eventType: event.event_type,
      occurredAt: new Date(event.create_time),
      chargeId: captureId,
      matrixId: owner.matrixId,
      kind: owner.kind,
      amountCents: parsePositiveCents(resource?.amount?.value),
      currency: lowerCurrency(resource?.amount?.currency_code),
      // site.payment_events.outcome carries no CHECK constraint
      // (migrate-v123.sql:19 — a comment listing the conventional values,
      // not an enforced enum), so no migration is needed to add a new one.
      // "refunded" is the closest existing category regardless: the same
      // money-left-the-seller fact as a refund, just merchant-uninitiated.
      outcome: "refunded",
    });

    // Qorm clawback. reason is "dispute", not "refund": a reversal is PayPal
    // taking the money back on its own initiative, not the seller issuing a
    // refund.
    //
    // Ref is `paypal:dispute-capture:<captureId>` — the SAME ref
    // onDisputeResolved's buyer-won branch uses, not resource.id (the
    // reversal's own id). A reversal is not always preceded by a
    // CUSTOMER.DISPUTE.RESOLVED, but when the two ARE the same money (a
    // buyer-won dispute followed by PayPal's own reversal of the capture),
    // keying each on its own id would let a partial dispute be taken twice.
    // Sharing one ref per capture makes whichever notification arrives first
    // take the money back and the other an idempotent no-op — see the "same
    // capture" test.
    const reversalCents = parsePositiveCents(resource?.amount?.value);
    if (captureId && reversalCents) {
      // resource.amount is the reversal's settlement currency, not
      // necessarily USD cents — same non-USD guard as onCaptureRefunded.
      const usd = (lowerCurrency(resource?.amount?.currency_code) ?? "usd") === "usd";
      if (!usd) {
        console.warn("[paypal] non-USD reversal settlement — clawing back everything held for capture", captureId);
      }
      await deps.credits.clawbackForPayment({
        payment: { provider: "paypal", captureId },
        cents: usd ? reversalCents : Number.MAX_SAFE_INTEGER,
        ref: `paypal:dispute-capture:${captureId}`,
        reason: "dispute",
      });
    }
  }

  return { onCaptureCompleted, onCaptureRefunded, onDisputeResolved, onCaptureReversed };
}

// Lazy over the imported `pool` — same reason paymentEventHandlers.ts's own
// production binding states: `pool` here is a Pool instance, never a call,
// so importing this module must never itself open a connection.
// `getChatIdentity: realGetChatIdentity` is passed explicitly rather than
// relying on the factory's own default, so the production wiring is visible
// at the call site, not just inside the factory.
const bound = createPaypalWebhookHandlers({ pool, getChatIdentity: realGetChatIdentity, credits: moneyCredits });
export const onCaptureCompleted = bound.onCaptureCompleted;
export const onCaptureRefunded = bound.onCaptureRefunded;
export const onDisputeResolved = bound.onDisputeResolved;
export const onCaptureReversed = bound.onCaptureReversed;
