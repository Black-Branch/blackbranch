import type { Pool, PoolClient } from "pg";
import type Stripe from "stripe";
// Relative `.ts` imports throughout: giftServer.db.test.ts loads this module under node --test.
import pool from "../../lib/db.ts";
import { invalidateTier } from "./entitlements.ts";
import { grantSubscriberBadge } from "./billingServer.ts";
import { invalidateBadgeSnapshot } from "./badgeCache.ts";
import { notifyBadgesChanged } from "./streamApi.ts";
// The retrying, loud-on-loss celebration delivery — the gift
// announce credits the bar with real money, so it gets the same durability as
// the donation/sub cards.
import { broadcastChatEvent } from "./chatEventDelivery.ts";
import { staffMatrixIds } from "./staff.ts";
import { isDiscordGhost, discordGhostPattern } from "./discordSender.ts";
// The localpart fallback rule lives in ONE place (matrixConfig.ts, re-exported by chatIdentity.ts).
import { matrixServerName, matrixLocalpart as fallbackName } from "./matrixConfig.ts";
import { isGiftMonths, MAX_COMMUNITY } from "./giftPricing.ts";
import { supporterPrice } from "./supporterPrice.ts";
import { queuedGiftStart, realignQueuedGifts, viewersWithQueuedGifts } from "./subscriptions/giftQueue.ts";
import { columnEntitledSql, paidThroughSql, subscriptionSources } from "./subscriptions/entitlement.ts";

/** A connection or a transaction's client: the grant, the badge and the pending slots of one
 *  delivery run on the same transaction. */
type Db = Pick<PoolClient, "query">;

/** A refund or dispute of a gift's payment (paymentReversalsLedger.ts): its ref, the amount in the
 *  payment's minor units (null = the whole payment), and the purchase's own gross and slot count. */
type GiftReversal = { sessionId: string; ref: string; reason: "refund" | "dispute"; amount: number | null; gross: number | null;
  /** The purchase's own slot count (its Checkout session: 1 direct, `count` community). */
  slots?: number | null };

/** What one gift session announces. */
type GiftAnnounce = {
  gifter: string | null;
  anonymous: boolean;
  giftKind: "direct" | "community";
  months: number;
  recipients: string[];
  /** The subs bought: 1 for a direct gift, the community gift's slots. A community gift whose every
   *  slot is parked (no eligible user at purchase) is still announced and credited, by this count. */
  slots: number;
  amountCents: number;
  /** The currency `amountCents` was charged in: the Supporter price's (a gift charges that). */
  currency: string;
  sessionId: string;
  /** A direct gift queued behind its recipient's subscription. The card is PUBLIC, so it carries only
   *  this flag — the start date is the recipient's renewal date, shown to them alone (/api/me). */
  queued?: boolean;
};

/** Whether a gift is announced (and so credited): a community gift always — at purchase, even
 *  with every slot parked for the next sign-ups (its money is the streamer's either way) — and a
 *  direct gift once it has its recipient.
 *  @test-only announceGift below is its caller; exported so giftServer.db.test.ts runs the rule
 *  (its recorder replaces announceGift, so the rule is not reached through it). */
export function giftAnnounced(a: Pick<GiftAnnounce, "giftKind" | "recipients">): boolean {
  return a.giftKind === "community" || a.recipients.length > 0;
}

