import pool from "@/lib/db";
import { messageVisibleSql } from "@/app/lib/instanceSchema.generated.mjs";
import { requireUser } from "@/app/lib/authGuard";
import { streamApiFetch } from "@/app/lib/streamApi";
import { resolveIdentities } from "@/lib/socialCredit";
import { AUTO_PIN_TTL_MS, expireAutoPinIfDue, withAuthor } from "@/app/api/chat/pin/route";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { earn } from "@/app/lib/coinsServer";
import {
  VOTE_TARGET_WINDOW_MS, VOTE_TARGET_MAX,
  VOTE_GLOBAL_WINDOW_MS, VOTE_GLOBAL_MAX,
  AUTO_PIN_BASE, autoPinScore,
} from "@/app/lib/votePolicy";
import { activeChatters } from "@/app/lib/activeChatters";
import { matrixIdForCanonical } from "@/app/lib/canonicalIdentity";
import { NextRequest } from "next/server";
import { isNativePlatform, normalizePlatform } from "@/app/lib/nativePlatform";

// POST /api/chat/vote — up/downvote a live-chat message.
// Body: { platform, messageId, vote: 1 | -1 | 0 } (0 clears the vote).
// Votes land in site.message_votes; the new total is fanned out to all
// connected clients via stream-api's WS broadcast ({ type: "vote" }).

const VALID_PLATFORMS = new Set([
  "twitch", "youtube", "tiktok", "kick", "discord", "streamplace",
]);

// 40 votes per 60 seconds per user — prevents score farming while allowing
// normal use during active stream sessions. (Was 10/60s, which an engaged viewer
// up/down-voting during a lively stream — or anyone toggling a vote a few times —
// hit easily; the client silently reverts on 429, so it read as "voting broke.")
const isVoteRateLimited = createSlidingWindowLimiter(VOTE_GLOBAL_WINDOW_MS, VOTE_GLOBAL_MAX);

// PER-TARGET CLAMP — 2 votes per 30s against the SAME author, against an
// automated up/downvoter.
//
// The global limiter above counts a voter's votes across ALL messages, so it
// never sees brigading: 40/min spent entirely on one person looks identical to
// 40/min spread across a lively chat, and one account could bury one person
// unnoticed. Social credit is SUM(vote) recomputed on every read and rendered
// PUBLICLY on every UserCard, so that shows up directly as a standing score —
// and it is the same currency the encrypted-message gate spends against.
//
// Keyed voter→AUTHOR, not voter→message. Per-message would be trivially
// sidestepped by walking down someone's backlog one message at a time, which is
// exactly what a bot does and a human does not.
//
// Deliberately NOT a lower global 40/min. An engaged viewer voting across a
// fast chat needs that headroom (a tighter limit reads as "voting broke"); the
// attack is concentration, so clamp concentration.
// The numbers live in votePolicy — they are user-facing copy too (the
// refusal tooltip derives its sentence from them), so they must not be retyped.
const isTargetVoteLimited = createSlidingWindowLimiter(VOTE_TARGET_WINDOW_MS, VOTE_TARGET_MAX);

