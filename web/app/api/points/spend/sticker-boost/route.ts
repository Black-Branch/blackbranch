import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { debitCoins, refundCoins } from "@/app/lib/coinsServer";
import { STICKER_BASE_COINS } from "@/app/lib/coins";
import { storePricing } from "@/app/lib/storePricingServer";
import { deliverChatEvent } from "@/app/lib/chatEventDelivery";
import { createCooldown } from "@/app/lib/rateLimit";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Per-user cooldown, mirroring the sibling /spend/sticker route. A boost re-pops
// the OBS overlay, so without this a single viewer could re-trigger the on-stream
// sticker as fast as they can issue requests. Slightly looser than the 7s send
// cooldown — boosting an existing sticker is a smaller interruption than a new one.
const userCooldown = createCooldown(5_000);

// A boost must cost at least the advertised price. `requested` was previously
// accepted on `> 0` alone, so a 1-Qorm request bought a full overlay pop —
// on-stream griefing for a hundredth of the intended price. The ceiling is a
// sanity bound on a single call (boosting past the SIZE cap is legal and still
// spends, it just stops growing the sticker), not a policy limit.
// A ceiling on ONE call, not on the cumulative total. Expressed against the
// old 10-Qorm floor's intent (1,000 Qorm) rather than a multiple of the live
// floor, so raising the floor between streams cannot quietly raise the most a
// single tap can spend.
const BOOST_MAX_PER_CALL = 1_000;

type StickerCard = {
  emoteName?: string;
  emoteUrl?: string;
  username?: string;
  senderMatrixId?: string | null;
  usernameColor?: string | null;
  usernameStyle?: object | null;
};