// Announce a gift into live chat (#3): "X gifted N sub(s) to A, B, C". Recipients
// are listed by name for both direct and community gifts; an anonymous gifter
// shows as "Anonymous". Sent on EVERY delivery of the session with every recipient
// it has granted: the announce is what credits the bar and support_events, and
// stream-api's ledger dedups on the session's spendId, so a redelivery after a
// restart (or a lost first announce) credits it then, and a redelivery after a
// good one credits nothing more and posts no second card.
async function announceGift(a: GiftAnnounce): Promise<void> {
  const { gifter: gifterMatrixId, anonymous, giftKind, months, recipients, slots, amountCents, currency, sessionId } = a;
  if (!giftAnnounced(a)) return;
  const ids = [...recipients, ...(gifterMatrixId ? [gifterMatrixId] : [])];
  const { rows } = await pool
    .query(`SELECT matrix_id, display_name, username_color, username_style FROM site.users WHERE matrix_id = ANY($1::text[])`, [ids])
    .catch(() => ({ rows: [] as { matrix_id: string; display_name: string | null; username_color: string | null; username_style: object | null }[] }));
  const nameOf = (mid: string) =>
    rows.find((r) => r.matrix_id === mid)?.display_name || fallbackName(mid);
  const colorOf = (mid: string) => rows.find((r) => r.matrix_id === mid)?.username_color ?? null;
  const styleOf = (mid: string) => rows.find((r) => r.matrix_id === mid)?.username_style ?? null;
  // `amount` (the full Stripe charge for this gift) lets stream-api credit the
  // support bar + support_events — gift subs are income.
  await broadcastChatEvent({
    kind: "gift",
    // Session-derived idempotency key: /chat/event and the ledger dedup on it,
    // so the announce sent on every delivery credits the bar ONCE.
    spendId: `gift:${sessionId}`,
    gifter: anonymous || !gifterMatrixId ? "Anonymous" : nameOf(gifterMatrixId),
    gifterColor: anonymous || !gifterMatrixId ? null : colorOf(gifterMatrixId),
    gifterMatrixId: anonymous ? null : gifterMatrixId,
    usernameStyle: anonymous || !gifterMatrixId ? null : styleOf(gifterMatrixId),
    anonymous,
    giftKind,
    months,
    count: slots,
    // "queued after their current subscription" on the card, never a date (A1-03).
    queued: a.queued === true,
    amount: amountCents,
    // stream-api reads an ABSENT currency as US dollars, so a gift on a site whose Supporter price
    // is in euros or yen was credited as that many dollars. It refuses (and pages) a non-USD credit.
    currency,
    recipients: recipients.map((mid) => ({ name: nameOf(mid), matrixId: mid })),
  });
}

// Server-side gift-subscription logic: recipient resolution, community selection,
// granting (called by the webhook), and the expiry sweep.

// Whether a resolved user may receive a gift. Excludes staff/bot (comp Supporters,
// shared staffMatrixIds()) and mautrix Discord ghosts (which never log in).
export function isGiftableRecipient(matrixId: string): boolean {
  if (staffMatrixIds().has(matrixId)) return false;
  if (isDiscordGhost(matrixId)) return false;
  return true;
}

// Resolve a typed username to a registered user. Accepts a full @mxid, the local
// part (on this install's server, matrix.serverName), or a display name. Returns null when no match.
export async function resolveRecipient(
  input: string
): Promise<{ matrixId: string; displayName: string | null } | null> {
  const raw = input.trim();
  if (!raw) return null;
  const clean = raw.replace(/^@/, "");
  const { rows } = await pool
    .query(
      `SELECT matrix_id, display_name FROM site.users
       WHERE lower(matrix_id) = lower($1)
          OR lower(matrix_id) = lower('@' || $2 || ':' || $3::text)
          OR lower(display_name) = lower($2)
       ORDER BY (lower(matrix_id) = lower('@' || $2 || ':' || $3::text)) DESC
       LIMIT 1`,
      [raw, clean, matrixServerName()]
    )
    .catch(() => ({ rows: [] as { matrix_id: string; display_name: string | null }[] }));
  return rows[0] ? { matrixId: rows[0].matrix_id, displayName: rows[0].display_name } : null;
}

// Prefix-search registered users for the gift recipient autocomplete. Matches on
// either the local part (the @x:<server> → x form people type) or the display
// name; excludes the caller, staff/bot, and Discord ghosts. Returns up to 8.
export async function suggestRecipients(
  query: string,
  selfMatrixId: string | null
): Promise<{ username: string; displayName: string | null }[]> {
  const q = query.trim().replace(/^@/, "");
  if (q.length < 1) return [];
  const like = `${q.replace(/[%_\\]/g, "\\$&")}%`;
  const { rows } = await pool
    .query(
      `SELECT matrix_id, display_name FROM site.users
       WHERE (matrix_id ILIKE '@' || $1 ESCAPE '\\' OR display_name ILIKE $1 ESCAPE '\\')
         AND ($2::text IS NULL OR matrix_id <> $2)
         AND ($3::text IS NULL OR matrix_id !~ $3)
       ORDER BY (matrix_id ILIKE '@' || $1 ESCAPE '\\') DESC, length(display_name), display_name
       LIMIT 16`,
      [like, selfMatrixId, discordGhostPattern()]
    )
    .catch(() => ({ rows: [] as { matrix_id: string; display_name: string | null }[] }));
  return rows
    .filter((r) => isGiftableRecipient(r.matrix_id))
    .slice(0, 8)
    .map((r) => ({ username: fallbackName(r.matrix_id), displayName: r.display_name }));
}

