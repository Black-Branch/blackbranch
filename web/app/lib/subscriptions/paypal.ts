// The PayPal subscription adapter (subscription sources S3, spec §5.2, §8.2, §8.4, D9, D13, D22).
//
// Every path that writes a PayPal subscription record is here, and each one is provider-verified
// (state.ts's rule (a)/(b)): the PayPal webhook calls it only after verify-webhook-signature
// answered SUCCESS (api/billing/paypal/webhook/route.ts), and the re-check reads the state from
// PayPal itself. The viewer's own requests — subscribe and cancel — write an intent and nothing
// else, and the PayPal popup's onApprove writes nothing at all (§4.2, §12.3).
//
// READ STATE, DO NOT TRUST THE EVENT BODY (§4.3). A subscription event names a subscription; its
// state is read from PayPal under the viewer's lock and THAT is written, stamped with the event's
// `create_time`. PayPal documents no delivery order, so an older event arriving later is dropped by
// the transition function's stamp rule, and two events that read PayPal in turn write in turn.
//
// WHO (D13). A subscription the site created carries `custom_id` = a server-minted intent id
// (site.subscription_intents), so the account never travels in PayPal's field. An intent binds one
// viewer and one plan; a subscription whose plan is not the intent's, or not one of the install's
// plans on first sight, is refused and logged. A `custom_id` that names no intent → an unclaimed
// record (it entitles nobody; the owner sees it).
//
// MONEY (§8.2, §8.4). Each PAYMENT.SALE.COMPLETED is one site.subscription_payments row and one
// card to stream-api's /chat/event (`kind: "sub"`): the first sale of a subscription carries
// `spendId: paypal-sub:<subscription id>`, each later one `paypal-renewal:<sale id>`, and the
// spendId is STORED on the row. A refund, a reversal or a buyer-won dispute of a sale is sent to
// /support/reverse under that stored spendId, so it finds the very ledger row the sale's card
// created. The row's `credit` is `pending` until the card is answered, so a redelivered sale
// re-sends a card that was never confirmed (deduped by spendId in /chat/event).
//
// A REFUND BEFORE ITS SALE (review round 5, PB2) is never acked as "nothing to reverse": a
// PAYMENT.SALE.* refund or reversal is always a subscription payment (tips are captures), so a
// sale the site has not seen yet is READ from PayPal and recorded first — its card sent, its row
// written — and the refund then reverses it. A card stream-api has not confirmed answers 500, so
// PayPal redelivers; a credit the ledger does not hold yet is held by stream-api itself (202,
// stream.support_reversal_holds). The one refund that reverses nothing is a sale whose credit the
// ledger REFUSED (e.g. a non-USD charge): there is nothing to take back.
//
// Refunds and disputes never end access by themselves (D20): the subscription's state does.
//
// Injectable-pool factory (the shape of state.ts): a test drives it against a real database with
// a fake PayPal, a fake stream-api and its own budgets.
import type { Pool, PoolClient } from "pg";
import { randomInt } from "node:crypto";
import pool from "../../../lib/db.ts";
import type { createConcurrencyGate } from "../concurrencyGate.ts";
import { checkoutConnections, webhookConnections } from "../billingConnections.ts";
import { deliverChatEvent, type ChatEventOutcome } from "../chatEventDelivery.ts";
import { streamApiFetch } from "../streamApi.ts";
import { createPaymentEventsServer, type PaymentEventRow } from "../paymentEventsServer.ts";
import { captureIdFromDispute, parsePositiveCents } from "../paypalWebhookHandlers.ts";
import {
  cancelPaypalSubscription, createPaypalSubscription, getPaypalSale, getPaypalSubscription,
  paypalPlanState, paypalPlans, pickSale, type PaypalPlanState, type PaypalSale, type PaypalSubscription,
} from "../paypalSubscriptions.ts";
import { TIERS, type TierSlug } from "../tiers.ts";
import { writeTransition, type TransitionResult } from "./state.ts";
import { entitledElsewhere, subscriptionSources } from "./entitlement.ts";
import { paypalObservation, saleIdOf, saleMoney, tierForPlan } from "./paypalRecords.ts";
import type { Provider } from "./types.ts";

type Gate = ReturnType<typeof createConcurrencyGate>;
type PaypalEvent = { id: string; event_type: string; create_time: string; resource: unknown };
type Identity = { username: string; usernameColor: string | null; usernameStyle: object | null };

export type PaypalApi = {
  getSubscription: (id: string) => Promise<PaypalSubscription | null>;
  createSubscription: (a: { planId: string; customId: string }) => Promise<{ id: string; status: string }>;
  cancelSubscription: (id: string) => Promise<{ alreadyEnded: boolean }>;
  getSale: (id: string) => Promise<PaypalSale | null>;
  /** The plan's price, or "inactive"; THROWS when PayPal could not be read. */
  plan: (planId: string) => Promise<PaypalPlanState>;
};

type Deps = {
  pool: Pool;
  api: PaypalApi;
  /** tier slug → PayPal plan id (the install's `paypal.plans`). */
  plans: () => Partial<Record<TierSlug, string>>;
  /** One card to stream-api /chat/event (chatEventDelivery.ts deliverChatEvent). */
  deliver: (payload: Record<string, unknown> & { kind: string; spendId?: string }) => Promise<ChatEventOutcome>;
  /** POST stream-api /support/reverse. */
  postReverse: (body: Record<string, unknown>) => Promise<Response>;
  identity: (matrixId: string) => Promise<Identity>;
  /** After a commit that changed a viewer's records: badge, tier cache, badge map (§4.3 step 9). */
  effects: (viewer: string, r: TransitionResult) => Promise<void>;
  recordPaymentEvent: (row: PaymentEventRow) => Promise<unknown>;
  webhookBudget: Gate;
  checkoutBudget: Gate;
  sources?: () => Provider[];
  now?: () => Date;
  graceDays?: number;
};

