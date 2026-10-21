// Relative, not "@/lib/db": node --test loads this file directly (no
// bundler in the loop) and does not understand the tsconfig "@/*" alias, so
// the fake-pool tests that import this module for real (coinsServerEarn.test.ts),
// unlike the source-text tests elsewhere in app/lib, would fail to resolve.
// tsc and Next's bundler are indifferent to either form.
import pool from "../../lib/db.ts";
import type Stripe from "stripe";
import type { Pool, PoolClient } from "pg";
import {
  type LedgerKind, type SpendSink, type EarnKind, type EarnChipItem, EARN_KINDS,
} from "./coins.ts";

// The ONLY code allowed to touch site.coin_wallets / site.coin_ledger.
// Ledger = append-only audit truth; wallet = materialized balance for the hot
// spend path. Every mutation runs in one transaction so the two can't diverge,
// and every op is idempotent via the (kind, ref) unique index — a retried Stripe
// webhook, a double-clicked spend, or a replayed earn never double-moves coins.
//
// Do NOT cache balances (the entitlements.ts 60s-TTL pattern is wrong here):
// a stale balance either lies in the wallet chip or lets the UI offer a spend
// that 400s. Reads are single-PK lookups; every spend/earn response returns the
// fresh balance so clients rarely need to poll.

// Participation-earn tuning. Deliberately modest: paid must stay the dominant
// inflow (6¢/hour watching + ≤5¢/day chatting, 30¢/day hard cap combined).
// Halved once already: the first rate earned too quickly.
const HEARTBEAT_MAX_DELTA_S = 90;   // clamp per beat: multi-tab / replay collapse to real time

export type CreditResult = { balance: number; replay: boolean };
export type DebitResult =
  | { ok: true; balance: number; replay: boolean }
  | { ok: false; error: "insufficient" };

/** Current balance (0 for users with no wallet yet). Direct PK read, no cache. */
export async function getBalance(matrixId: string): Promise<number> {
  const { rows } = await pool.query<{ balance: string }>(
    `SELECT balance FROM site.coin_wallets WHERE matrix_id = $1`,
    [matrixId]
  );
  return rows[0] ? Number(rows[0].balance) : 0;
}