// Pick up to `count` random recipients for a community gift: registered users who
// aren't the gifter and aren't already Supporters (own sub or active gift).
// Priority: chatted in the last day → last two weeks → anyone, random within tier.
// No catch: an error read as "nobody to pick" would park every slot for strangers
// to claim; a throw 500s the webhook and Stripe redelivers.
async function selectCommunityRecipients(db: Db, count: number, gifter: string | null): Promise<string[]> {
  const capped = Math.min(Math.max(Math.trunc(count), 0), MAX_COMMUNITY);
  if (capped === 0) return [];
  const { rows } = await db.query<{ matrix_id: string }>(
      `SELECT u.matrix_id FROM site.users u
       WHERE ($1::text IS NULL OR u.matrix_id <> $1)
         AND u.matrix_id <> ALL($3::text[])
         AND ($4::text IS NULL OR u.matrix_id !~ $4)
         AND NOT ${columnEntitledSql("u.matrix_id", "$5")}
         AND NOT EXISTS (
           SELECT 1 FROM site.gift_subscriptions g
           WHERE g.recipient_matrix_id = u.matrix_id AND g.expires_at > now()
         )
       ORDER BY
         EXISTS (SELECT 1 FROM site.chat_messages c WHERE c.matrix_id = u.matrix_id AND c.created_at > now() - interval '1 day') DESC,
         EXISTS (SELECT 1 FROM site.chat_messages c WHERE c.matrix_id = u.matrix_id AND c.created_at > now() - interval '14 days') DESC,
         random()
       LIMIT $2`,
      [gifter, capped, [...staffMatrixIds()], discordGhostPattern(), subscriptionSources()]
    );
  return rows.map((r) => r.matrix_id);
}

// Park leftover community-gift slots for future sign-ups to claim (one per new
// account). Unclaimed slots expire in 90 days.
async function addPendingGifts(
  db: Db,
  sessionId: string,
  gifter: string | null,
  months: number,
  n: number,
  anonymous: boolean
): Promise<void> {
  if (n <= 0) return;
  await db.query(
    `INSERT INTO site.gift_pending (stripe_session_id, gifter_matrix_id, months, anonymous, claim_expires_at)
     SELECT $1, $2, $3, $5, now() + interval '90 days' FROM generate_series(1, $4)`,
    [sessionId, gifter, months, n, anonymous]
  );
}