export type StartResult =
  | { ok: true; subscriptionId: string }
  | { ok: false; status: 404; error: "not_offered" }
  | { ok: false; status: 409; error: "already_subscribed" }
  | { ok: false; status: 409; error: "subscribe_in_progress" }
  | { ok: false; status: 409; error: "subscribed_elsewhere"; provider: Provider; periodEnd: string | null }
  | { ok: false; status: 503; error: "busy" };

export type Offer = {
  offered: boolean;
  price: { amount: number; currency: string } | null;
  /** The viewer is already a Supporter through another service (null when signed out). */
  elsewhere: { provider: Provider; periodEnd: string | null } | null;
};

type PaymentRow = {
  payment_id: string; record_id: string; amount_cents: number; currency: string; net_cents: number | null;
  spend_id: string; credit: "pending" | "landed" | "refused" | null; refunded_at: Date | null; reversed_at: Date | null;
  external_id: string; matrix_id: string | null; tier: string | null; months: number;
};

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** `si_` + 22 base62 characters (about 131 bits), the shape v161's CHECK holds. Unbiased.
 *  @test-only exported so paypal.test.ts can mint a custom_id that names no intent; startSubscribe
 *  (this file) is its caller. */
export function newIntentId(): string {
  let s = "si_";
  for (let i = 0; i < 22; i++) s += BASE62[randomInt(62)];
  return s;
}

/** Account deletion could not cancel a PayPal subscription that could still charge: the deletion is
 *  refused (and retried whole), and the person is told it is PayPal, not "something". */