// Ledger insert + wallet bump on one client/transaction. rowCount 0 = the
// (kind, ref) key already exists → an idempotent replay; the wallet is left
// untouched and the caller reports the current balance.
async function creditOn(
  client: PoolClient,
  matrixId: string,
  amount: number,
  kind: LedgerKind,
  ref: string | null,
  meta: Record<string, unknown> | null
): Promise<CreditResult> {
  const ins = await client.query(
    `INSERT INTO site.coin_ledger (matrix_id, delta, kind, ref, meta)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, ref) WHERE ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [matrixId, amount, kind, ref, meta ? JSON.stringify(meta) : null]
  );
  if ((ins.rowCount ?? 0) === 0) {
    const { rows } = await client.query<{ balance: string }>(
      `SELECT balance FROM site.coin_wallets WHERE matrix_id = $1`,
      [matrixId]
    );
    return { balance: rows[0] ? Number(rows[0].balance) : 0, replay: true };
  }
  const { rows } = await client.query<{ balance: string }>(
    `INSERT INTO site.coin_wallets (matrix_id, balance, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (matrix_id) DO UPDATE
       SET balance = site.coin_wallets.balance + EXCLUDED.balance, updated_at = NOW()
     RETURNING balance`,
    [matrixId, amount]
  );
  return { balance: Number(rows[0]?.balance ?? amount), replay: false };
}

/** Credit coins (purchase / earn / refund / admin). Idempotent on (kind, ref). */
async function creditCoins(args: {
  matrixId: string;
  amount: number;
  kind: LedgerKind;
  ref?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<CreditResult> {
  const amount = Math.round(args.amount);
  if (!(amount > 0)) throw new Error(`creditCoins: bad amount ${args.amount}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await creditOn(client, args.matrixId, amount, args.kind, args.ref ?? null, args.meta ?? null);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Debit coins for a spend. The wallet UPDATE's `balance >= amount` predicate +
 * row lock make a concurrent double-spend impossible; the (kind='spend', ref=
 * spendId) unique index makes a retried request an acknowledged no-op replay.
 */
export async function debitCoins(args: {
  matrixId: string;
  amount: number;
  sink: SpendSink;
  ref: string;
  meta?: Record<string, unknown> | null;
}): Promise<DebitResult> {
  const amount = Math.round(args.amount);
  if (!(amount > 0)) throw new Error(`debitCoins: bad amount ${args.amount}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO site.coin_ledger (matrix_id, delta, kind, sink, ref, meta)
       VALUES ($1, $2, 'spend', $3, $4, $5)
       ON CONFLICT (kind, ref) WHERE ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [args.matrixId, -amount, args.sink, args.ref, args.meta ? JSON.stringify(args.meta) : null]
    );
    if ((ins.rowCount ?? 0) === 0) {
      // Same spendId seen before (double-click / client retry): the spend already
      // happened — acknowledge it without moving the wallet again.
      await client.query("ROLLBACK");
      return { ok: true, balance: await getBalance(args.matrixId), replay: true };
    }
    const upd = await client.query<{ balance: string }>(
      `UPDATE site.coin_wallets
         SET balance = balance - $2, updated_at = NOW()
       WHERE matrix_id = $1 AND balance >= $2
       RETURNING balance`,
      [args.matrixId, amount]
    );
    if ((upd.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK"); // also covers "no wallet row at all"
      return { ok: false, error: "insufficient" };
    }
    await client.query("COMMIT");
    return { ok: true, balance: Number(upd.rows[0]?.balance ?? 0), replay: false };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * A deleted account forfeits its balance (the points balance is removed). Runs
 * inside the CALLER's transaction (accountDeletion.ts) so the forfeit and the rest of the erase
 * commit together. The ledger keeps one `forfeit` row for the amount — the accounting history
 * stays whole — and the wallet goes to zero. Idempotent: a second call finds nothing to forfeit.
 */
export async function forfeitCoinsForDeletion(client: { query: Pool["query"] }, matrixId: string): Promise<number> {
  const w = await client.query<{ balance: string }>(
    `SELECT balance FROM site.coin_wallets WHERE matrix_id = $1 FOR UPDATE`, [matrixId]);
  const balance = Number(w.rows[0]?.balance ?? 0);
  if (!(balance > 0)) return 0;
  await client.query(
    `INSERT INTO site.coin_ledger (matrix_id, delta, kind, sink, ref, meta)
     VALUES ($1, $2, 'forfeit', NULL, $3, NULL)
     ON CONFLICT (kind, ref) WHERE ref IS NOT NULL DO NOTHING`,
    [matrixId, -balance, `account-deleted:${matrixId}`]);
  await client.query(`UPDATE site.coin_wallets SET balance = 0, updated_at = NOW() WHERE matrix_id = $1`, [matrixId]);
  return balance;
}

/**
 * Return a failed spend's coins (e.g. stream-api was down between debit and
 * effect — the effect IS the product, so the debit must be undone).
 *
 * Keyed on the specific live spend LEDGER ROW being reversed, not on the spendId
 * string. Because a refund voids the spend row so a retry can reuse the spendId
 * (see below), one spendId can be spent more than once — so a refund key of
 * `refund:${spendId}` collided on the SECOND refund: ON CONFLICT DO NOTHING made
 * it a silent no-op and the retry was debited but never returned, losing the
 * coins. Keying on the row id makes each attempt's refund independent, while a
 * true double-call for one attempt is still idempotent (same row → same key, or
 * no live row on the second call).
 */
export async function refundCoins(args: {
  matrixId: string;
  amount: number;
  ref: string;
  meta?: Record<string, unknown> | null;
}): Promise<CreditResult> {
  // The one live (un-voided) spend row for this spendId. The partial unique index
  // on (kind='spend', ref) guarantees at most one exists at a time.
  const live = await pool
    .query<{ id: number }>(
      `SELECT id FROM site.coin_ledger WHERE kind = 'spend' AND ref = $1 LIMIT 1`,
      [args.ref]
    )
    .catch(() => ({ rows: [] as { id: number }[] }));
  const spendRowId = live.rows[0]?.id;

  // No live spend row → nothing to refund: it was already refunded+voided by a
  // prior call, or never spent. Crediting here would be an unmatched refund that
  // mints coins, so return the current balance without moving the wallet.
  if (spendRowId == null) {
    return { balance: await getBalance(args.matrixId), replay: true };
  }

  const res = await creditCoins({
    matrixId: args.matrixId,
    amount: args.amount,
    kind: "refund",
    ref: `refund:spend:${spendRowId}`, // unique per spend ATTEMPT
    meta: args.meta ?? null,
  });

  // Void the spend row so debitCoins no longer treats a retried spendId as a
  // replay (which would ack "ok" without charging or running the effect). Rename
  // rather than delete to keep the audit trail; frees the (kind, ref) key for a
  // genuine retry. Void the exact row we just refunded, by id.
  await pool
    .query(
      `UPDATE site.coin_ledger SET ref = ref || ':voided:' || id::text WHERE id = $1`,
      [spendRowId]
    )
    .catch((e) => console.error("[coins] failed to void spend ref after refund:", args.ref, e));

  return res;
}

/**
 * Credit a completed coin-purchase Checkout session (billing webhook only —
 * it is the sole writer of money state). Idempotent on the session id.
 *
 * Accounting model: the currency is channel points — a purchase is a private wallet
 * top-up, full stop. This row is its only DB record; it must NOT touch the
 * support bar, timer, or stream.support_events. A SPEND (cheer/sticker) is
 * spectacle only and moves nothing either — stream-api's money.js KIND_POLICY
 * marks every coin kind `credit: 'none'`, so no spend logs to support_events
 * at face value. The night is funded only by money given to it
 * (donation/gift/sub + platform webhooks), never by points moving in either
 * direction. A lit sponsor clock pays a 2x bonus on participation earning —
 * which is exactly why a spend must never be able to light one.
 */
export async function recordCoinPurchase(cs: Stripe.Checkout.Session): Promise<void> {
  await moneyCredits.recordCheckoutPurchase(cs);
}

// ── Money-bought points: tips, clawbacks, won disputes ───────────────────────
//
// A tip pays points at the purchase peg (1 point per USD cent). A refund or
// dispute of ANY money-bought credit (kind purchase or tip) takes it back —
// WITHOUT debitCoins' `balance >= amount` guard, so a wallet whose points were
// already spent goes negative. debitCoins keeps its guard,
// which is exactly what stops a negative wallet from spending again.
// Injectable pool: the billing handlers that call this are fake-pool tested,
// and a default to the module pool would let such a test write to production.

export type PaymentRef =
  | { provider: "stripe"; paymentIntent: string }
  | { provider: "paypal"; captureId: string };

function metaKeyOf(p: PaymentRef): { key: "payment_intent" | "capture_id"; id: string } {
  return p.provider === "stripe"
    ? { key: "payment_intent", id: p.paymentIntent }
    : { key: "capture_id", id: p.captureId };
}

export type MoneyCredits = ReturnType<typeof createMoneyCredits>;

/** @parked consumed by the production singleton below and by
 *  paymentEventHandlers.test.ts / moneyCredits*.test.ts; exported so the
 *  tests can drive a fake pool, the same shape as createEarn. */
export function createMoneyCredits(deps: { pool: Pool }) {
  async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await fn(client);
      await client.query("COMMIT");
      return r;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ── Delivery order (cases S2 + S4) ────────────────────────────────────────
  //
  // Stripe and PayPal do not deliver events in the order they happened, so a
  // reversal can arrive before its credit, and a reversal's outcome before the
  // reversal. site.payment_reversals (migrate-v149.sql) remembers both:
  //   - a refund/dispute that finds no credit is held as `pending`, and the
  //     credit takes it back in the same transaction when it lands (`applied`);
  //   - a failed/cancelled refund or a won dispute is `cancelled`, terminal, so
  //     an opening event that arrives after it takes nothing;
  //   - a reversal that finds its credit is recorded `applied` at once, so a
  //     restore can find every other reversal of the payment (reconcile below).
  //
  // Two transaction-scoped advisory locks serialise the races, always taken in
  // this order: the PAYMENT (a credit and every reversal of it), then the
  // REVERSAL ref (a reversal and its own outcome). The wallet row comes last.
  async function lock(c: PoolClient, key: string): Promise<void> {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
  const paymentLock = (key: string, id: string) => `money:payment:${key}:${id}`;
  const reversalLock = (ref: string) => `money:reversal:${ref}`;

  async function creditedFor(c: PoolClient, key: string, id: string) {
    const credited = await c.query<{ matrix_id: string; credited: string }>(
      `SELECT matrix_id, SUM(delta) AS credited FROM site.coin_ledger
        WHERE kind IN ('purchase', 'tip') AND meta->>$1 = $2
        GROUP BY matrix_id LIMIT 1`,
      [key, id]
    );
    return credited.rows[0];
  }

  /** Take back up to `want` of what is still held for this payment.
   *  `reversalRef` names the reversal a top-up row (reconcile) belongs to. */
  async function takeBack(
    c: PoolClient, row: { matrix_id: string; credited: string }, id: string,
    want: number, ref: string, reason: "refund" | "dispute", reversalRef?: string,
  ): Promise<void> {
    // Serialize concurrent refunds/disputes of one wallet before reading
    // what has already been taken back.
    await c.query(`SELECT 1 FROM site.coin_wallets WHERE matrix_id = $1 FOR UPDATE`, [row.matrix_id]);
    const net = await c.query<{ taken: string }>(
      `SELECT COALESCE(-SUM(delta), 0) AS taken FROM site.coin_ledger
        WHERE kind IN ('clawback', 'clawback_reversed') AND meta->>'payment_ref' = $1`,
      [id]
    );
    const left = Number(row.credited) - Number(net.rows[0]?.taken ?? 0);
    const take = Math.min(want, left);
    if (!(take > 0)) return;
    const ins = await c.query(
      `INSERT INTO site.coin_ledger (matrix_id, delta, kind, ref, meta)
       VALUES ($1, $2, 'clawback', $3, $4)
       ON CONFLICT (kind, ref) WHERE ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [row.matrix_id, -take, ref, JSON.stringify(
        reversalRef ? { payment_ref: id, reason, reversal_ref: reversalRef } : { payment_ref: id, reason })]
    );
    if ((ins.rowCount ?? 0) === 0) return; // redelivery
    // No `balance >= $2` predicate — deliberately (D2).
    await c.query(
      `INSERT INTO site.coin_wallets (matrix_id, balance, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (matrix_id) DO UPDATE
         SET balance = site.coin_wallets.balance + EXCLUDED.balance, updated_at = NOW()`,
      [row.matrix_id, -take]
    );
  }

  /** A money-bought credit, then every reversal of its payment that arrived
   *  first — one transaction, so the points are never spendable in between. */
  async function creditPayment(a: {
    matrixId: string; cents: number; kind: "purchase" | "tip"; ref: string; payment: PaymentRef;
  }): Promise<void> {
    const { key, id } = metaKeyOf(a.payment);
    await inTx(async (c) => {
      await lock(c, paymentLock(key, id));
      const held = await c.query<{ ref: string }>(
        `SELECT ref FROM site.payment_reversals
          WHERE payment_key = $1 AND payment_id = $2 AND status = 'pending'
          ORDER BY created_at, ref`,
        [key, id]
      );
      for (const h of held.rows) await lock(c, reversalLock(h.ref));
      await creditOn(c, a.matrixId, a.cents, a.kind, a.ref, { [key]: id });
      for (const h of held.rows) {
        // Re-read under the reversal lock: a restore may have cancelled it
        // between the SELECT above and the lock.
        const cur = await c.query<{ status: string; cents: string; reason: "refund" | "dispute" }>(
          `SELECT status, cents, reason FROM site.payment_reversals WHERE ref = $1 FOR UPDATE`,
          [h.ref]
        );
        const r = cur.rows[0];
        if (!r || r.status !== "pending") continue;
        const row = await creditedFor(c, key, id);
        if (row) await takeBack(c, row, id, Number(r.cents), h.ref, r.reason);
        await c.query(
          `UPDATE site.payment_reversals SET status = 'applied', updated_at = NOW() WHERE ref = $1`,
          [h.ref]
        );
      }
    });
  }

  async function recordTipCredit(a: { matrixId: string; cents: number; ref: string; payment: PaymentRef }): Promise<void> {
    const cents = Math.round(a.cents);
    if (!(cents > 0)) return;
    await creditPayment({ ...a, cents, kind: "tip" });
  }

  /** A quiet points purchase paid OUTSIDE Stripe Checkout (PayPal/Venmo).
   *  Stripe purchases go through recordCheckoutPurchase below,
   *  which derives everything from the Checkout session. Same meta key shape
   *  as a tip, so clawbackForPayment finds it by the id its refund carries. */
  async function recordPurchaseCredit(a: { matrixId: string; cents: number; ref: string; payment: PaymentRef }): Promise<void> {
    const cents = Math.round(a.cents);
    if (!(cents > 0)) return;
    await creditPayment({ ...a, cents, kind: "purchase" });
  }

  /** A paid Stripe Checkout points purchase, idempotent on the session id.
   *
   *  Points are pegged 1:1 to USD CENTS. `amount_total` is in the SETTLEMENT
   *  currency's minor units, which is not always USD — Stripe Adaptive Pricing
   *  can settle a session in the buyer's local currency. Crediting it blindly
   *  would hand out ¥15,000 → 15,000 points, or ₫100,000 → 100,000 points for
   *  roughly $4. `metadata.coins` is written at session creation
   *  (billing/points/route.ts) from the USD cents the buyer actually chose, so
   *  it is the authoritative intent. Take the MINIMUM of the two: identical in
   *  the normal USD case, and it can only ever under-credit — never
   *  over-credit — if they diverge. */
  async function recordCheckoutPurchase(cs: Stripe.Checkout.Session): Promise<void> {
    if (cs.payment_status !== "paid") return; // async methods land later via async_payment_succeeded
    const matrixId = cs.metadata?.matrix_id || null;
    const intended = Number(cs.metadata?.coins ?? 0);
    const settled = cs.amount_total ?? 0;
    const currency = (cs.currency ?? "usd").toLowerCase();

    if (currency !== "usd" || (intended > 0 && settled !== intended)) {
      console.error(
        "[coins] purchase currency/amount mismatch — session=%s currency=%s settled=%d intended=%d matrix_id=%s",
        cs.id, currency, settled, intended, matrixId ?? "(none)"
      );
    }

    const coins = intended > 0 ? Math.min(settled, intended) : settled;
    if (!matrixId || coins <= 0) return;
    const paymentIntent =
      typeof cs.payment_intent === "string" ? cs.payment_intent : cs.payment_intent?.id ?? null;
    if (paymentIntent) {
      await creditPayment({ matrixId, cents: coins, kind: "purchase", ref: cs.id, payment: { provider: "stripe", paymentIntent } });
    } else {
      // A paid payment-mode session always carries one; without it no refund can name this credit.
      await inTx((c) => creditOn(c, matrixId, coins, "purchase", cs.id, { payment_intent: null }));
    }
  }

  async function clawbackForPayment(a: {
    payment: PaymentRef; cents: number; ref: string; reason: "refund" | "dispute";
  }): Promise<void> {
    const want = Math.round(a.cents);
    if (!(want > 0)) return;
    const { key, id } = metaKeyOf(a.payment);
    await inTx(async (c) => {
      await lock(c, paymentLock(key, id));
      await lock(c, reversalLock(a.ref));
      // Any row already settles this ref: `cancelled` is terminal (its outcome
      // came first — S4); `pending` / `applied` is a redelivery.
      const known = await c.query(`SELECT 1 FROM site.payment_reversals WHERE ref = $1`, [a.ref]);
      if ((known.rowCount ?? 0) > 0) return;
      const row = await creditedFor(c, key, id);
      if (!row) {
        // Nothing credited YET (S2): hold it for the credit to take back. A
        // payment that never credits points (a sub, an anonymous tip) leaves a
        // row nothing reads again.
        await c.query(
          `INSERT INTO site.payment_reversals (ref, payment_key, payment_id, cents, reason, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           ON CONFLICT (ref) DO NOTHING`,
          [a.ref, key, id, want, a.reason]
        );
        return;
      }
      await takeBack(c, row, id, want, a.ref, a.reason);
      await c.query(
        `INSERT INTO site.payment_reversals (ref, payment_key, payment_id, cents, reason, status)
         VALUES ($1, $2, $3, $4, $5, 'applied')
         ON CONFLICT (ref) DO NOTHING`,
        [a.ref, key, id, want, a.reason]
      );
    });
  }

  /** What one reversal's clawback rows have taken: its own row plus any
   *  top-ups a reconcile wrote for it. */
  async function takenBy(c: PoolClient, ref: string): Promise<number> {
    const r = await c.query<{ taken: string }>(
      `SELECT COALESCE(-SUM(delta), 0) AS taken FROM site.coin_ledger
        WHERE kind = 'clawback' AND (ref = $1 OR meta->>'reversal_ref' = $1)`,
      [ref]
    );
    return Number(r.rows[0]?.taken ?? 0);
  }

  /** After a restore gives points back, every other live reversal of the payment
   *  takes what it is still owed. Without this, a failed refund that took the
   *  whole credit first leaves its successful replacement (which found nothing
   *  left) owed forever, and the restore hands the viewer points the money no
   *  longer backs. Caller holds the payment lock, so reversal locks taken here
   *  follow the payment → reversal order. */
  async function reconcile(c: PoolClient, key: string, id: string, cancelledRef: string, restoreRef: string): Promise<void> {
    const credit = await creditedFor(c, key, id);
    if (!credit) return; // pending reversals stay pending for the credit to apply
    const others = await c.query<{ ref: string }>(
      `SELECT ref FROM site.payment_reversals
        WHERE payment_key = $1 AND payment_id = $2 AND status = 'applied' AND ref <> $3
        ORDER BY created_at, ref`,
      [key, id, cancelledRef]
    );
    for (const o of others.rows) {
      await lock(c, reversalLock(o.ref));
      const cur = await c.query<{ status: string; cents: string; reason: "refund" | "dispute" }>(
        `SELECT status, cents, reason FROM site.payment_reversals WHERE ref = $1 FOR UPDATE`,
        [o.ref]
      );
      const r = cur.rows[0];
      if (!r || r.status !== "applied") continue;
      const owed = Number(r.cents) - await takenBy(c, o.ref);
      if (!(owed > 0)) continue;
      // A reversal's own `(clawback, <ref>)` row may already exist, so a top-up
      // needs its own ref. Keyed on the restore that freed the points: each
      // restore can top a reversal up at most once, and `owed` already counts
      // earlier top-ups, so a redelivered restore takes nothing either way.
      await takeBack(c, credit, id, owed, `${o.ref}:after:${restoreRef}`, r.reason, o.ref);
    }
  }

  /** The payment a reversal ref belongs to, as its opening event recorded it. */
  async function recordedPayment(c: PoolClient | Pool, ref: string): Promise<{ key: string; id: string } | null> {
    const rev = await c.query<{ payment_key: string | null; payment_id: string | null }>(
      `SELECT payment_key, payment_id FROM site.payment_reversals WHERE ref = $1`, [ref]
    );
    const r = rev.rows[0];
    if (r?.payment_key && r.payment_id) return { key: r.payment_key, id: r.payment_id };
    // A clawback written before reversals were recorded on apply has only its
    // ledger row; the provider is in the ref's prefix.
    const led = await c.query<{ payment_ref: string | null }>(
      `SELECT meta->>'payment_ref' AS payment_ref FROM site.coin_ledger WHERE kind = 'clawback' AND ref = $1`, [ref]
    );
    const pid = led.rows[0]?.payment_ref;
    if (!pid) return null;
    return { key: ref.startsWith("paypal:") ? "capture_id" : "payment_intent", id: pid };
  }

  /** A failed/cancelled refund or a won dispute: give back what that reversal
   *  took, mark it terminal, then reconcile the payment's other reversals.
   *  `payment` is what the caller knows; without it the payment is read from
   *  what the opening event recorded. */
  async function restoreClawback(a: { clawbackRef: string; ref: string; payment?: PaymentRef | null }): Promise<void> {
    // Read before locking — the payment lock comes first. A ref's payment never
    // changes once written, so the only race is its opening event committing in
    // between; seen under the reversal lock, that attempt does nothing and the
    // next one locks the payment it found.
    let target = a.payment ? metaKeyOf(a.payment) : await recordedPayment(deps.pool, a.clawbackRef);
    for (let attempt = 0; ; attempt++) {
      const unlocked = await restoreOnce(a, target);
      if (!unlocked) return;
      if (attempt >= 2) throw new Error(`restoreClawback: ${a.clawbackRef} payment kept moving`);
      target = unlocked;
    }
  }

  /** One attempt. Returns the recorded payment instead of restoring when it is
   *  not the one locked. */
  async function restoreOnce(
    a: { clawbackRef: string; ref: string }, target: { key: string; id: string } | null,
  ): Promise<{ key: string; id: string } | null> {
    return inTx(async (c) => {
      if (target) await lock(c, paymentLock(target.key, target.id));
      await lock(c, reversalLock(a.clawbackRef));
      const now = await recordedPayment(c, a.clawbackRef);
      if (now && (!target || now.key !== target.key || now.id !== target.id)) return now;
      const { rows } = await c.query<{ matrix_id: string; taken: string; payment_ref: string | null }>(
        `SELECT matrix_id, -SUM(delta) AS taken, MIN(meta->>'payment_ref') AS payment_ref FROM site.coin_ledger
          WHERE kind = 'clawback' AND (ref = $1 OR meta->>'reversal_ref' = $1)
          GROUP BY matrix_id`,
        [a.clawbackRef]
      );
      const row = rows[0];
      if (row && Number(row.taken) > 0) {
        await creditOn(c, row.matrix_id, Number(row.taken), "clawback_reversed", a.ref,
          { payment_ref: row.payment_ref, reason: "dispute_won" });
      }
      // Terminal whatever came before: a held reversal is dropped, and an
      // opening event still to come takes nothing (S4).
      await c.query(
        `INSERT INTO site.payment_reversals (ref, status) VALUES ($1, 'cancelled')
         ON CONFLICT (ref) DO UPDATE SET status = 'cancelled', updated_at = NOW()`,
        [a.clawbackRef]
      );
      if (target) await reconcile(c, target.key, target.id, a.clawbackRef, a.ref);
      return null;
    });
  }

  return { recordTipCredit, recordPurchaseCredit, recordCheckoutPurchase, clawbackForPayment, restoreClawback };
}

/** Production binding. Consumed by the Stripe billing webhook's recordDonation
 *  (billing/webhook/route.ts, tip credit), the PayPal webhook's points purchase
 *  branch (recordPurchaseCredit), and paymentEventHandlers.ts's production
 *  binding (refund/dispute clawback, dispute-won restore). */
export const moneyCredits = createMoneyCredits({ pool });

// ── History (the user's own ledger — full transparency in the store) ─────────

export type LedgerRow = {
  id: number;
  delta: number;
  kind: LedgerKind;
  sink: SpendSink | null;
  createdAt: string;
};

/** The user's own ledger, newest first, keyset-paged on id. */
export async function getHistory(matrixId: string, beforeId?: number): Promise<LedgerRow[]> {
  const { rows } = await pool.query(
    `SELECT id, delta, kind, sink, created_at
     FROM site.coin_ledger
     WHERE matrix_id = $1 ${beforeId ? "AND id < $3" : ""}
     ORDER BY id DESC LIMIT $2`,
    beforeId ? [matrixId, 50, beforeId] : [matrixId, 50]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    delta: Number(r.delta),
    kind: r.kind as LedgerKind,
    sink: (r.sink ?? null) as SpendSink | null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

// ── Per-stream participation earning ─────────────────────────────────────────
//
// Every rule lives in earnRules.ts (pure, mutation-tested). This module is the
// transaction and the state around it, nothing more.
//
// ACCOUNTING IS PER STREAM, not per day. "First message of
// the stream" and "25 votes per stream" are not expressible per day: a stream
// crossing midnight would grant the bonus twice, two streams in one day once.
//
// EVERY PATH LOCKS ITS STATE ROW `FOR UPDATE` before reading a counter. That
// row lock — not an advisory lock — is the right scope here, because every
// counter is per (user, stream) and that is exactly what the row is. Without
// it, two concurrent messages both read the same last_award_at and both pass
// the cooldown.
//
// Refs are stream-scoped so a ledger row cannot collide across streams and be
// swallowed as a replay.
import { currentStream } from "./currentStream.ts";
import {
  messageAward, voteCastAward, upvoteReceivedAward, watchAward, bonusFor, earnRulesFrom,
  type EarnRules,
} from "./earnRules.ts";
import { clockActiveFor } from "./sponsorClockServer.ts";
import { instanceResolve } from "./instanceConfigServer.ts";

type StreamState = {
  watch_points: number; watch_seconds: number; first_awarded: boolean;
  last_award_at: Date | string | null; last_beat: Date | string | null;
  votes_awarded: number; is_bot: boolean;
};

/** `pg` returns timestamptz as a Date from a real pool and an ISO string from
 *  the fake one in tests. Accepting only Date would make the cooldown silently
 *  never apply under test — and only string would crash in production. */
function toMs(v: Date | string | null): number | null {
  if (v === null) return null;
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/** Earning credited since `since`, grouped by kind — what the "+2q" chip
 *  announces.
 *
 *  WHY THE HEARTBEAT CARRIES THIS AT ALL. The routes that earn cannot report
 *  an `awarded` field, for two independent reasons:
 *
 *    1. `/chat/send` and `/chat/vote` fire their earns FORGETFULLY, on purpose
 *       — "an award must never block or fail the action it rewards". The
 *       response is written before the award resolves, so there is nothing to
 *       put in it. Awaiting instead would add a write transaction to the
 *       product's most latency-sensitive route to power a decoration.
 *    2. `earn_upvote` pays the message's AUTHOR, who has no request in flight.
 *       No response of theirs exists to carry it.
 *
 *  So the chip is fed by the one channel that already reaches an idle viewer:
 *  the 60s watch heartbeat. `last_beat` is its cursor — a column that already
 *  exists, is already advanced once per beat, and is already read inside this
 *  transaction, so nothing new has to be kept in step.
 *
 *  A chip can be MISSED, and only a chip: an award whose transaction commits
 *  after this SELECT's snapshot but before the cursor advances to NOW() falls
 *  in the gap. The points are in the ledger and in the balance either way — the
 *  wallet is right, the animation just didn't play. Closing that race would
 *  mean a second cursor column keyed to ledger id, which is not worth carrying
 *  for a 1.5s flourish.
 *
 *  A null `since` reports nothing rather than everything: the first beat of a
 *  stream has no window, and reporting a lifetime of earning as one burst of
 *  chips is worse than reporting none. Same stance as the watch clock's own
 *  "first beat banks nothing". */
async function earnChipsSince(
  client: PoolClient,
  matrixId: string,
  since: Date | string | null
): Promise<EarnChipItem[]> {
  if (since === null) return [];
  const { rows } = await client.query<{ kind: string; points: string }>(
    `SELECT kind, SUM(delta)::bigint AS points
       FROM site.coin_ledger
      WHERE matrix_id = $1 AND created_at > $2 AND kind = ANY($3::text[])
      GROUP BY kind`,
    [matrixId, since, EARN_KINDS]
  );
  // `pg` hands SUM() back as a string; a string here would render "+11q" as
  // "+1q1q" through the chip's template.
  return rows
    .map((r) => ({ kind: r.kind as EarnKind, points: Number(r.points) }))
    .filter((c) => c.points > 0)
    // Stable, meaningful order: the first-message bonus reads before the
    // message point it arrived with. Sorted here rather than in SQL so the
    // fake pool in tests produces the same sequence as production.
    .sort((a, b) => EARN_KINDS.indexOf(a.kind) - EARN_KINDS.indexOf(b.kind));
}

/** @parked consumed by the production singleton below and by
 *  coinsServerEarn.test.ts; exported so the tests can drive a fake pool, a fake
 *  clock and a fake stream, the same shape as createCurrentStream. */
export function createEarn(deps: {
  pool: Pool;
  currentStreamId: () => Promise<number | null>;
  nowMs: () => number;
  /** The clock perk: is this viewer's sponsor clock
   *  lit? Production: sponsorClockServer.clockActiveFor. Any throw is "no".
   *  MUST carry its own deadline — production's clockActiveFor bounds
   *  itself at CLOCK_TIMEOUT_MS. clockLit()'s try/catch below only converts a
   *  REJECTION to `false`; an injected resolver that never settles hangs
   *  earnMessage() forever, with no ledger row written and the caller's
   *  `.catch()` never fires because nothing ever rejected. */
  clockActive: (matrixId: string) => Promise<boolean>;
  /** The earn rules (`currency.*` settings), read at the START of every award so an
   *  edit on the Points screen applies to the next one. Production: web's instance reader. */
  rules: () => EarnRules;
}) {
  /** Resolved BEFORE inStream opens its transaction — the FOR UPDATE state row
   *  must never wait on a network call — and any failure is simply "not lit":
   *  the base award never depends on it. */
  async function clockLit(matrixId: string): Promise<boolean> {
    try { return (await deps.clockActive(matrixId)) === true; }
    catch (e) {
      console.warn("[coins] clockActive threw — paying 1x: %s", e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  /** The bonus is its OWN row, ref-keyed to the base row: history
   *  says which points were the bonus, provenance can carve it out later, and the
   *  base award's ref and tests never move. Written only for a FRESH base
   *  credit — a replayed base must not mint a bonus on retry (and a replayed
   *  bonus collides on its own ref anyway). */
  async function creditBonus(
    client: PoolClient, matrixId: string, basePoints: number, baseKind: EarnKind, baseRef: string, lit: boolean,
    rules: EarnRules
  ): Promise<number> {
    const bonus = bonusFor(basePoints, lit, rules);
    if (bonus === 0) return 0;
    await creditOn(client, matrixId, bonus, "earn_bonus", `bonus:${baseRef}`, { base: baseKind, multiplier: rules.clockMultiplier });
    return bonus;
  }

  /** Create-if-missing, then lock. Returns null when there is nothing to award
   *  to — an unknown user, or a bot.
   *
   *  `FOR UPDATE OF s` locks the state row only. Locking site.users too would
   *  serialise every earn path in the site behind one row per user for no
   *  benefit. */
  async function lockState(
    client: PoolClient, matrixId: string, streamId: number
  ): Promise<StreamState | null> {
    await client.query(
      `INSERT INTO site.coin_earn_stream (matrix_id, stream_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [matrixId, streamId]
    );
    const { rows } = await client.query<StreamState>(
      `SELECT s.watch_points, s.watch_seconds, s.first_awarded, s.last_award_at,
              s.last_beat, s.votes_awarded, u.is_bot
         FROM site.coin_earn_stream s
         JOIN site.users u ON u.matrix_id = s.matrix_id
        WHERE s.matrix_id = $1 AND s.stream_id = $2
        FOR UPDATE OF s`,
      [matrixId, streamId]
    );
    const s = rows[0];
    if (!s || s.is_bot) return null;
    return s;
  }

  /** Open a transaction against the live stream's state row, or do nothing.
   *  Returns `{ awarded: 0 }` without touching the database when there is no
   *  stream — earning is live-gated, and awarding off-stream would let anyone
   *  collect the first-message bonus at 4am forever. */
  async function inStream<T>(
    matrixId: string,
    run: (client: PoolClient, state: StreamState, streamId: number) => Promise<T>,
    none: T
  ): Promise<T> {
    const streamId = await deps.currentStreamId();
    if (streamId === null) return none;

    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await lockState(client, matrixId, streamId);
      if (!state) {
        await client.query("COMMIT");
        return none;
      }
      const out = await run(client, state, streamId);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function earnMessage(matrixId: string): Promise<{ awarded: number }> {
    const lit = await clockLit(matrixId);
    const rules = deps.rules();
    return inStream(matrixId, async (client, state, streamId) => {
      const now = deps.nowMs();
      const award = messageAward(
        { firstAwarded: state.first_awarded, lastAwardMs: toMs(state.last_award_at) },
        now,
        rules
      );
      if (award.points === 0) return { awarded: 0 };

      // The bonus and the message point are separate ledger rows: they are
      // different things, and the history tab should say which is which. The
      // clock bonus is a third and fourth, each keyed to the row it doubles.
      let awarded = 0;
      // The AWARD's amounts, never literals: earnRules.ts is the one place a
      // rate lives.
      if (award.first) {
        const ref = `first:${matrixId}:${streamId}`;
        const r = await creditOn(client, matrixId, award.firstPoints, "earn_first", ref, null);
        awarded += award.firstPoints;
        if (!r.replay) awarded += await creditBonus(client, matrixId, award.firstPoints, "earn_first", ref, lit, rules);
      }
      // The cooldown guarantees awards are >= one cooldown apart, so no two can
      // share a cooldown-long wall-clock bucket — which makes this ref genuinely
      // idempotent for a retry within the same window. (At the 10-minute product
      // default this is floor(now / 600000), the ref every earlier row carries.)
      const bucket = Math.floor(now / rules.messageCooldownMs);
      const msgRef = `msg:${matrixId}:${streamId}:${bucket}`;
      const r = await creditOn(client, matrixId, award.messagePoints, "earn_chat", msgRef, null);
      awarded += award.messagePoints;
      if (!r.replay) awarded += await creditBonus(client, matrixId, award.messagePoints, "earn_chat", msgRef, lit, rules);

      await client.query(
        `UPDATE site.coin_earn_stream
            SET first_awarded = TRUE, last_award_at = NOW()
          WHERE matrix_id = $1 AND stream_id = $2`,
        [matrixId, streamId]
      );
      return { awarded };
    }, { awarded: 0 });
  }

  /** THE REF IS KEYED TO THE MESSAGE, and that is what makes voting a
   *  participation signal rather than a button to hold down.
   *
   *  A counter-based ref (`…:${n}`) would pay again every time the voter
   *  re-voted the SAME message: clearing a vote deletes the row, and the next
   *  vote inserts a fresh one, so vote → un-vote → vote is a new insert each
   *  time. The per-stream cap would bound it at 25, but a viewer could reach
   *  all 25 by toggling one message. Keyed to the message, the second award for
   *  that message replays and pays nothing — so the cap bounds DISTINCT
   *  messages, which is the thing worth rewarding.
   *
   *  The counter therefore advances only on a fresh credit, never on a replay. */
  async function earnVoteCast(
    matrixId: string, platform: string, messageId: number
  ): Promise<{ awarded: number }> {
    const lit = await clockLit(matrixId);
    const rules = deps.rules();
    return inStream(matrixId, async (client, state, streamId) => {
      const points = voteCastAward({ votesAwarded: Number(state.votes_awarded) }, rules);
      if (points === 0) return { awarded: 0 };
      const ref = `vote:${matrixId}:${streamId}:${platform}:${messageId}`;
      const r = await creditOn(client, matrixId, points, "earn_vote", ref, null);
      if (r.replay) return { awarded: 0 };
      const bonus = await creditBonus(client, matrixId, points, "earn_vote", ref, lit, rules);
      await client.query(
        `UPDATE site.coin_earn_stream SET votes_awarded = $3
          WHERE matrix_id = $1 AND stream_id = $2`,
        [matrixId, streamId, Number(state.votes_awarded) + 1]
      );
      return { awarded: points + bonus };
    }, { awarded: 0 });
  }

  /** Keyed to the message for the same reason as earnVoteCast: re-upvoting one
   *  message must never pay the author twice, so `paid` counts DISTINCT
   *  messages from that voter. */
  async function earnUpvoteReceived(
    recipient: string, voter: string, platform: string, messageId: number
  ): Promise<{ awarded: number }> {
    // Before anything else. Upvoting yourself must pay nothing, and it must
    // not even open a transaction.
    if (recipient === voter) return { awarded: 0 };
    const lit = await clockLit(recipient); // the recipient earns, so the recipient's clock decides
    const rules = deps.rules();

    return inStream(recipient, async (client, _state, streamId) => {
      // Locked so two upvotes from the same voter cannot both read the same
      // `paid` and both pay.
      await client.query(
        `INSERT INTO site.coin_earn_upvotes (recipient, voter, stream_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [recipient, voter, streamId]
      );
      const { rows } = await client.query<{ paid: string }>(
        `SELECT paid FROM site.coin_earn_upvotes
          WHERE recipient = $1 AND voter = $2 AND stream_id = $3
          FOR UPDATE`,
        [recipient, voter, streamId]
      );
      const paid = Number(rows[0]?.paid ?? 0);
      const points = upvoteReceivedAward(paid, rules);
      if (points === 0) return { awarded: 0 };

      const ref = `up:${recipient}:${voter}:${streamId}:${platform}:${messageId}`;
      const r = await creditOn(client, recipient, points, "earn_upvote", ref, null);
      if (r.replay) return { awarded: 0 };
      const bonus = await creditBonus(client, recipient, points, "earn_upvote", ref, lit, rules);
      await client.query(
        `UPDATE site.coin_earn_upvotes SET paid = $4
          WHERE recipient = $1 AND voter = $2 AND stream_id = $3`,
        [recipient, voter, streamId, paid + 1]
      );
      return { awarded: points + bonus };
    }, { awarded: 0 });
  }

  /** A watch heartbeat. The client beats every ~60s while signed in, the stream
   *  is live and the tab is visible; the ROUTE verifies liveness.
   *
   *  The elapsed time is computed HERE from the stored last_beat, never sent
   *  by the client — a client-supplied delta is a mint button, and clamping it
   *  would only bound the theft. The clamp exists for a different reason: two
   *  tabs, or a replayed request, must collapse to real elapsed time. */
  async function recordWatchHeartbeat(
    matrixId: string
  ): Promise<{
    awarded: number; watchPoints: number; capped: boolean; balance: number | null;
    chips: EarnChipItem[];
  }> {
    const rules = deps.rules();
    return inStream(matrixId, async (client, state, streamId) => {
      const now = deps.nowMs();
      const last = toMs(state.last_beat);
      // First beat of the stream banks nothing: there is no interval yet, and
      // crediting from a null last_beat would pay for time before the viewer
      // arrived.
      const elapsed = last === null ? 0 : Math.max(0, (now - last) / 1_000);
      const delta = Math.min(HEARTBEAT_MAX_DELTA_S, Math.round(elapsed));
      const watchPoints = Number(state.watch_points);
      const seconds = Number(state.watch_seconds) + delta;
      const award = watchAward({ watchPoints, watchSeconds: seconds }, rules);

      // The response carries the fresh balance so the wallet chip updates
      // without a second round trip (useCoinHeartbeat reads it).
      let balance: number | null = null;
      if (award.points > 0) {
        const r = await creditOn(
          client, matrixId, award.points, "earn_watch",
          `watch:${matrixId}:${streamId}:${watchPoints}`, null
        );
        balance = r.balance;
      }
      // READ THE CHIPS BEFORE MOVING THE CURSOR, and inside this same
      // transaction, so the watch credit just written above is included: its
      // created_at is this transaction's NOW(), which is > the PREVIOUS
      // last_beat but NOT > the new one. Reported here or never.
      const chips = await earnChipsSince(client, matrixId, state.last_beat);

      await client.query(
        `UPDATE site.coin_earn_stream
            SET watch_points = $3, watch_seconds = $4, last_beat = NOW()
          WHERE matrix_id = $1 AND stream_id = $2`,
        [matrixId, streamId, watchPoints + award.points, award.secondsLeft]
      );
      return {
        awarded: award.points,
        watchPoints: watchPoints + award.points,
        capped: watchPoints + award.points >= rules.watchCap,
        balance,
        chips,
      };
    }, { awarded: 0, watchPoints: 0, capped: false, balance: null, chips: [] });
  }

  return { earnMessage, earnVoteCast, earnUpvoteReceived, recordWatchHeartbeat };
}

/** Production singleton, the same pattern as `storePricing`.
 *  Consumed by the chat send / vote / heartbeat routes. */
export const earn = createEarn({
  pool,
  currentStreamId: () => currentStream.currentStreamId(),
  nowMs: () => Date.now(),
  clockActive: (matrixId) => clockActiveFor(matrixId),
  rules: () => earnRulesFrom((key) => instanceResolve(key).value),
});