// Insert one gift grant with additive (stacked) expiry. Returns true if a new row
// was written (false on idempotent webhook retry). Run inside the delivery's
// transaction, under the recipient's viewer lock (lockViewers).
async function grantGift(
  db: Db,
  sessionId: string,
  gifter: string | null,
  recipient: string,
  months: number,
  kind: "direct" | "community",
  anonymous: boolean
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO site.gift_subscriptions
       (stripe_session_id, gifter_matrix_id, recipient_matrix_id, tier, months, kind, anonymous, follows_subscription, starts_at, expires_at)
     SELECT $1, $2, $3, 'supporter', $4, $5, $6,
       -- Granted behind paid time: the gift FOLLOWS the subscription, re-dated whenever the paid
       -- term moves, so it begins when the paying stops (subscriptions/giftQueue.ts, A1-03).
       COALESCE(${paidThroughSql("$3", "$7")} > now(), false),
       -- The start is stored, never derived back from the end (month arithmetic clamps; migrate-v172).
       s.start, s.start + make_interval(months => $4)
       FROM (SELECT GREATEST(
         now(),
         COALESCE((SELECT MAX(expires_at) FROM site.gift_subscriptions WHERE recipient_matrix_id = $3), now()),
         -- A recipient on a PAID sub — through any service that counts — gets the
         -- gift AFTER their paid period, not concurrently with it (the gift was
         -- otherwise partly wasted). The records' one entitlement fragment decides.
         COALESCE(${paidThroughSql("$3", "$7")}, now())
       ) AS start) s
     ON CONFLICT (stripe_session_id, recipient_matrix_id) DO NOTHING
     RETURNING id`,
    [sessionId, gifter, recipient, months, kind, anonymous, subscriptionSources()]
  );
  return (res.rowCount ?? 0) > 0;
}

/** The viewer locks of every recipient, in one sorted order (two community gifts sharing
 *  recipients cannot deadlock). The same key the subscription paths take first
 *  (subscriptionSync.ts, stripeCustomer.ts), so a gift's start date is read against the
 *  recipient's records as no other billing write is moving them. */
async function lockViewers(db: Db, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`billing:viewer:${id}`]);
  }
}

/** @parked consumed by the production binding below and by giftServer.db.test.ts; exported so
 *  the test can drive a real throwaway pool and record the badge writes and announces. */
export function createGiftRecorder(deps: {
  pool: Pool;
  /** The Supporter badge unlock + equip, on the delivery's transaction. */
  grantBadge: (db: Db, matrixId: string) => Promise<void>;
  announce: (a: GiftAnnounce) => Promise<void>;
  /** After the commit: drop cached tiers, tell stream-api the badges moved. */
  granted: (ids: string[]) => void;
  /** The Supporter price's currency: the one source of a gift's, when a session carries none. */
  priceCurrency: () => Promise<string | null>;
}) {
  /** Run `work` in one transaction: every grant, badge and pending slot of it lands, or none. */
  async function inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await work(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // Claim the oldest unclaimed rollover slot for a brand-new account, if any. Grants the gifted sub +
  // badge with the claim, in one transaction, under the purchase's lock and then the member's — the
  // order recordGift and lockSession take — so a refund of the same purchase (endGift) and the claim
  // serialise: only a slot still unwithdrawn under that lock is claimed, and a refund that stands
  // already is applied before the badge (settleReversals). A candidate taken by another claim or
  // withdrawn meanwhile is skipped and the NEXT one tried — the ones already tried are excluded, so
  // simultaneous sign-ups (a raid) each end on a different slot and none gives up while one is free —
  // each in its own transaction (a second purchase lock after a member lock would break the lock
  // order). No row lock before the purchase lock: a refund takes the purchase lock, then the slots'
  // rows, so a claim holding a slot row while waiting for the purchase would deadlock with it.
  async function claimPendingGift(matrixId: string): Promise<void> {
    const tried: string[] = [];
    for (;;) {
      const candidate = (await deps.pool.query<{ id: string; stripe_session_id: string }>(
        `SELECT id, stripe_session_id FROM site.gift_pending
          WHERE claimed_by IS NULL AND reversed_by IS NULL AND claim_expires_at > now() AND id <> ALL($1::bigint[])
          ORDER BY created_at ASC, id ASC LIMIT 1`, [tried])).rows[0];
      if (!candidate) return;
      tried.push(candidate.id);
      const outcome = await inTransaction(async (db) => {
        await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [candidate.stripe_session_id]);
        await lockViewers(db, [matrixId]);
        const { rows } = await db.query<{ stripe_session_id: string; gifter_matrix_id: string | null; months: number; anonymous: boolean }>(
          `UPDATE site.gift_pending SET claimed_by = $1, claimed_at = now()
            WHERE id = $2 AND claimed_by IS NULL AND reversed_by IS NULL AND claim_expires_at > now()
            RETURNING stripe_session_id, gifter_matrix_id, months, anonymous`,
          [matrixId, candidate.id]
        );
        const slot = rows[0];
        if (!slot) return "retry" as const; // claimed by someone else, or withdrawn by a refund, meanwhile
        const granted = await grantGift(db, slot.stripe_session_id, slot.gifter_matrix_id, matrixId, slot.months, "community", slot.anonymous);
        if (!granted) return "none" as const;
        if ((await settleReversals(db, slot.stripe_session_id)).ended.includes(matrixId)) return "none" as const;
        await deps.grantBadge(db, matrixId);
        return "granted" as const;
      });
      if (outcome === "granted") deps.granted([matrixId]);
      if (outcome !== "retry") return;
    }
  }

  // Webhook entry point: record a completed gift payment. Direct gifts grant the
  // named recipient; community gifts pick N random recipients now (fresh pool).
  //
  // One transaction per delivery: the grants, their badges and any parked slots all
  // land or none do, so a failure (a badge write, a DB blip) leaves nothing behind
  // and the redelivery Stripe makes after the 500 grants as if it were the first.
  // The announce runs after the commit, on every delivery (announceGift).
  async function recordGift(cs: Stripe.Checkout.Session): Promise<void> {
    if (cs.payment_status !== "paid") return;
    const meta = cs.metadata ?? {};
    const months = parseInt(meta.months ?? "", 10);
    if (!isGiftMonths(months)) {
      console.error("[gift] invalid months", meta.months);
      return;
    }
    const gifter = meta.gifter_matrix_id || null;
    const giftType = meta.gift_type === "community" ? "community" : "direct";
    const anonymous = meta.anonymous === "1";

    let grantedNow: string[];
    let slots = 1;
    if (giftType === "direct") {
      const recipient = meta.recipient_matrix_id;
      if (!recipient) {
        console.error("[gift] direct gift missing recipient for session", cs.id);
        return;
      }
      grantedNow = await inTransaction(async (db) => {
        // The session's lock first, then the viewer's — lockSession's order, so a refund of this
        // purchase (endGift) and its grant serialise and never deadlock.
        await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [cs.id]);
        await lockViewers(db, [recipient]);
        if (!(await grantGift(db, cs.id, gifter, recipient, months, "direct", anonymous))) return [];
        // A refund or dispute that arrived before this grant (a failed first delivery Stripe redelivers)
        // is HELD in site.gift_reversals: applied here, in the transaction that writes the grant.
        if ((await settleReversals(db, cs.id)).ended.includes(recipient)) return [];
        await deps.grantBadge(db, recipient);
        return [recipient];
      });
    } else {
      const count = parseInt(meta.count ?? "", 10);
      if (!Number.isFinite(count) || count < 1) {
        console.error("[gift] community gift bad count", meta.count);
        return;
      }
      slots = count;
      grantedNow = await inTransaction(async (db) => {
        // Serialize deliveries of the SAME session. Stripe is at-least-once, and
        // tally-then-grant with a RANDOM recipient pick would let two concurrent
        // deliveries both read remaining=count, pick DIFFERENT recipients
        // (per-recipient ON CONFLICT can't dedup across sets) and both grant.
        // The second delivery's tally sees the first's rows and grants nothing.
        await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [cs.id]);
        // No catch: a `.catch(() => granted:0/pending:0)` would turn a DB blip
        // into "nothing processed yet" — an over-grant. A throw 500s the webhook
        // and Stripe redelivers later, which is the safe failure.
        const { rows: tally } = await db.query(
          `SELECT
             (SELECT count(*) FROM site.gift_subscriptions WHERE stripe_session_id = $1) AS granted,
             (SELECT count(*) FROM site.gift_pending      WHERE stripe_session_id = $1) AS pending`,
          [cs.id]
        );
        const already = Number(tally[0]?.granted ?? 0) + Number(tally[0]?.pending ?? 0);
        const remaining = count - already;
        if (remaining <= 0) return []; // fully processed already
        const recipients = await selectCommunityRecipients(db, remaining, gifter);
        await lockViewers(db, recipients);
        const now: string[] = [];
        for (const recipient of recipients) {
          if (await grantGift(db, cs.id, gifter, recipient, months, "community", anonymous)) now.push(recipient);
        }
        // Anything we couldn't hand out now rolls over to future sign-ups.
        await addPendingGifts(db, cs.id, gifter, months, remaining - recipients.length, anonymous);
        // A refund or dispute that arrived before these grants is HELD (site.gift_reversals): applied
        // here, in the transaction that writes them, so nothing it covers is ever granted or claimable.
        const ended = (await settleReversals(db, cs.id)).ended;
        const kept = now.filter((r) => !ended.includes(r));
        for (const recipient of kept) await deps.grantBadge(db, recipient);
        return kept;
      });
    }
    if (grantedNow.length) deps.granted(grantedNow);

    // Every recipient this session has granted, on every delivery — not only this delivery's.
    const { rows } = await deps.pool.query<{ recipient_matrix_id: string }>(
      `SELECT recipient_matrix_id FROM site.gift_subscriptions WHERE stripe_session_id = $1 AND kind = $2 ORDER BY id`,
      [cs.id, giftType]
    );
    await deps.announce({
      gifter, anonymous, giftKind: giftType, months,
      recipients: rows.map((r) => r.recipient_matrix_id),
      slots,
      queued: giftType === "direct" && rows.length === 1 && (await queuedGiftStart(deps.pool, rows[0]!.recipient_matrix_id)) !== null,
      amountCents: cs.amount_total ?? 0, currency: await giftCurrency(cs), sessionId: cs.id,
    });
  }

  /** The currency the gift was charged in: the session's, else the Supporter price's — never a
   *  literal. With neither, ISO 4217's "no currency" code, which stream-api refuses to credit and
   *  pages about rather than counting it as dollars. */
  async function giftCurrency(cs: Stripe.Checkout.Session): Promise<string> {
    const c = cs.currency || (await deps.priceCurrency().catch(() => null));
    if (c) return c.toLowerCase();
    console.error("[gift] no currency for session %s — announced uncredited", cs.id);
    return "xxx";
  }

  /** A gift purchase's state against every refund and dispute of it still standing (site.gift_reversals,
   *  restored_at IS NULL), computed CUMULATIVELY per session inside the caller's transaction (push
   *  review, round 3): their amounts add up against the purchase's own price and slot count (stored
   *  on the reversal from its Checkout session, never read off the live rows). A direct gift ends on any
   *  reversal; a whole purchase covered ends everything; otherwise floor(total / slot price) items end,
   *  unclaimed LIVE slots first, then granted gifts newest first. Only the difference between what
   *  should be ended and what already is changes: more ends, or — after a restore — the surplus comes
   *  back (granted gifts first, each with the time it had left), so a row stays ended while any standing
   *  reversal still covers it. The session's remainder (money covering no whole slot) is carried on its
   *  latest standing reversal for the Doctor. Returns who was ended and who was restored. */
  async function settleReversals(db: PoolClient, sessionId: string): Promise<{ ended: string[]; restored: string[] }> {
    const revs = (await db.query<{ ref: string; amount_cents: number | null; purchase_cents: number | null; purchase_slots: number | null }>(
      `SELECT ref, amount_cents, purchase_cents, purchase_slots FROM site.gift_reversals
        WHERE stripe_session_id = $1 AND restored_at IS NULL ORDER BY created_at, ref`, [sessionId])).rows;
    const kinds = (await db.query<{ kind: string }>(`SELECT DISTINCT kind FROM site.gift_subscriptions WHERE stripe_session_id = $1`, [sessionId])).rows;
    const direct = kinds.length > 0 && kinds.every((k) => k.kind === "direct");
    const label = revs.at(-1)?.ref ?? null;
    const price = revs.find((r) => r.purchase_cents != null)?.purchase_cents ?? null;
    const slots = revs.find((r) => r.purchase_slots != null)?.purchase_slots ?? null;
    const slotCents = price != null && slots ? Math.floor(price / slots) : null;
    const total = revs.reduce((a, r) => a + (r.amount_cents ?? 0), 0);
    const whole = revs.length > 0 && (direct || revs.some((r) => r.amount_cents == null) || price == null || !slotCents || total >= price);
    // How many items (unclaimed slots + granted gifts) the standing reversals pay for.
    const target = revs.length === 0 ? 0 : whole ? Number.POSITIVE_INFINITY : Math.floor(total / slotCents!);
    const remainder = revs.length === 0 || whole ? 0 : total - target * slotCents!;

    const endedSlots = Number((await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM site.gift_pending WHERE stripe_session_id = $1 AND reversed_by IS NOT NULL`, [sessionId])).rows[0]?.n ?? 0);
    const endedGrants = Number((await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM site.gift_subscriptions WHERE stripe_session_id = $1 AND reversed_by IS NOT NULL`, [sessionId])).rows[0]?.n ?? 0);
    const already = endedSlots + endedGrants;
    const ended: string[] = [];
    const restored: string[] = [];

    if (target > already && label) {
      const more = target === Number.POSITIVE_INFINITY ? null : target - already;
      // Only LIVE unclaimed slots: an expired one is worth nothing and never counts as covered.
      const w = await db.query(
        `UPDATE site.gift_pending SET reversed_by = $2
          WHERE id IN (SELECT id FROM site.gift_pending
                        WHERE stripe_session_id = $1 AND claimed_by IS NULL AND reversed_by IS NULL AND claim_expires_at > now()
                        ORDER BY id DESC LIMIT $3)`, [sessionId, label, more]);
      const left = more === null ? null : more - (w.rowCount ?? 0);
      if (left === null || left > 0) {
        const g = await db.query<{ recipient_matrix_id: string }>(
          `UPDATE site.gift_subscriptions
              SET reversed_by = $2, reversed_at = now(), expires_before_reversal = expires_at, follows_before_reversal = follows_subscription,
                  expires_at = LEAST(expires_at, now()), follows_subscription = false
            WHERE id IN (SELECT id FROM site.gift_subscriptions
                          WHERE stripe_session_id = $1 AND reversed_by IS NULL AND expires_at > now()
                          ORDER BY id DESC LIMIT $3)
            RETURNING recipient_matrix_id`, [sessionId, label, left]);
        ended.push(...g.rows.map((x) => x.recipient_matrix_id));
      }
    } else if (target < already) {
      // The surplus comes back: granted gifts first (newest ended first), then slots.
      let back = already - target;
      const g = await db.query<{ recipient_matrix_id: string }>(
        `UPDATE site.gift_subscriptions s
            SET expires_at = s.expires_before_reversal + (now() - s.reversed_at),
                -- A gift ended before it began comes back later by the same time, so it still runs
                -- its whole months; one that had begun keeps the day it began.
                starts_at = CASE WHEN s.starts_at > s.reversed_at THEN s.starts_at + (now() - s.reversed_at) ELSE s.starts_at END,
                follows_subscription = COALESCE(s.follows_before_reversal, false),
                reversed_by = NULL, reversed_at = NULL, expires_before_reversal = NULL, follows_before_reversal = NULL
           FROM site.gift_reversals v
          WHERE v.ref = s.reversed_by
            AND s.id IN (SELECT id FROM site.gift_subscriptions WHERE stripe_session_id = $1 AND reversed_by IS NOT NULL
                          ORDER BY id DESC LIMIT $2)
          RETURNING s.recipient_matrix_id`, [sessionId, back]);
      restored.push(...g.rows.map((x) => x.recipient_matrix_id));
      back -= g.rows.length;
      if (back > 0) {
        await db.query(
          `UPDATE site.gift_pending SET reversed_by = NULL
            WHERE id IN (SELECT id FROM site.gift_pending WHERE stripe_session_id = $1 AND reversed_by IS NOT NULL
                          ORDER BY id DESC LIMIT $2)`, [sessionId, back]);
      }
    }
    // Anything still ended belongs to a reversal that still stands (a restored one's rows move to it).
    if (label) {
      await db.query(
        `UPDATE site.gift_subscriptions SET reversed_by = $2 WHERE stripe_session_id = $1 AND reversed_by IS NOT NULL AND reversed_by <> $2
            AND reversed_by IN (SELECT ref FROM site.gift_reversals WHERE stripe_session_id = $1 AND restored_at IS NOT NULL)`, [sessionId, label]);
      await db.query(
        `UPDATE site.gift_pending SET reversed_by = $2 WHERE stripe_session_id = $1 AND reversed_by IS NOT NULL AND reversed_by <> $2
            AND reversed_by IN (SELECT ref FROM site.gift_reversals WHERE stripe_session_id = $1 AND restored_at IS NOT NULL)`, [sessionId, label]);
    }
    await db.query(`UPDATE site.gift_reversals SET remainder_cents = CASE WHEN ref = $2 THEN $3 ELSE 0 END WHERE stripe_session_id = $1`,
      [sessionId, label, remainder]);
    if (remainder > 0) {
      console.warn("[gift] partial reversals of session %s: %d (minor units) cover no whole slot — no gift ended for it; the Doctor lists it",
        sessionId, remainder);
    }
    return { ended, restored };
  }

  /** The session's recipients, locked: the session first (as recordGift takes it), then each viewer. */
  async function lockSession(db: PoolClient, sessionId: string): Promise<void> {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [sessionId]);
    const who = await db.query<{ recipient_matrix_id: string }>(
      `SELECT DISTINCT recipient_matrix_id FROM site.gift_subscriptions WHERE stripe_session_id = $1`, [sessionId]);
    await lockViewers(db, who.rows.map((r) => r.recipient_matrix_id));
  }

  /** A refund or dispute of the gift's payment (paymentReversalsLedger.ts, beside the ledger
   *  reversal; A1-09 / P10): recorded per ref with the purchase's own price and slot count, then the
   *  session re-derived (settleReversals). Idempotent per ref; returns the recipients it ended. A
   *  redelivered purchase never revives an ended gift (grantGift's ON CONFLICT keeps the ended row). */
  async function endGift(g: GiftReversal): Promise<string[]> {
    const ended = await inTransaction(async (db) => {
      await lockSession(db, g.sessionId);
      const slots = g.slots != null && g.slots > 0 ? g.slots : null;
      const fresh = await db.query(
        `INSERT INTO site.gift_reversals (ref, stripe_session_id, reason, amount_cents, purchase_cents, purchase_slots, slot_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (ref) DO NOTHING RETURNING ref`,
        [g.ref, g.sessionId, g.reason, g.amount, g.gross, slots, g.gross != null && slots ? Math.floor(g.gross / slots) : null]);
      if (!fresh.rows.length) return []; // this reversal was handled already
      return (await settleReversals(db, g.sessionId)).ended;
    });
    if (ended.length) deps.granted(ended);
    return ended;
  }

  /** The refund failed or was cancelled, the dispute was won, or the inquiry closed harmlessly: that
   *  reversal is marked restored and the session re-derived from the ones still standing — a gift
   *  comes back only when nothing covers it any more (review R3; no fail-open across overlapping
   *  reversals). Idempotent; returns the recipients it restored. */
  async function restoreGift(ref: string): Promise<string[]> {
    const restored = await inTransaction(async (db) => {
      const rev = await db.query<{ stripe_session_id: string }>(
        `SELECT stripe_session_id FROM site.gift_reversals WHERE ref = $1 AND restored_at IS NULL`, [ref]);
      const sessionId = rev.rows[0]?.stripe_session_id;
      if (!sessionId) return [];
      await lockSession(db, sessionId);
      const marked = await db.query(`UPDATE site.gift_reversals SET restored_at = now() WHERE ref = $1 AND restored_at IS NULL RETURNING ref`, [ref]);
      if (!marked.rows.length) return [];
      const back = (await settleReversals(db, sessionId)).restored;
      // A gift that was queued behind a subscription re-dates against the paid term now.
      for (const viewer of new Set(back)) await realignQueuedGifts(db, viewer, subscriptionSources());
      return back;
    });
    if (restored.length) deps.granted(restored);
    return restored;
  }

  return { recordGift, claimPendingGift, endGift, restoreGift };
}

const recorder = createGiftRecorder({
  pool,
  priceCurrency: async () => (await supporterPrice())?.currency ?? null,
  grantBadge: (db, matrixId) => grantSubscriberBadge(matrixId, db),
  announce: announceGift,
  granted: (ids) => {
    for (const id of ids) invalidateTier(id);
    invalidateBadgeSnapshot(); // again after the commit: a read between the write and the commit cached the old state
    void notifyBadgesChanged();
  },
});
export const recordGift = recorder.recordGift;
export const claimPendingGift = recorder.claimPendingGift;
export const endRefundedGift = recorder.endGift;
export const restoreRefundedGift = recorder.restoreGift;

// ── Expiry sweep ─────────────────────────────────────────────────────────────
// The cosmetic Supporter badge no longer needs sweeping: badge SLOTS are derived
// live from entitlement (base_slots + a +1 for an active sub/gift, see badge_slots
// / api/badges), so when a gift lapses the +1 slot — and thus the equipped sub
// badge — simply stops rendering with no stored state to clean up. Kept as a no-op
// so startGiftExpirySweep()'s wiring is unchanged.
async function sweepExpiredGiftBadges(): Promise<number> {
  return 0;
}

// Re-date every gift still queued behind a subscription (giftQueue.ts): the transition function
// does it as the paid term moves; this catches the gifts migrate-v167 marked, and anything a missed
// webhook left. Each recipient in its own transaction, under their billing lock.
async function sweepQueuedGifts(): Promise<number> {
  let moved = 0;
  for (const viewer of await viewersWithQueuedGifts(pool)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockViewers(client, [viewer]);
      moved += await realignQueuedGifts(client, viewer, subscriptionSources());
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return moved;
}

// Drop unclaimed rollover slots that nobody signed up to claim in time.
async function sweepExpiredPendingGifts(): Promise<number> {
  const res = await pool
    .query(`DELETE FROM site.gift_pending WHERE claimed_by IS NULL AND claim_expires_at <= now()`)
    .catch((e) => {
      console.error("[gift] pending sweep failed", e);
      return { rowCount: 0 };
    });
  return res.rowCount ?? 0;
}

let sweepStarted = false;
export function startGiftExpirySweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  const run = async () => {
    const queued = await sweepQueuedGifts().catch((e) => { console.error("[gift] queued-gift sweep failed", e); return 0; });
    if (queued > 0) console.log(`[gift] re-dated ${queued} gift(s) queued behind a subscription`);
    const badges = await sweepExpiredGiftBadges().catch(() => 0);
    if (badges > 0) console.log(`[gift] swept ${badges} expired Supporter badge(s)`);
    const pending = await sweepExpiredPendingGifts().catch(() => 0);
    if (pending > 0) console.log(`[gift] swept ${pending} expired pending slot(s)`);
  };
  void run();
  setInterval(() => void run(), 60 * 60 * 1000); // hourly
}