export class PaypalCancelError extends Error {
  readonly subscriptionId: string;
  constructor(subscriptionId: string, cause: unknown) {
    super(`PayPal could not be asked to cancel subscription ${subscriptionId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PaypalCancelError";
    this.subscriptionId = subscriptionId;
  }
}

/** The shape of every custom_id this site mints (newIntentId). */
const INTENT_ID = /^si_[0-9A-Za-z]{22}$/;
/** PayPal states in which a subscription can still charge (or be approved and then charge). */
const CHARGES = new Set(["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED"]);
/** How long a subscribe the viewer just started counts as "in progress" (finding 5). Long enough to
 *  cover a PayPal approval popup and the webhook that follows it — after which the record itself
 *  answers the same-service check — and short enough that someone who closed the popup is not shut
 *  out for long; within it, the open subscription is handed back rather than a second one made. */
const SUBSCRIBE_IN_PROGRESS_MIN = 10;

const lockViewer = (c: PoolClient, viewer: string) =>
  c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`billing:viewer:${viewer}`]);

/** @parked consumed by the production binding below and by subscriptions/paypal.test.ts;
 *  exported so the test can drive a real database with a fake PayPal and stream-api. */
export function createPaypalSubscriptions(deps: Deps) {
  const now = () => deps.now?.() ?? new Date();
  const sources = () => deps.sources?.() ?? subscriptionSources();

  /** The intent a subscription's `custom_id` names — valid only for that subscription (or, not yet
   *  bound to one, while unexpired), so one intent never claims two subscriptions. */
  async function intentFor(c: Pick<Pool, "query"> | PoolClient, sub: Pick<PaypalSubscription, "id" | "custom_id">) {
    if (!sub.custom_id) return null;
    const r = await c.query<{ matrix_id: string; plan_id: string; tier: string; external_id: string | null }>(
      `SELECT matrix_id, plan_id, tier, external_id FROM site.subscription_intents
        WHERE id = $1 AND provider = 'paypal'
          AND (external_id = $2 OR (external_id IS NULL AND expires_at > now()))`,
      [sub.custom_id, sub.id]);
    return r.rows[0] ?? null;
  }

  async function recordOf(db: Pick<Pool, "query"> | PoolClient, subId: string) {
    const r = await db.query<{ id: string; matrix_id: string | null; tier: string | null; period_end: Date | null }>(
      `SELECT id::text AS id, matrix_id, tier, period_end FROM site.subscription_records
        WHERE provider = 'paypal' AND external_id = $1`, [subId]);
    return r.rows[0] ?? null;
  }

  type ObserveCtx<T> = {
    stamp: Date;
    via: "webhook" | "recheck";
    budget: Gate;
    event?: PaypalEvent;
    /** Already read from PayPal (the re-check reads before it takes a connection). */
    preRead?: PaypalSubscription;
    /** More work in the same transaction, after the record is written. */
    inTx?: (c: PoolClient, viewer: string | null) => Promise<T>;
    /** The `custom_id` the (verified) event body carries, when it carries one. A subscription's
     *  custom_id never changes, so on first sight a custom_id that names no intent is dropped
     *  BEFORE a connection is taken or PayPal is asked (security review, finding 3). */
    hintCustomId?: string | null;
  };

  /** Read one subscription from PayPal under its viewer's lock, map it and write it through the
   *  one transition function; then the effects. null = nothing written (PayPal has no such
   *  subscription, or it was refused). */
  async function observe<T>(subId: string, ctx: ObserveCtx<T>): Promise<{ result: TransitionResult; viewer: string | null; extra: T | undefined; sub: PaypalSubscription } | null> {
    const before = await recordOf(deps.pool, subId); // a guess at the viewer, re-checked under the lock
    // A custom_id that is not even intent-shaped was never minted here: dropped before a connection
    // or a PayPal read. An intent-shaped one with no intent goes the full way, because it may be the
    // site's own subscription whose account was deleted (intents go with the account) — and that one
    // must be cancelled at PayPal, below.
    if (!before && ctx.hintCustomId !== undefined && !INTENT_ID.test(ctx.hintCustomId ?? "")) {
      console.warn("[paypal] subscription %s carries no intent of this site's — not written (the site creates every subscription it sells)", subId);
      return null;
    }
    const release = await ctx.budget.acquire();
    if (!release) throw new Error("paypal subscription: connection budget full; PayPal redelivers");
    let client: PoolClient | null = null;
    let out: { result: TransitionResult; viewer: string | null; extra: T | undefined; sub: PaypalSubscription } | null = null;
    // A subscription that would keep charging an account that no longer exists: cancelled at PayPal
    // once the transaction is over (security review, finding 5).
    let orphan: string | null = null;
    try {
      client = await deps.pool.connect();
      await client.query("BEGIN");
      // The viewer already locked: the pre-read row's. observe() handles ONE subscription, so a viewer
      // first seen below takes their lock once and nothing reads the variable after.
      const locked = before?.matrix_id ?? null;
      if (locked) await lockViewer(client, locked);
      let sub = ctx.preRead ?? await deps.api.getSubscription(subId);
      if (!sub) {
        console.error("[paypal] subscription %s: PayPal has no such subscription — nothing written", subId);
        await client.query("ROLLBACK");
        return null;
      }
      const rec = await recordOf(client, subId);
      const intent = await intentFor(client, sub);
      // The site creates every PayPal subscription it sells, server-side, with an intent as its
      // custom_id. One with no intent (made from the public client id in someone's own SDK call)
      // is not ours: nothing is written — no unclaimed row to grow without bound, no card, no
      // credit (security review, finding 3).
      if (!rec && !intent) {
        console.warn("[paypal] subscription %s (plan %s) names no intent of this site's — not written", subId, sub.plan_id);
        await client.query("ROLLBACK");
        // Intent-shaped and still able to charge: the site made it for an account since deleted
        // (or someone copied the shape — cancelling their own subscription harms nobody).
        if (INTENT_ID.test(sub.custom_id ?? "") && CHARGES.has(sub.status)) orphan = subId;
        return null;
      }
      const viewer = rec?.matrix_id ?? intent?.matrix_id ?? null;
      if (viewer && CHARGES.has(sub.status)) {
        // Deleted (a tombstone) or missing: nobody can sign in to cancel it, so the site does —
        // APPROVAL_PENDING included, so a popup approved after the deletion never charges.
        const live = await client.query(`SELECT 1 FROM site.users WHERE matrix_id = $1 AND deleted_at IS NULL`, [viewer]);
        if (!live.rows.length) orphan = subId;
      }
      if (viewer && viewer !== locked) {
        // First sight of the viewer: take their lock, then read again, so the state written was
        // read under it (§4.3). A re-check's own read is already stamped with its start.
        await lockViewer(client, viewer);
        if (!ctx.preRead) sub = (await deps.api.getSubscription(subId)) ?? sub;
      }

      // The plan. On first sight it must be one of the install's plans and, when an intent names
      // the subscription, the intent's own — a cheaper or foreign plan cannot ride a valid intent.
      // A record already held keeps its tier if the owner later moves the tier to a new plan, so
      // a paying subscriber on the old plan is never cut off by a settings change — and so does a
      // first sight: the intent's own tier stands when the subscription is on the intent's plan,
      // even if the owner moved the tier to a new plan between the subscribe and the webhook
      // (security review, finding 2).
      if (intent && intent.plan_id !== sub.plan_id) {
        console.error("[paypal] REFUSED — CHECK BY HAND: subscription %s (viewer %s) is on plan %s, not its intent's plan %s; nothing written, so if PayPal bills it the viewer pays with no perks — cancel or refund it in PayPal",
          subId, intent.matrix_id, sub.plan_id, intent.plan_id);
        await client.query("ROLLBACK");
        return null;
      }
      const intentTier = intent && Object.hasOwn(TIERS, intent.tier) ? (intent.tier as TierSlug) : null;
      const tier = tierForPlan(deps.plans(), sub.plan_id) ?? intentTier ?? ((rec?.tier ?? null) as TierSlug | null);
      if (!tier && !rec) {
        console.error("[paypal] REFUSED — CHECK BY HAND: subscription %s is on plan %s, which sells no tier here; nothing written", subId, sub.plan_id);
        await client.query("ROLLBACK");
        return null;
      }

      const observation = paypalObservation(sub, {
        tier, observedAt: ctx.stamp, now: now(), lastKnownEnd: rec?.period_end ? new Date(rec.period_end) : null, graceDays: deps.graceDays,
      });
      const result = await writeTransition(client, {
        via: ctx.via,
        event: ctx.event ? { provider: "paypal", id: ctx.event.id, type: ctx.event.event_type, occurredAt: new Date(ctx.event.create_time) } : undefined,
        viewer,
        observations: [observation],
        sources: sources(),
      });
      if (intent && !intent.external_id) {
        await client.query(`UPDATE site.subscription_intents SET external_id = $2 WHERE id = $1 AND external_id IS NULL`, [sub.custom_id, subId]);
      }
      const extra = ctx.inTx ? await ctx.inTx(client, viewer) : undefined;
      await client.query("COMMIT");
      out = { result, viewer, extra, sub };
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client?.release();
      release();
      if (orphan) {
        // A throw here answers 500 and PayPal redelivers, so the cancel is retried.
        const r = await deps.api.cancelSubscription(orphan);
        console.error("[paypal] subscription %s belonged to an account that no longer exists — %s at PayPal so it never charges again",
          orphan, r.alreadyEnded ? "already ended" : "CANCELLED");
      }
    }
    if (!out) return null;
    if (out.viewer && out.result.wrote.length) await deps.effects(out.viewer, out.result);
    return out;
  }

  // ── BILLING.SUBSCRIPTION.* ─────────────────────────────────────────────────────────────────

  /** CREATED, ACTIVATED, UPDATED, CANCELLED, SUSPENDED, EXPIRED, PAYMENT.FAILED: the event names
   *  the subscription; its state is PayPal's, read now. */
  async function onSubscriptionEvent(event: PaypalEvent): Promise<void> {
    const subId = (event.resource as { id?: unknown } | null)?.id;
    if (typeof subId !== "string" || !subId) {
      console.error("[paypal] %s %s names no subscription — ignored", event.event_type, event.id);
      return;
    }
    // The resource IS the subscription: its custom_id (absent = none) settles first sight cheaply.
    const custom = (event.resource as { custom_id?: unknown } | null)?.custom_id;
    await observe(subId, { stamp: new Date(event.create_time), via: "webhook", budget: deps.webhookBudget, event,
      hintCustomId: typeof custom === "string" && custom ? custom : null });
  }

  // ── Sales: the payment row and its card ────────────────────────────────────────────────────

  async function paymentRow(saleId: string): Promise<PaymentRow | null> {
    const r = await deps.pool.query<PaymentRow>(
      `SELECT p.payment_id, p.record_id::text AS record_id, p.amount_cents, p.currency, p.net_cents, p.spend_id, p.credit,
              p.refunded_at, p.reversed_at, r.external_id, r.matrix_id, r.tier,
              (SELECT count(*)::int FROM site.subscription_payments q WHERE q.record_id = p.record_id AND q.paid_at <= p.paid_at) AS months
         FROM site.subscription_payments p JOIN site.subscription_records r ON r.id = p.record_id
        WHERE p.provider = 'paypal' AND p.payment_id = $1`, [saleId]);
    return r.rows[0] ?? null;
  }

  /** Send a payment's card while its credit is still unanswered, and record the answer. A card
   *  stream-api did not confirm THROWS: the webhook answers 500 and PayPal redelivers the event,
   *  which re-sends the same spendId (deduped by /chat/event). */
  async function refuseCredit(p: PaymentRow, why: string): Promise<PaymentRow> {
    await deps.pool.query(
      `UPDATE site.subscription_payments SET credit = 'refused' WHERE provider = 'paypal' AND payment_id = $1 AND credit = 'pending'`, [p.payment_id]);
    console.error("[paypal] sale %s: NO card and no credit — %s", p.payment_id, why);
    return { ...p, credit: "refused" };
  }

  async function ensureCredited(p: PaymentRow): Promise<PaymentRow> {
    if (p.credit !== "pending") return p;
    // A card credits the bar and names a subscriber: never for a payment no viewer of ours holds
    // (security review, finding 3).
    if (!p.matrix_id) return refuseCredit(p, "its subscription belongs to no viewer");
    const who = p.matrix_id ? await deps.identity(p.matrix_id) : null;
    const tierName = p.tier && Object.hasOwn(TIERS, p.tier) ? TIERS[p.tier as TierSlug].name : TIERS.supporter.name;
    const out = await deps.deliver({
      kind: "sub",
      spendId: p.spend_id,
      subscriber: who?.username ?? null,
      subscriberMatrixId: p.matrix_id,
      usernameColor: who?.usernameColor ?? null,
      usernameStyle: who?.usernameStyle ?? null,
      tier: tierName,
      months: p.months,
      amount: p.amount_cents,
      currency: p.currency,
      // PayPal's own net (or its published rate when the sale reports no fee): stream-api credits it
      // instead of estimating a Stripe fee on a charge that was never Stripe's (§8.2).
      ...(p.currency === "usd" && p.net_cents != null && p.net_cents > 0 ? { netUsd: p.net_cents / 100 } : {}),
    });
    let credit: "landed" | "refused";
    if (out.outcome === "delivered") credit = p.currency === "usd" ? "landed" : "refused"; // a non-USD charge is a card, not a credit
    // A refusal is final only when stream-api judged the card itself (a validation 4xx). A 5xx
    // (`effects_failed` included) or a 401/403 (its secret not loaded yet, mid-restart) is a
    // stream-api that could not take it NOW: throw, so PayPal redelivers and the card is sent
    // again — stored as refused, the sale would never be credited, nor its refund reversed
    // (owner review B, 2026-10-21).
    else if (out.outcome === "refused" && out.status >= 400 && out.status < 500 && out.status !== 401 && out.status !== 403) credit = "refused";
    else throw new Error(`paypal sale ${p.payment_id}: stream-api did not take its card (${out.outcome}${out.outcome === "refused" ? ` ${out.status}` : ""}); PayPal redelivers`);
    await deps.pool.query(
      `UPDATE site.subscription_payments SET credit = $2 WHERE provider = 'paypal' AND payment_id = $1 AND credit = 'pending'`,
      [p.payment_id, credit]);
    if (credit === "refused") console.error("[paypal] sale %s: the ledger did not credit it (%s %s) — its refunds will reverse nothing", p.payment_id, p.amount_cents, p.currency);
    return { ...p, credit };
  }

  /** One sale: re-read its subscription and write it (this refreshes access), insert the payment
   *  row, then the card. Returns the payment row, or null when the sale is not a subscription
   *  payment the site can place. */
  async function recordSale(sale: PaypalSale, stamp: Date, event?: PaypalEvent): Promise<PaymentRow | null> {
    const subId = sale.billing_agreement_id; // ⚠ F1: the subscription's I-… id
    if (!sale.id || !subId) {
      console.warn("[paypal] sale %s names no subscription (billing_agreement_id) — not a subscription payment", sale.id || "?");
      return null;
    }
    const money = saleMoney(sale);
    if (!money) {
      console.error("[paypal] sale %s carries no usable amount — not recorded", sale.id);
      return null;
    }
    const paidAt = sale.create_time ? new Date(sale.create_time) : stamp;
    const out = await observe(subId, {
      stamp, via: "webhook", budget: deps.webhookBudget, event,
      inTx: async (c) => {
        const rec = await recordOf(c, subId);
        if (!rec) return false;
        // The first sale of a subscription is its `paypal-sub:` card, every later one a renewal.
        // ON CONFLICT keeps the spendId the first delivery stored.
        const others = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM site.subscription_payments WHERE record_id = $1 AND payment_id <> $2`, [rec.id, sale.id]);
        const spendId = (others.rows[0]?.n ?? 0) === 0 ? `paypal-sub:${subId}` : `paypal-renewal:${sale.id}`;
        await c.query(
          `INSERT INTO site.subscription_payments
             (provider, payment_id, record_id, amount_cents, currency, net_cents, paid_at, spend_id, credit)
           VALUES ('paypal', $1, $2, $3, $4, $5, $6, $7, 'pending')
           ON CONFLICT (provider, payment_id) DO NOTHING`,
          [sale.id, rec.id, money.grossCents, money.currency, money.netCents, paidAt, spendId]);
        return true;
      },
    });
    if (!out?.extra) return null;
    const row = await paymentRow(sale.id);
    if (!row) return null;
    if (row.credit === "pending") {
      // The floor is the price the subscription was SOLD at: a subscription can be created on the
      // site's plan id with an inline price override (sandbox F9: $0.01 accepted, plan_id
      // unchanged), and such a payment must not be celebrated or credited as a subscription
      // (security review, finding 3). It is the price stored with the intent at subscribe time
      // (v164), never the plan's current one — an owner who raises the price, or deactivates an
      // old plan, must not strand existing subscribers' renewals (owner verification, 2026-10-21).
      // An intent with no stored price (from before v164; the migration cannot back-fill it — the
      // price lives only at PayPal) falls back to the plan's current price. The check FAILS CLOSED
      // (security review of df38f985): a plan read that failed throws, so PayPal redelivers and the
      // check runs once PayPal answers; a plan that is inactive or gone leaves no price to hold the
      // payment to, and it is refused credit for the owner to check by hand — never credited blind.
      let floor = await soldPrice(subId);
      if (!floor) {
        const state = out.sub.plan_id ? await deps.api.plan(out.sub.plan_id) : "inactive"; // a failed read throws → 500
        if (state === "inactive") {
          return refuseCredit(row, `no price to hold it to: no price was stored when it was sold, and plan ${out.sub.plan_id ?? "?"} is inactive or gone at PayPal — CHECK BY HAND`);
        }
        floor = state;
      }
      if (row.currency !== floor.currency || row.amount_cents < floor.amount) {
        return refuseCredit(row, `it paid ${row.amount_cents} ${row.currency}, below the ${floor.amount} ${floor.currency} it was sold at — CHECK BY HAND`);
      }
    }
    return ensureCredited(row);
  }

  /** The price a subscription was sold at (its intent's, v164), or null. */
  async function soldPrice(subId: string): Promise<{ amount: number; currency: string } | null> {
    const r = await deps.pool.query<{ price_cents: number | null; currency: string | null }>(
      `SELECT price_cents, currency FROM site.subscription_intents WHERE provider = 'paypal' AND external_id = $1 LIMIT 1`, [subId]);
    const row = r.rows[0];
    return row?.price_cents && row.currency ? { amount: row.price_cents, currency: row.currency } : null;
  }

  /** PAYMENT.SALE.COMPLETED — "a subscription payment is received". */
  async function onSaleCompleted(event: PaypalEvent): Promise<void> {
    await recordSale(pickSale(event.resource as Record<string, unknown>), new Date(event.create_time), event);
  }

  // ── Refunds, reversals, disputes → the stream ledger (§8.4) ────────────────────────────────

  /** The payment a sale refund is about: the row, or — a refund that came before its sale — the
   *  sale read from PayPal and recorded first. Throws when PayPal cannot be read (500, redelivered). */
  async function paymentForRefund(saleId: string, event: PaypalEvent): Promise<PaymentRow | null> {
    const row = await paymentRow(saleId);
    if (row) return ensureCredited(row);
    const sale = await deps.api.getSale(saleId); // ⚠ F6
    if (!sale) {
      console.warn("[paypal] %s %s: PayPal has no sale %s — nothing to reverse", event.event_type, event.id, saleId);
      return null;
    }
    console.warn("[paypal] %s %s arrived before its sale %s — recording the sale first", event.event_type, event.id, saleId);
    return recordSale(sale, new Date(event.create_time));
  }

  async function reverse(p: PaymentRow, a: { ref: string; reason: "refund" | "dispute" | "restore"; cents: number | null }): Promise<void> {
    if (p.credit === "refused") {
      console.warn("[paypal] %s for sale %s: the ledger never credited it — nothing to take back", a.ref, p.payment_id);
      return;
    }
    const body = a.reason === "restore"
      ? { kind: "sub", spendId: p.spend_id, ref: a.ref, reason: "restore" }
      : { kind: "sub", spendId: p.spend_id, ref: a.ref, reason: a.reason, ...(a.cents != null ? { refunded: a.cents, gross: p.amount_cents } : {}) };
    const res = await deps.postReverse(body);
    if (!res.ok) throw new Error(`stream-api /support/reverse answered ${res.status} for ${a.ref}`);
    if (res.status === 202) console.warn("[support] %s %s — no ledger credit yet; stream-api holds the reversal for it", a.reason, a.ref);
  }

  async function recordEvent(event: PaypalEvent, p: PaymentRow, cents: number | null, outcome: string): Promise<void> {
    await deps.recordPaymentEvent({
      provider: "paypal", eventId: event.id, eventType: event.event_type, occurredAt: new Date(event.create_time),
      chargeId: p.payment_id, subscriptionId: p.external_id, matrixId: p.matrix_id, kind: "sub",
      amountCents: cents, currency: p.currency, outcome,
    });
  }

  /** PAYMENT.SALE.REFUNDED: one reversal per refund (`paypal:sale-refund:<refund id>`). */
  async function onSaleRefunded(event: PaypalEvent): Promise<void> {
    const res = event.resource as { id?: unknown; amount?: { total?: unknown; value?: unknown } | null } | null;
    const saleId = saleIdOf(event.resource);
    if (!saleId || typeof res?.id !== "string" || !res.id) {
      console.error("[paypal] %s %s names no sale or refund id — not reversed", event.event_type, event.id);
      return;
    }
    const p = await paymentForRefund(saleId, event);
    if (!p) return;
    const cents = parsePositiveCents(res.amount?.total ?? res.amount?.value);
    await deps.pool.query(`UPDATE site.subscription_payments SET refunded_at = now() WHERE provider = 'paypal' AND payment_id = $1 AND refunded_at IS NULL`, [saleId]);
    await recordEvent(event, p, cents, "refunded");
    await reverse(p, { ref: `paypal:sale-refund:${res.id}`, reason: "refund", cents });
  }

  /** PAYMENT.SALE.REVERSED (a chargeback). ONE ref per sale, shared with a buyer-won dispute of the
   *  same sale, so PayPal's reversal and the dispute's resolution are one reversal. */
  async function onSaleReversed(event: PaypalEvent): Promise<void> {
    const res = event.resource as { amount?: { total?: unknown; value?: unknown } | null } | null;
    const saleId = saleIdOf(event.resource);
    if (!saleId) {
      console.error("[paypal] %s %s names no sale — not reversed", event.event_type, event.id);
      return;
    }
    const p = await paymentForRefund(saleId, event);
    if (!p) return;
    const cents = parsePositiveCents(res?.amount?.total ?? res?.amount?.value);
    await deps.pool.query(`UPDATE site.subscription_payments SET reversed_at = now() WHERE provider = 'paypal' AND payment_id = $1 AND reversed_at IS NULL`, [saleId]);
    await recordEvent(event, p, cents, "refunded");
    console.error("[paypal] sale %s REVERSED (a chargeback) — the support it credited is taken back; the subscription's state still decides access", saleId);
    await reverse(p, { ref: `paypal:dispute-sale:${saleId}`, reason: "dispute", cents });
  }

  /** CUSTOMER.DISPUTE.RESOLVED on a subscription sale (the tip handler records the event itself):
   *  buyer-won → the reversal under the sale's dispute ref; won by the site after a reversal → its
   *  restore under the same ref. A dispute of anything that is not a known sale is not ours. */
  async function onDisputeResolved(event: PaypalEvent): Promise<void> {
    const saleId = captureIdFromDispute(event.resource);
    if (!saleId) return;
    const found = await paymentRow(saleId);
    if (!found) return;
    const r = event.resource as { dispute_amount?: { value?: unknown } | null; dispute_outcome?: { outcome_code?: unknown } | null } | null;
    const code = r?.dispute_outcome?.outcome_code;
    if (code === "RESOLVED_BUYER_FAVOUR") {
      const p = await ensureCredited(found);
      await deps.pool.query(`UPDATE site.subscription_payments SET reversed_at = now() WHERE provider = 'paypal' AND payment_id = $1 AND reversed_at IS NULL`, [saleId]);
      console.error("[paypal] dispute of sale %s lost — the support it credited is taken back", saleId);
      await reverse(p, { ref: `paypal:dispute-sale:${saleId}`, reason: "dispute", cents: parsePositiveCents(r?.dispute_amount?.value) });
    } else if (code === "RESOLVED_SELLER_FAVOUR" && found.reversed_at) {
      await reverse(found, { ref: `paypal:dispute-sale:${saleId}`, reason: "restore", cents: null });
    }
  }

  // ── The viewer's side: offer, subscribe, cancel ────────────────────────────────────────────

  /** What the subscribe sheet may show: PayPal is offered only with the module on, the keys set,
   *  a plan for the tier, and that plan readable at PayPal as an active monthly price. */
  async function offer(viewer: string | null, configured: boolean): Promise<Offer> {
    const plan = deps.plans().supporter;
    // Offered only on a price read now: an inactive plan or a failed read hides the button.
    const state = configured && plan ? await deps.api.plan(plan).catch(() => "inactive" as const) : "inactive";
    const price = state === "inactive" ? null : state;
    const elsewhere = viewer && price ? await entitledElsewhere(deps.pool, viewer, "paypal", sources()) : null;
    return { offered: Boolean(price), price: price ? { amount: price.amount, currency: price.currency } : null, elsewhere };
  }

  /** POST /api/billing/paypal/subscription. Writes an intent and asks PayPal to create the
   *  subscription with it as `custom_id` (D13); grants nothing — the webhook does, after PayPal
   *  says the viewer approved and paid. Runs on the CHECKOUT budget (a viewer drives it). */
  async function startSubscribe(viewer: string, a: { tier: TierSlug; alsoElsewhere: boolean }): Promise<StartResult> {
    const plans = deps.plans();
    const planId = Object.hasOwn(plans, a.tier) ? plans[a.tier] : undefined; // own properties only
    if (!planId) return { ok: false, status: 404, error: "not_offered" };
    const release = await deps.checkoutBudget.acquire();
    if (!release) return { ok: false, status: 503, error: "busy" };
    let client: PoolClient | null = null;
    try {
      client = await deps.pool.connect();
      await client.query("BEGIN");
      await lockViewer(client, viewer);
      // Same service twice stays refused (checkout/route.ts's rule). An APPROVAL_PENDING one
      // (renews false) is an abandoned popup, not a subscription.
      const same = await client.query(
        `SELECT 1 FROM site.subscription_records
          WHERE matrix_id = $1 AND provider = 'paypal'
            AND (status IN ('active', 'past_due', 'paused') OR (status = 'pending' AND renews)) LIMIT 1`, [viewer]);
      if (same.rows.length) { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "already_subscribed" }; }
      if (!a.alsoElsewhere) {
        const other = await entitledElsewhere(client, viewer, "paypal", sources());
        if (other) { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "subscribed_elsewhere", ...other }; }
      }
      // A subscribe started moments ago has no record yet (none exists until PayPal's webhook), so
      // the check above cannot see it: a second press would make a second billed subscription
      // (security review, finding 5). Within SUBSCRIBE_IN_PROGRESS_MIN the one already made is
      // handed back while PayPal still waits for its approval, and refused once it is past that.
      const recent = await client.query<{ external_id: string | null }>(
        `SELECT external_id FROM site.subscription_intents
          WHERE matrix_id = $1 AND provider = 'paypal' AND expires_at > now()
            AND created_at > now() - make_interval(mins => $2)
          ORDER BY created_at DESC LIMIT 1`, [viewer, SUBSCRIBE_IN_PROGRESS_MIN]);
      if (recent.rows.length) {
        await client.query("ROLLBACK");
        const ext = recent.rows[0]!.external_id;
        const open = ext ? await deps.api.getSubscription(ext) : null;
        if (ext && open?.status === "APPROVAL_PENDING" && open.plan_id === planId) return { ok: true, subscriptionId: ext };
        return { ok: false, status: 409, error: "subscribe_in_progress" };
      }
      // The price it is sold at, kept with the intent: the floor every payment of it must meet.
      const price = await deps.api.plan(planId); // a failed read throws: the route answers 502
      if (price === "inactive") { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "not_offered" }; }
      const intentId = newIntentId();
      await client.query(
        `INSERT INTO site.subscription_intents (id, matrix_id, provider, tier, plan_id, price_cents, currency)
         VALUES ($1, $2, 'paypal', $3, $4, $5, $6)`,
        [intentId, viewer, a.tier, planId, price.amount, price.currency]);
      const created = await deps.api.createSubscription({ planId, customId: intentId });
      await client.query(`UPDATE site.subscription_intents SET external_id = $2 WHERE id = $1`, [intentId, created.id]);
      await client.query("COMMIT");
      return { ok: true, subscriptionId: created.id };
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client?.release();
      release();
    }
  }

  /** POST /api/billing/paypal/subscription/cancel: PayPal's documented merchant cancel of every
   *  PayPal subscription of the viewer's that still renews. Writes NOTHING — the CANCELLED webhook
   *  does, and access runs to the end of the paid period (D9). */
  async function cancel(viewer: string): Promise<{ cancelled: number }> {
    const { rows } = await deps.pool.query<{ external_id: string }>(
      `SELECT external_id FROM site.subscription_records
        WHERE matrix_id = $1 AND provider = 'paypal' AND renews AND status IN ('pending', 'active', 'past_due', 'paused')`, [viewer]);
    let cancelled = 0;
    for (const r of rows) {
      await deps.api.cancelSubscription(r.external_id);
      cancelled++;
    }
    return { cancelled };
  }

  /** Account deletion: cancel at PayPal every subscription of the viewer's that could still charge —
   *  a record not ended, AND each subscription an intent of theirs created (one still waiting in an
   *  approval popup has no record yet). Call BEFORE the intents are erased. Writes nothing; the
   *  CANCELLED webhooks do. A throw refuses the deletion, so it is retried, never half done. */
  async function cancelForDeletion(viewer: string, db: Pick<Pool, "query"> | PoolClient = deps.pool): Promise<{ cancelled: number }> {
    // Only what could still charge (owner verification, 2026-10-21): a record still renewing (or
    // waiting for approval), and an UNEXPIRED intent's subscription no record has reported yet (an
    // approval popup). Not every intent that ever had an id — an ended history must never make a
    // deletion depend on PayPal (its keys may since have been removed).
    const { rows } = await db.query<{ id: string }>(
      `SELECT external_id AS id FROM site.subscription_records
        WHERE matrix_id = $1 AND provider = 'paypal'
          AND status IN ('pending', 'active', 'past_due', 'paused') AND (renews OR status = 'pending')
       UNION
       SELECT i.external_id AS id FROM site.subscription_intents i
        WHERE i.matrix_id = $1 AND i.provider = 'paypal' AND i.external_id IS NOT NULL AND i.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM site.subscription_records r WHERE r.provider = 'paypal' AND r.external_id = i.external_id)`, [viewer]);
    let cancelled = 0;
    for (const { id } of rows) {
      try {
        const sub = await deps.api.getSubscription(id);
        if (!sub || !CHARGES.has(sub.status)) continue;
        await deps.api.cancelSubscription(id);
        cancelled++;
      } catch (e) {
        throw new PaypalCancelError(id, e);
      }
    }
    return { cancelled };
  }

  // ── The re-check (§5.2) ─────────────────────────────────────────────────────────────────────

  /** PayPal records that entitle and whose access runs out within 3 days, or that nobody has read
   *  for 7 days: read each from PayPal NOW (before any connection is taken, stamped with the
   *  read's start — a read is the freshest truth, and an event newer than it still wins), then
   *  write it. Catches a CANCELLED/EXPIRED webhook lost for good, and keeps a live one's access
   *  moving while PayPal retries a payment. Returns how many were read. */
  async function recheck(budget: Gate, limit = 200): Promise<number> {
    const { rows } = await deps.pool.query<{ external_id: string }>(
      `SELECT external_id FROM site.subscription_records
        WHERE provider = 'paypal' AND status IN ('active', 'past_due')
          AND (access_until < now() + interval '3 days' OR last_checked_at IS NULL OR last_checked_at < now() - interval '7 days')
        ORDER BY access_until NULLS FIRST LIMIT $1`, [limit]);
    let read = 0;
    for (const { external_id } of rows) {
      try {
        const stamp = now();
        const sub = await deps.api.getSubscription(external_id);
        if (!sub) { console.error("[paypal] re-check: PayPal no longer has subscription %s", external_id); continue; }
        await observe(external_id, { stamp, via: "recheck", budget, preRead: sub });
        read++;
      } catch (e) {
        console.error("[paypal] re-check of %s failed: %s", external_id, (e as Error).message);
      }
    }
    return read;
  }

  return { onSubscriptionEvent, onSaleCompleted, onSaleRefunded, onSaleReversed, onDisputeResolved, offer, startSubscribe, cancel, cancelForDeletion, recheck };
}

