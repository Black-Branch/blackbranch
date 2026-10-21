import type Stripe from "stripe";
import pool from "@/lib/db";
import { invalidateTier } from "./entitlements";
import { grantSubscriberBadge } from "./billingServer";
import { notifyBadgesChanged } from "./streamApi.ts";
// The retrying, loud-on-loss celebration delivery — the gift
// announce credits the bar with real money, so it gets the same durability as
// the donation/sub cards.
import { broadcastChatEvent } from "./chatEventDelivery";
import { staffMatrixIds } from "./staff";
import { isDiscordGhost, discordGhostPattern } from "./discordSender";
import { matrixServerName } from "./matrixConfig";
import { isGiftMonths, MAX_COMMUNITY } from "./giftPricing";
import { columnEntitledSql, paidThroughSql, subscriptionSources } from "./subscriptions/entitlement";
// The localpart fallback rule lives in ONE place (chatIdentity.ts — gift
// announcements are exactly the announce path that module exists for).
import { matrixLocalpart as fallbackName } from "./chatIdentity";

// Announce a gift into live chat (#3): "X gifted N sub(s) to A, B, C". Recipients
// are listed by name for both direct and community gifts; an anonymous gifter
// shows as "Anonymous". Best-effort — never blocks/breaks the grant. Only the
// recipients actually granted in this webhook run are passed, so a retry that
// grants nothing announces nothing (idempotent).
async function announceGift(
  gifterMatrixId: string | null,
  anonymous: boolean,
  giftKind: "direct" | "community",
  months: number,
  recipients: string[],
  amountCents: number,
  sessionId: string
): Promise<void> {
  if (recipients.length === 0) return;
  const ids = [...recipients, ...(gifterMatrixId ? [gifterMatrixId] : [])];
  const { rows } = await pool
    .query(`SELECT matrix_id, display_name, username_color, username_style FROM site.users WHERE matrix_id = ANY($1::text[])`, [ids])
    .catch(() => ({ rows: [] as { matrix_id: string; display_name: string | null; username_color: string | null; username_style: object | null }[] }));
  const nameOf = (mid: string) =>
    rows.find((r) => r.matrix_id === mid)?.display_name || fallbackName(mid);
  const colorOf = (mid: string) => rows.find((r) => r.matrix_id === mid)?.username_color ?? null;
  const styleOf = (mid: string) => rows.find((r) => r.matrix_id === mid)?.username_style ?? null;
  // `amount` (the full Stripe charge for this gift) lets stream-api credit the
  // support bar + support_events — gift subs are income. Fired once per gift
  // session (recordGift's remaining<=0 guard + grantGift ON CONFLICT make it
  // idempotent across webhook retries), so the full amount is not double-counted.
  await broadcastChatEvent({
    kind: "gift",
    // Session-derived idempotency key: /chat/event's outcome store dedups on
    // it, so even a double announce (a lock bypass, a future refactor) credits
    // the bar ONCE. One announce per session is this function's contract.
    spendId: `gift:${sessionId}`,
    gifter: anonymous || !gifterMatrixId ? "Anonymous" : nameOf(gifterMatrixId),
    gifterColor: anonymous || !gifterMatrixId ? null : colorOf(gifterMatrixId),
    gifterMatrixId: anonymous ? null : gifterMatrixId,
    usernameStyle: anonymous || !gifterMatrixId ? null : styleOf(gifterMatrixId),
    anonymous,
    giftKind,
    months,
    amount: amountCents,
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
async function selectCommunityRecipients(count: number, gifter: string | null): Promise<string[]> {
  const capped = Math.min(Math.max(Math.trunc(count), 0), MAX_COMMUNITY);
  if (capped === 0) return [];
  const { rows } = await pool
    .query(
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
    )
    .catch(() => ({ rows: [] as { matrix_id: string }[] }));
  return rows.map((r) => r.matrix_id);
}

// Park leftover community-gift slots for future sign-ups to claim (one per new
// account). Unclaimed slots expire in 90 days.
async function addPendingGifts(
  sessionId: string,
  gifter: string | null,
  months: number,
  n: number,
  anonymous: boolean
): Promise<void> {
  if (n <= 0) return;
  await pool.query(
    `INSERT INTO site.gift_pending (stripe_session_id, gifter_matrix_id, months, anonymous, claim_expires_at)
     SELECT $1, $2, $3, $5, now() + interval '90 days' FROM generate_series(1, $4)`,
    [sessionId, gifter, months, n, anonymous]
  );
}

// Claim the oldest unclaimed rollover slot for a brand-new account, if any. Grants
// the gifted sub + badge. Safe under concurrency (FOR UPDATE SKIP LOCKED).
export async function claimPendingGift(matrixId: string): Promise<void> {
  const { rows } = await pool
    .query(
      `WITH slot AS (
         SELECT id FROM site.gift_pending
         WHERE claimed_by IS NULL AND claim_expires_at > now()
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE site.gift_pending p
       SET claimed_by = $1, claimed_at = now()
       FROM slot WHERE p.id = slot.id
       RETURNING p.stripe_session_id, p.gifter_matrix_id, p.months, p.anonymous`,
      [matrixId]
    )
    .catch(() => ({ rows: [] as { stripe_session_id: string; gifter_matrix_id: string | null; months: number; anonymous: boolean }[] }));
  const slot = rows[0];
  if (!slot) return;
  const granted = await grantGift(slot.stripe_session_id, slot.gifter_matrix_id, matrixId, slot.months, "community", slot.anonymous);
  if (granted) {
    await grantSubscriberBadge(matrixId);
    invalidateTier(matrixId);
    void notifyBadgesChanged();
  }
}

// Insert one gift grant with additive (stacked) expiry. Returns true if a new row
// was written (false on idempotent webhook retry).
async function grantGift(
  sessionId: string,
  gifter: string | null,
  recipient: string,
  months: number,
  kind: "direct" | "community",
  anonymous: boolean
): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO site.gift_subscriptions
       (stripe_session_id, gifter_matrix_id, recipient_matrix_id, tier, months, kind, anonymous, expires_at)
     SELECT $1, $2, $3, 'supporter', $4, $5, $6,
       GREATEST(
         now(),
         COALESCE((SELECT MAX(expires_at) FROM site.gift_subscriptions WHERE recipient_matrix_id = $3), now()),
         -- A recipient on a PAID sub — through any service that counts — gets the
         -- gift AFTER their paid period, not concurrently with it (the gift was
         -- otherwise partly wasted). The records' one entitlement fragment decides.
         COALESCE(${paidThroughSql("$3", "$7")}, now())
       ) + make_interval(months => $4)
     ON CONFLICT (stripe_session_id, recipient_matrix_id) DO NOTHING
     RETURNING id`,
    [sessionId, gifter, recipient, months, kind, anonymous, subscriptionSources()]
  );
  return (res.rowCount ?? 0) > 0;
}

// Webhook entry point: record a completed gift payment. Direct gifts grant the
// named recipient; community gifts pick N random recipients now (fresh pool).
export async function recordGift(cs: Stripe.Checkout.Session): Promise<void> {
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

  if (giftType === "direct") {
    const recipient = meta.recipient_matrix_id;
    if (!recipient) {
      console.error("[gift] direct gift missing recipient for session", cs.id);
      return;
    }
    const granted = await grantGift(cs.id, gifter, recipient, months, "direct", anonymous);
    if (granted) {
      await grantSubscriberBadge(recipient);
      invalidateTier(recipient);
      await announceGift(gifter, anonymous, "direct", months, [recipient], cs.amount_total ?? 0, cs.id);
      void notifyBadgesChanged();
    }
    return;
  }

  // Community gift. Idempotent across webhook retries: only ever process the
  // unfilled remainder (already-granted rows + already-parked pending slots).
  const count = parseInt(meta.count ?? "", 10);
  if (!Number.isFinite(count) || count < 1) {
    console.error("[gift] community gift bad count", meta.count);
    return;
  }
  // Serialize deliveries of the SAME session. Stripe is at-least-once, and
  // tally-then-grant with a RANDOM recipient pick would let two concurrent
  // deliveries both read remaining=count, pick DIFFERENT recipients
  // (per-recipient ON CONFLICT can't dedup across sets) and both announce —
  // double grant, double bar credit, one payment. The advisory lock
  // (sticker-boost/route.ts's pattern) orders them; the second delivery's
  // tally then sees the first's rows and returns at remaining<=0.
  // The pool-based helpers below stay outside this client's transaction on
  // purpose — the LOCK is the guard, held until the COMMIT in finally.
  const lockClient = await pool.connect();
  try {
    await lockClient.query("BEGIN");
    await lockClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [cs.id]);
    // No catch: a `.catch(() => granted:0/pending:0)` would turn a DB blip
    // into "nothing processed yet" — an over-grant. A throw 500s the webhook
    // and Stripe redelivers later, which is the safe failure.
    const { rows: tally } = await lockClient.query(
      `SELECT
         (SELECT count(*) FROM site.gift_subscriptions WHERE stripe_session_id = $1) AS granted,
         (SELECT count(*) FROM site.gift_pending      WHERE stripe_session_id = $1) AS pending`,
      [cs.id]
    );
    const already = Number(tally[0]?.granted ?? 0) + Number(tally[0]?.pending ?? 0);
    const remaining = count - already;
    if (remaining <= 0) return; // fully processed already

    const recipients = await selectCommunityRecipients(remaining, gifter);
    const grantedNow: string[] = [];
    for (const recipient of recipients) {
      const granted = await grantGift(cs.id, gifter, recipient, months, "community", anonymous);
      if (granted) {
        await grantSubscriberBadge(recipient);
        invalidateTier(recipient);
        grantedNow.push(recipient);
      }
    }
    // Anything we couldn't hand out now rolls over to future sign-ups.
    await addPendingGifts(cs.id, gifter, months, remaining - recipients.length, anonymous);
    if (grantedNow.length) {
      await announceGift(gifter, anonymous, "community", months, grantedNow, cs.amount_total ?? 0, cs.id);
      void notifyBadgesChanged();
    }
  } finally {
    await lockClient.query("COMMIT").catch(() => {});
    lockClient.release();
  }
}

// ── Expiry sweep ─────────────────────────────────────────────────────────────
// The cosmetic Supporter badge no longer needs sweeping: badge SLOTS are derived
// live from entitlement (base_slots + a +1 for an active sub/gift, see badge_slots
// / api/badges), so when a gift lapses the +1 slot — and thus the equipped sub
// badge — simply stops rendering with no stored state to clean up. Kept as a no-op
// so startGiftExpirySweep()'s wiring is unchanged.
async function sweepExpiredGiftBadges(): Promise<number> {
  return 0;
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
    const badges = await sweepExpiredGiftBadges().catch(() => 0);
    if (badges > 0) console.log(`[gift] swept ${badges} expired Supporter badge(s)`);
    const pending = await sweepExpiredPendingGifts().catch(() => 0);
    if (pending > 0) console.log(`[gift] swept ${pending} expired pending slot(s)`);
  };
  void run();
  setInterval(() => void run(), 60 * 60 * 1000); // hourly
}