// POST /api/points/spend/sticker-boost { originalMessageId, amount?, spendId }
// → { ok, balance, charged, cumulative }
//
// Escalates an EXISTING sticker send — bigger, moved to the bottom of the feed
// — for an extra Qorm spend (migrate-v70). One row for the sticker's whole
// life: stream-api updates it in place and broadcasts a `stickerMove` (never
// a second row — no duplicate). STICKER_BOOST_CAP is a SIZE cap only
// (stickerBoostScale saturates once cumulative reaches it) — boosting past it
// still spends real Qorm and is never rejected, it just stops growing the
// sticker any further.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null) as
    { originalMessageId?: unknown; amount?: unknown; spendId?: unknown } | null;
  const messageId = Number(body?.originalMessageId);
  const spendId = typeof body?.spendId === "string" ? body.spendId.slice(0, 64) : "";
  // The boost floor is a FLOOR ON A VARIABLE AMOUNT, not a price: the viewer
  // picks what to spend and is charged exactly that, so there is no
  // expectedPrice guard here — there is no price to disagree about. What the
  // table supplies is the minimum (and the popover's step).
  const floor = await storePricing.getPrice("sticker_boost");
  if (floor === null) {
    return Response.json({ error: "price_unavailable", price: null }, { status: 503 });
  }
  const requested = Number.isFinite(Number(body?.amount)) ? Math.round(Number(body?.amount)) : floor;
  if (!Number.isInteger(messageId) || messageId <= 0 || spendId.length < 8 || requested <= 0) {
    return new Response("Bad Request", { status: 400 });
  }
  // Clamp into [price, max] rather than trusting the client's amount. Reject a
  // request below the advertised price instead of silently charging more than
  // was asked for — a surprise overcharge is worse than a refusal.
  if (requested < floor || requested > BOOST_MAX_PER_CALL) {
    return Response.json(
      { error: "bad_amount", min: floor, max: BOOST_MAX_PER_CALL },
      { status: 400 }
    );
  }

  const cooldownMs = userCooldown.remainingMs(matrixId);
  if (cooldownMs > 0) {
    return Response.json(
      { error: "throttled", retryAfterSeconds: Math.ceil(cooldownMs / 1000) },
      { status: 429 }
    );
  }

  const { rows } = await pool.query<{ event_kind: string | null; event_json: StickerCard | null }>(
    `SELECT event_kind, event_json FROM site.chat_messages WHERE id = $1`,
    [messageId]
  );
  const card = rows[0]?.event_json;
  if (rows[0]?.event_kind !== "sticker" || !card?.emoteUrl) {
    return Response.json({ error: "not_a_sticker" }, { status: 404 });
  }

  const charge = requested;

  const debit = await debitCoins({
    matrixId, amount: charge, sink: "sticker_boost", ref: spendId, meta: { originalMessageId: messageId },
  });
  if (!debit.ok) return Response.json({ error: "insufficient_coins" }, { status: 402 });
  if (debit.replay) return Response.json({ ok: true, balance: debit.balance });
  // Arm only on a real (non-replay) debit, so a retried spendId is not punished.
  userCooldown.arm(matrixId);

  // Reserve the boost and compute the running total ATOMICALLY.
  //
  // Summing the existing boosts and inserting later would let two concurrent
  // boosts on the same sticker both read the same stale total and both
  // broadcast it, so the on-stream sticker would render SMALLER than the Qorm
  // actually spent — the viewer paying for growth they never saw.
  //
  // pg_advisory_xact_lock serializes boosts per-sticker (and only per-sticker),
  // so the read and the insert cannot interleave. The row is written here rather
  // than after the effect so the total is authoritative at broadcast time; if the
  // effect then fails we delete it below, preserving the "never persist a no-op"
  // shape every other coin sink uses.
  //
  // The original send counts as the starting balance toward the size cap — a
  // never-boosted sticker is already "10 of 250".
  let newCumulative: number;
  let boostRowId: number;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [messageId]);
    const { rows: sumRows } = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(coins), 0) AS total FROM site.sticker_boosts WHERE original_message_id = $1`,
      [messageId]
    );
    newCumulative = STICKER_BASE_COINS + Number(sumRows[0]?.total ?? 0) + charge;
    const ins = await client.query<{ id: number }>(
      `INSERT INTO site.sticker_boosts (original_message_id, booster_matrix_id, coins)
       VALUES ($1, $2, $3) RETURNING id`,
      [messageId, matrixId, charge]
    );
    boostRowId = ins.rows[0]!.id;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[spend/sticker-boost] reserve failed:", e);
    await refundCoins({ matrixId, amount: charge, ref: spendId, meta: { reason: "reserve failed" } })
      .catch((err) => console.error("[spend/sticker-boost] refund failed:", err));
    return Response.json({ error: "boost_failed" }, { status: 500 });
  } finally {
    client.release();
  }
  const delivery = await deliverChatEvent({
    kind: "sticker_boost",
    originalMessageId: messageId,
    username: card.username,
    senderMatrixId: card.senderMatrixId,
    usernameColor: card.usernameColor,
    usernameStyle: card.usernameStyle,
    emoteName: card.emoteName,
    emoteUrl: card.emoteUrl,
    coins: charge,
    boostCoins: newCumulative,
    spendId,
  });
  if (delivery.outcome === "unconfirmed") {
    // NO refund and the reservation row STAYS — the boost may have credited
    // the bar and broadcast the move already; releasing the reservation would
    // understate every future boost's cumulative for a boost that DID appear
    // (see chatEventDelivery.ts).
    console.error("[spend/sticker-boost] unconfirmed delivery — coins kept, spendId:", spendId);
    return Response.json({ error: "boost_unconfirmed" }, { status: 502 });
  }
  if (delivery.outcome !== "delivered") {
    // The reservation above already persisted the boost row so the broadcast total
    // would be authoritative. The effect provably failed, so drop it — otherwise it
    // would inflate every future boost's cumulative for a boost that never appeared.
    await pool
      .query(`DELETE FROM site.sticker_boosts WHERE id = $1`, [boostRowId])
      .catch((e) => console.error("[spend/sticker-boost] failed to release reservation:", boostRowId, e));
    await refundCoins({ matrixId, amount: charge, ref: spendId,
      meta: { reason: delivery.outcome === "refused" ? `refused_${delivery.status}` : "stream-api unreachable" } })
      .catch((e) => console.error("[spend/sticker-boost] refund failed:", e));
    return Response.json({ error: "boost_failed" }, { status: 502 });
  }

  return Response.json({ ok: true, balance: debit.balance, charged: charge, cumulative: newCumulative });
}