// ── Production binding ────────────────────────────────────────────────────────────────────────

const PAYPAL_API: PaypalApi = {
  getSubscription: (id) => getPaypalSubscription(id),
  createSubscription: (a) => createPaypalSubscription(a),
  cancelSubscription: (id) => cancelPaypalSubscription(id),
  getSale: (id) => getPaypalSale(id),
  plan: (id) => paypalPlanState(id),
};

const bound = createPaypalSubscriptions({
  pool,
  api: PAYPAL_API,
  plans: paypalPlans,
  deliver: deliverChatEvent,
  postReverse: (body) => streamApiFetch("/support/reverse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  // Dynamic on purpose (paypalWebhookHandlers.ts's reason): these modules import the `@/` alias,
  // which plain node --test cannot resolve; the tests inject their own.
  identity: async (m) => (await import("../chatIdentity.ts")).getChatIdentity(m),
  effects: async (viewer, r) => {
    const [{ grantSubscriberBadge }, { invalidateTier }, { notifyBadgesChanged }] = await Promise.all([
      import("../billingServer.ts"), import("../entitlements.ts"), import("../streamApi.ts")]);
    if (r.after.supporter) await grantSubscriberBadge(viewer);
    invalidateTier(viewer);
    void notifyBadgesChanged();
  },
  recordPaymentEvent: (row) => createPaymentEventsServer({ pool }).recordPaymentEvent(row),
  webhookBudget: webhookConnections,
  checkoutBudget: checkoutConnections,
});

/** The PayPal webhook's subscription events (after verification). */
export const onPaypalSubscriptionEvent = bound.onSubscriptionEvent;
export const onPaypalSaleCompleted = bound.onSaleCompleted;
export const onPaypalSaleRefunded = bound.onSaleRefunded;
export const onPaypalSaleReversed = bound.onSaleReversed;
export const onPaypalSaleDisputeResolved = bound.onDisputeResolved;
/** The subscribe sheet's offer, the subscribe start and the on-site cancel (the viewer's routes). */
export const paypalSubscriptionOffer = bound.offer;
export const startPaypalSubscription = bound.startSubscribe;
export const cancelPaypalSubscriptions = bound.cancel;
/** Account deletion's PayPal step (owner review A): every subscription of the viewer's that could
 *  still charge, cancelled at PayPal before the intents go. accountDeletion.ts eraseSiteData calls
 *  it with its transaction client; a PayPalCancelError refuses the deletion with PayPal named. */
export const cancelPaypalForDeletion = bound.cancelForDeletion;

const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let recheckStarted = false;
/** Every 6 h, the PayPal re-check. Its writes hold a connection only for the write itself (PayPal
 *  is read before one is taken), so it takes a slot of the webhook budget for milliseconds, never
 *  across a PayPal call. Started by instrumentation.ts, beside startGiftExpirySweep(). */
export function startPaypalRecheck(): void {
  if (recheckStarted) return;
  recheckStarted = true;
  const run = () => void bound.recheck(webhookConnections).then(
    (n) => { if (n > 0) console.log(`[paypal] re-checked ${n} subscription(s)`); },
    (e: unknown) => console.error("[paypal] re-check failed:", e instanceof Error ? e.message : String(e)));
  setTimeout(run, 60_000);
  setInterval(run, RECHECK_EVERY_MS);
}
