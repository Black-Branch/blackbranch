// Gifts queued behind a paid subscription (area-1 round 2, A1-03 / P08; k 2026-10-25): a gift to
// someone already paying monthly starts AFTER their paid term — never overlapping a month they pay
// for, never pausing their card.
//
// A gift granted while its recipient has paid time ahead (paidThroughSql) is marked
// `follows_subscription` (giftServer.ts grantGift; migrate-v167 for the ones the old rule parked).
// realignQueuedGifts re-dates every such gift whenever the paid term may have moved: the transition
// function calls it in its own transaction (subscriptions/state.ts), and the hourly gift sweep calls
// it for every recipient with one.
//
// A queued gift begins ONLY when the records say the paid term ended — no entitling record that
// still renews or still has paid time ahead (cancelled, unpaid, expired, or a cancel_at reached
// with no renewal), as written through writeTransition — never on the clock alone: between an old
// period end and its renewal's webhook the record still says it renews, and the gift waits (review
// R2, round 2). While the term is open the gift sits at its end. Once the term ended the gift begins
// at that end and is not moved; it keeps following for the grace days, so a renewal confirmed late
// (a delayed webhook, a card paid after Stripe gave up) re-dates it back behind the new term; after
// them it is settled and never moved again.
//
// A gift's start is STORED (`starts_at`, migrate-v172) and moved with its end, never derived from it:
// month arithmetic clamps (Oct 31 + 1 month = Nov 30, and Nov 30 - 1 month = Oct 30), so a start
// derived from the end was a day early at month ends (giftStart.test.ts).
import { paidTermOpenSql, paidThroughSql } from "./entitlement.ts";
import { GRACE_DAYS } from "./grace.ts";

const DAY_MS = 86_400_000;
import type { Provider } from "./types.ts";

type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

type GiftRow = { id: string; start: Date; expires_at: Date; follows: boolean };

/** Re-date the viewer's queued gifts against their paid term now. Returns how many moved. Call it
 *  inside the transaction that changed the paid term (it reads the records that transaction wrote). */
export async function realignQueuedGifts(db: Queryable, viewer: string, sources: readonly Provider[]): Promise<number> {
  const gifts = (await db.query<GiftRow>(
    `SELECT id, starts_at AS start, expires_at, follows_subscription AS follows
       FROM site.gift_subscriptions
      WHERE recipient_matrix_id = $1 AND expires_at > now()
      ORDER BY id`, [viewer])).rows ?? [];
  if (!gifts.some((g) => g.follows)) return 0;
  const term = (await db.query<{ t: Date | null; open: boolean }>(
    `SELECT ${paidThroughSql("$1", "$2")} AS t, ${paidTermOpenSql("$1", "$2")} AS open`, [viewer, sources])).rows?.[0];
  const P = term?.t ? new Date(term.t).getTime() : null;
  const open = term?.open === true;
  const now = Date.now();
  // A running or fixed gift is a floor: a queued gift never overlaps another gift either.
  let floor = Math.max(0, ...gifts.filter((g) => !g.follows).map((g) => new Date(g.expires_at).getTime()));
  let moved = 0;
  for (const g of gifts) {
    if (!g.follows) continue;
    const start = new Date(g.start).getTime();
    // Term open: the gift sits at the paid term's end (a pending renewal keeps it there).
    // Term ended: it begins where it sits (the end it was last dated to), or at the paid end still
    // inside its grace days, never later than another gift's end.
    const next = !open && P === null
      ? Math.max(floor, Math.min(start, now)) // ended with no paid time left (cancelled at once): it begins now
      : Math.max(P ?? start, floor);
    if (!open && next <= now - GRACE_DAYS * DAY_MS) {
      // The term ended more than the grace days ago: settled.
      await db.query(`UPDATE site.gift_subscriptions SET follows_subscription = false WHERE id = $1`, [g.id]);
      floor = Math.max(floor, new Date(g.expires_at).getTime());
      continue;
    }
    if (next !== start) {
      const r = await db.query<{ expires_at: Date }>(
        `UPDATE site.gift_subscriptions SET starts_at = $2::timestamptz, expires_at = $2::timestamptz + make_interval(months => months)
          WHERE id = $1 RETURNING expires_at`, [g.id, new Date(next)]);
      floor = Math.max(floor, new Date(r.rows?.[0]?.expires_at ?? g.expires_at).getTime());
      moved++;
    } else {
      floor = Math.max(floor, new Date(g.expires_at).getTime());
    }
  }
  return moved;
}

/** When the viewer's first queued gift begins (ISO), or null: "your gift starts on <date>, after
 *  your current subscription" (the Support panel, /api/me). */
export async function queuedGiftStart(db: Queryable, viewer: string): Promise<string | null> {
  const { rows } = await db.query<{ start: Date | null }>(
    `SELECT MIN(starts_at) AS start FROM site.gift_subscriptions
      WHERE recipient_matrix_id = $1 AND follows_subscription AND starts_at > now()`, [viewer]);
  const s = rows?.[0]?.start;
  return s ? new Date(s).toISOString() : null;
}

/** Every recipient with a gift still following a subscription — the hourly sweep's list. */
export async function viewersWithQueuedGifts(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ recipient_matrix_id: string }>(
    `SELECT DISTINCT recipient_matrix_id FROM site.gift_subscriptions WHERE follows_subscription AND expires_at > now()`);
  return (rows ?? []).map((r) => r.recipient_matrix_id);
}