export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  if (isVoteRateLimited(matrixId)) {
    return new Response("Too Many Requests", { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const { vote } = body;
  // A page opened before the platform-key rename may still send the site's old id (nativePlatform.ts).
  const platform = normalizePlatform(body.platform);
  const id = Number(body.messageId);
  if (!(isNativePlatform(platform) || VALID_PLATFORMS.has(platform)) || !Number.isInteger(id) || id <= 0 || ![-1, 0, 1].includes(vote)) {
    return new Response("Bad Request", { status: 400 });
  }

  // The message must exist — native and platform messages live in different tables
  const exists = isNativePlatform(platform)
    ? await pool.query(`SELECT matrix_id AS author FROM site.chat_messages WHERE id = $1 AND NOT is_deleted`, [id])
    // `AND NOT is_deleted` mirrors the native branch above. Without it a message a
    // mod had already deleted stayed votable, and since upvotes drive the crowd
    // auto-pin, a deleted message could be voted straight back into the PUBLIC
    // pinned banner — undoing the moderation in the most visible place possible.
    : await pool.query(
        `SELECT user_id AS author FROM stream.chat_log WHERE id = $1 AND platform = $2 AND NOT is_deleted`,
        [id, platform]
      );
  if (exists.rows.length === 0) {
    return new Response("Not Found", { status: 404 });
  }

  // No voting on your own messages — including ones you sent from a linked
  // platform account (social credit must not be self-mintable)
  const author: string = exists.rows[0].author;
  if (isNativePlatform(platform)) {
    if (author === matrixId) {
      return Response.json({ error: "self_vote" }, { status: 403 });
    }
  } else if (author) {
    const me = await resolveIdentities({ matrixId: matrixId });
    if (me.canonicalIds.includes(author)) {
      return Response.json({ error: "self_vote" }, { status: 403 });
    }
  }

  // AFTER the self-vote check and BEFORE any write. After, so a self-vote
  // attempt (already refused) cannot burn the voter's own allowance against
  // themselves. Before the write, because a limiter that runs afterwards has
  // already let the vote land.
  //
  // `vote === 0` is EXEMPT — clearing a vote is the undo, and rate-limiting
  // undo strands someone on a mis-tap they can see but cannot take back. It also
  // cannot brigade: it only ever moves a score back toward zero.
  //
  // CHANGING AN EXISTING VOTE IS ALSO EXEMPT, and this is the important one.
  // `site.message_votes` is keyed (platform, message_id, voter) and upserts, so
  // a voter contributes AT MOST ±1 to any one message no matter how many times
  // they click. Re-voting the same message therefore cannot brigade — only
  // reaching NEW messages by the same author accumulates.
  //
  // Without this, ordinary indecision trips the clamp: up, then down, then up
  // again on a single message is three calls in seconds, and the client reverts
  // silently on 429 — which reads as "voting broke". Costs one lookup on the
  // primary key.
  if (vote !== 0 && author) {
    const already = await pool.query(
      `SELECT 1 FROM site.message_votes
        WHERE platform = $1 AND message_id = $2 AND voter_matrix_id = $3`,
      [platform, id, matrixId]
    );
    if (already.rows.length === 0 && isTargetVoteLimited(`${matrixId}->${author}`)) {
      return Response.json({ error: "vote_too_fast" }, { status: 429 });
    }
  }

  // Whether this call created a NEW vote row, as opposed to changing one.
  let votedFresh = false;
  if (vote === 0) {
    await pool.query(
      `DELETE FROM site.message_votes WHERE platform = $1 AND message_id = $2 AND voter_matrix_id = $3`,
      [platform, id, matrixId]
    );
  } else {
    // `xmax = 0` is true only when this upsert INSERTED. That single flag is
    // what makes earning here safe: see the award block below.
    const up = await pool.query<{ inserted: boolean }>(
      `INSERT INTO site.message_votes (platform, message_id, voter_matrix_id, vote)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (platform, message_id, voter_matrix_id)
       DO UPDATE SET vote = EXCLUDED.vote, created_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [platform, id, matrixId, vote]
    );
    votedFresh = up.rows[0]?.inserted === true;
  }

  // EARNING, AND WHY IT IS NOT A QORM PRINTER.
  //
  // This flag alone would NOT be enough. Clearing a vote deletes the row, so
  // the next vote on the same message is a genuinely fresh INSERT and this
  // flag is true again — vote → un-vote → vote would pay twice, and a viewer
  // could reach the whole 25-vote cap by toggling one message.
  //
  // What actually stops it is one layer down: coinsServer keys the ledger ref
  // to (voter, stream, platform, message), so the second award for the same
  // message collides and replays, paying nothing and leaving the counters
  // alone. The caps then bound DISTINCT messages, which is the thing worth
  // rewarding. See earnVoteCast.
  //
  // This flag is still worth having: it keeps ordinary vote-changing
  // (up → down → up) from even attempting an award, so the common case costs
  // no transaction at all.
  //
  // Fire-and-forget, like the chat-send earn: an award must never block or
  // fail the vote it rewards.
  // Loud, not swallowed: a bare catch would make an earning outage
  // indistinguishable from a quiet stream.
  if (votedFresh) {
    void earn.earnVoteCast(matrixId, platform, id)
      .catch((e) => console.error("[points-earn] vote-cast earn failed:", e));
    // `author` is a MATRIX id for a native message and a CANONICAL id for a
    // platform one (stream.chat_log.user_id). The ledger is keyed on matrix_id,
    // so a platform author must be resolved through site.platform_links first
    // — an unlinked chatter has no wallet and is owed nothing. Passing the
    // canonical straight through violates the ledger's foreign key.
    if (vote > 0 && author) {
      void matrixIdForCanonical(author, (sql, params) => pool.query<{ matrix_id: string }>(sql, params))
        .then((recipient) => recipient && recipient !== matrixId
          ? earn.earnUpvoteReceived(recipient, matrixId, platform, id)
          : undefined)
        .catch((e) => console.error("[points-earn] upvote-received earn failed:", e));
    }
  }

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(vote), 0)::int AS score
     FROM site.message_votes WHERE platform = $1 AND message_id = $2`,
    [platform, id]
  );
  const score: number = rows[0].score;

  // Best-effort broadcast — the vote is already recorded either way
  try {
    await streamApiFetch("/chat/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, messageId: id, score }),
    });
  } catch (e) {
    console.error("[chat/vote] score broadcast failed:", (e as Error).message);
  }

  // Crowd auto-pin: a message reaching the threshold pins itself, but never over
  // an existing pin, and never re-pins after being unpinned — the pin-history
  // check covers both.
  //
  // The threshold scales with how many people are actually chatting. Read
  // only when the score could possibly clear the LOWEST it can be: on a quiet
  // stream almost every vote would otherwise pay for a COUNT(DISTINCT) that
  // cannot change the outcome. The count itself is cached for a minute.
  if (vote > 0 && score >= AUTO_PIN_BASE) {
    const threshold = autoPinScore(await activeChatters());
    if (score >= threshold) await tryAutoPin(platform, id).catch(() => {});
  }

  return Response.json({ score, myVote: vote === 0 ? null : vote });
}

async function tryAutoPin(platform: string, id: number) {
  const { rows: prior } = await pool.query<{ auto: boolean; is_self: boolean }>(
    `SELECT auto, (platform = $1 AND message_id = $2) AS is_self
     FROM site.pinned_messages
     WHERE active OR (platform = $1 AND message_id = $2)`,
    [platform, id]
  );
  // Never re-pin a message with any pin history (active or not) — matches
  // the mod-pin behavior of not re-pinning something already unpinned.
  if (prior.some((r) => r.is_self)) return;
  // A mod's manual pin is never silently bumped by crowd votes; an existing
  // AUTO pin, on the other hand, is fair game to replace with a fresher one.
  if (prior.some((r) => !r.auto)) return;

  const src = isNativePlatform(platform)
    ? await pool.query(
        `SELECT COALESCE(u.display_name, m.matrix_id) AS username, m.message,
                NULL::jsonb AS emotes
         FROM site.chat_messages m
         LEFT JOIN site.users u ON u.matrix_id = m.matrix_id
         WHERE m.id = $1 AND ${messageVisibleSql("m")}`,
        [id]
      )
    : await pool.query(
        `SELECT cl.username, cl.message, cl.emotes FROM stream.chat_log cl
         WHERE cl.id = $1 AND cl.platform = $2 AND ${messageVisibleSql("cl")}`,
        [id, platform]
      );
  if (src.rows.length === 0) return;

  // Deactivate any current (auto-only, per the guard above) pin and insert
  // the new one in one transaction — same pattern as the mod POST in
  // /api/chat/pin. The partial unique index (one active pin) makes a
  // concurrent pin attempt race-safe: it simply throws here and this auto-pin
  // is dropped (caught by the caller).
  const client = await pool.connect();
  let r;
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE site.pinned_messages SET active = FALSE, unpinned_at = now() WHERE active`
    );
    const { rows } = await client.query(
      `INSERT INTO site.pinned_messages
         (platform, message_id, username, message, emotes, auto, pinned_by)
       VALUES ($1, $2, $3, $4, $5, TRUE, NULL)
       RETURNING *`,
      [platform, id, src.rows[0].username, src.rows[0].message, src.rows[0].emotes]
    );
    await client.query("COMMIT");
    r = rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const createdAtMs = new Date(r.created_at).getTime();
  setTimeout(() => {
    expireAutoPinIfDue(Number(r.id), createdAtMs)
      .catch((e) => console.error("[chat/vote] auto-pin expiry failed:", (e as Error).message));
  }, AUTO_PIN_TTL_MS);

  try {
    await streamApiFetch("/chat/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Through withAuthor like a mod pin: the banner wears the author's
        // style and badges from the first frame, not only after a reload.
        pin: await withAuthor({
          id: Number(r.id),
          platform: r.platform,
          messageId: Number(r.message_id),
          username: r.username,
          message: r.message,
          emotes: r.emotes ?? null,
          auto: r.auto,
          pinnedBy: r.pinned_by,
          ts: createdAtMs,
        }),
      }),
    });
  } catch (e) {
    console.error("[chat/vote] auto-pin broadcast failed:", (e as Error).message);
  }
}
