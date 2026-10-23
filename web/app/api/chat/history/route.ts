import { auth } from "@/auth";
import { messageVisibleSql } from "@/app/lib/instanceSchema.generated.mjs";
import pool from "@/lib/db";
import { NextRequest } from "next/server";
import { canonicalFromMatrixSql } from "@/app/lib/canonicalFromMatrix";
import type { ChatMsg } from "@/app/lib/chatMsg";
import { NATIVE_PLATFORM, NATIVE_SQL, normalizePlatform } from "@/app/lib/nativePlatform";
import { ipKey } from "@/app/lib/rateLimit";
import { chatHistoryLimited } from "@/app/lib/chatHistoryLimit";
import { historyIds } from "@/app/lib/chatHistoryIds";
import { publicIdFor } from "@/app/lib/publicIdServer";
import { liveCardActor } from "@/app/lib/eventCardName";

// GET /api/chat/history?before=<epoch ms>&limit=<n>[&beforePlatform=<p>&beforeId=<id>]
// Combined-chat scroll-back: platform messages from stream.chat_log plus native
// messages from site.chat_messages (which carry reply context and color, and
// whose ids match the live WS broadcast ids — chat_log's native
// mirror rows do not, so they're excluded to avoid duplicates).
// Public read, same as the live WebSocket feed.
//
// Pagination is a KEYSET cursor on the tuple (created_at, platform, id): a strict
// total order across BOTH sources (platform disambiguates the two id sequences;
// id is unique within a platform). The client sends the oldest row it holds as
// (before, beforePlatform, beforeId); we return everything strictly older. This
// guarantees every page advances AND never skips rows that share a timestamp
// (a millisecond cursor alone could miss same-ms rows during a burst).
// The first page omits beforePlatform/beforeId → plain `created_at < before`.
//
// The query itself is `loadChatHistory` below, exported because the pages that
// mount a chat (/, /popout, /chat) read the newest page SERVER-SIDE and render
// the rows into the HTML, so the chat never opens empty. One query, two
// callers — the route is the HTTP shape of it, nothing more.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const before = Number(sp.get("before"));
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 50, 1), 100);
  if (!Number.isFinite(before) || before <= 0) {
    return new Response("Bad Request", { status: 400 });
  }
  // Full keyset cursor (subsequent pages); absent on the first page. `beforeTs`
  // is the oldest loaded row's created_at as full-precision text (microseconds) —
  // NOT the millisecond `before` — so the boundary comparison can't lose sub-ms
  // rows that node-postgres would truncate when it parses timestamptz to a Date.
  const beforeTs = sp.get("beforeTs");
  const beforePlatform = sp.get("beforePlatform");
  const beforeIdRaw = sp.get("beforeId");
  const hasCursor =
    beforeTs !== null && beforePlatform !== null && beforeIdRaw !== null && /^\d+$/.test(beforeIdRaw);
  const cursor = hasCursor ? { beforeTs: beforeTs!, beforePlatform: beforePlatform!, beforeId: beforeIdRaw! } : null;

  const viewer = await historyViewer();
  if (chatHistoryLimited(ipKey(req), viewer.me !== null)) {
    return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "10" } });
  }
  return Response.json(await loadChatHistory({ before, limit, cursor, viewer }));
}

/** Who is reading: their matrix id (for `myVote`) and whether they moderate. */
export type HistoryViewer = { me: string | null; isMod: boolean };

/** The signed-in viewer, resolved from the session — mods/admins see deleted
 *  messages struck out (moderation transparency); everyone else never receives
 *  the deleted content at all. */
export async function historyViewer(): Promise<HistoryViewer> {
  const session = await auth().catch(() => null);
  const me = session?.user?.id ?? null;
  let isMod = false;
  if (me) {
    const { rows: modRows } = await pool.query(
      `SELECT is_mod, is_admin FROM site.users WHERE matrix_id = $1`,
      [me]
    ).catch(() => ({ rows: [] as { is_mod: boolean; is_admin: boolean }[] }));
    isMod = !!(modRows[0]?.is_mod || modRows[0]?.is_admin);
  }
  return { me, isMod };
}

/** The newest page — what a chat shows when it opens. The pages that mount a
 *  chat call this (not loadChatHistory directly) so the clock read happens
 *  here, in a plain function, and not inside a server component's render. */
export async function latestChatHistory(viewer: HistoryViewer, limit: number): Promise<ChatMsg[]> {
  const { messages } = await loadChatHistory({ before: Date.now(), limit, viewer });
  return messages;
}

/** A page of combined history, oldest first, each row a ChatMsg plus its
 *  full-precision `cts` cursor. `cursor` null = the first page (bounded by the
 *  epoch-ms `before` alone). */
export async function loadChatHistory({ before, limit, cursor = null, viewer }: {
  before: number;
  limit: number;
  cursor?: { beforeTs: string; beforePlatform: string; beforeId: string } | null;
  viewer: HistoryViewer;
}): Promise<{ messages: (ChatMsg & { cts: string })[]; hasMore: boolean }> {
  const hasCursor = cursor !== null;
  const { me, isMod } = viewer;

  // Params are numbered so EVERY one is referenced in both modes (an unused $N
  // makes Postgres fail type inference): $1 limit, $2 isMod, then $3 is the time
  // bound — the epoch-ms `before` on the first page, or the full-precision cursor
  // timestamp on keyset pages (with $4 platform, $5 id). The keyset tuple
  // comparison is the exact inverse of the ORDER BY (created_at DESC, platform DESC,
  // id DESC), so "strictly older" == "sorts after the cursor" — no skipped rows,
  // guaranteed progress even through same-timestamp bursts.
  const platformBound = hasCursor
    ? `(cl.created_at, cl.platform, cl.id) < ($3::timestamptz, $4, $5::bigint)`
    : `cl.created_at < to_timestamp($3 / 1000.0)`;
  const nativeBound = hasCursor
    ? `(m.created_at, '${NATIVE_PLATFORM}', m.id) < ($3::timestamptz, $4, $5::bigint)`
    : `m.created_at < to_timestamp($3 / 1000.0)`;

  // `cts` = created_at as full-precision text — the cursor the client echoes back
  // on the next page (Date.getTime() in the client would truncate the microseconds).
  //
  // Native rows resolve canonical_id through the matrix→canonical hop (see
  // canonicalFromMatrix.ts) so a restored native message carries the same
  // public id a live WS frame does. The canonical itself never leaves this
  // route for a non-mod (historyIds, below): the rows are public.
  const platformSub =
    `(SELECT cl.id, cl.platform, cl.username, cl.message,
             cl.is_mod, cl.is_vip, cl.is_member, cl.is_bot,
             cl.user_id AS canonical_id,
             NULL AS matrix_id, cl.username_color, NULL::jsonb AS username_style, NULL AS dest_platform, NULL AS dest_platforms,
             cl.reply_to_id, cl.reply_to_username, cl.reply_to_text,
             NULL AS event_kind, NULL::jsonb AS event_json,
             FALSE AS encrypted,
             cl.emotes, cl.is_deleted, cl.created_at, cl.created_at::text AS cts
      FROM stream.chat_log cl
      WHERE ${platformBound} AND cl.platform NOT IN ${NATIVE_SQL}
        AND (${messageVisibleSql("cl")} OR $2)
      ORDER BY cl.created_at DESC, cl.platform DESC, cl.id DESC LIMIT $1)`;
  const nativeSub =
    `(SELECT m.id, '${NATIVE_PLATFORM}' AS platform,
             COALESCE(u.display_name, m.matrix_id) AS username, m.message,
             COALESCE(u.is_mod, FALSE) AS is_mod, FALSE AS is_vip, FALSE AS is_member,
             -- ⑤ Behavior "Hide bots": the account's own flag (site.users.is_bot, v100) —
             -- the web app names no bot.
             COALESCE(u.is_bot, FALSE) AS is_bot,
             ${canonicalFromMatrixSql("m.matrix_id")} AS canonical_id, m.matrix_id, u.username_color, u.username_style, m.dest_platform, m.dest_platforms,
             m.reply_to_id, m.reply_to_username, m.reply_to_text,
             m.event_kind, m.event_json,
             -- The FLAG ONLY (migrate-v86). The plaintext column itself must
             -- never appear in this SELECT: this response is public and
             -- unauthenticated for non-mod viewers. Derived from the payload so
             -- the two cannot drift. Enforced by encryptedExposure.test.ts.
             (m.encrypted_text IS NOT NULL) AS encrypted,
             -- Personal Twitch emotes (v114): native messages carry their own
             -- per-message map now, same shape as stream.chat_log.emotes — the
             -- row mapper below already passes it through as emotes.
             m.emotes, m.is_deleted, m.created_at, m.created_at::text AS cts
      FROM site.chat_messages m
      LEFT JOIN site.users u ON u.matrix_id = m.matrix_id
      WHERE ${nativeBound}
        AND (${messageVisibleSql("m")} OR $2)
      ORDER BY m.created_at DESC, m.id DESC LIMIT $1)`;

  const subqueries = `${platformSub} UNION ALL ${nativeSub}`;
  const params: unknown[] = cursor
    ? [limit, isMod, cursor.beforeTs, normalizePlatform(cursor.beforePlatform), cursor.beforeId]
    : [limit, isMod, before];
  const { rows } = await pool.query(
    // The sender's pronouns (♂ ♀ ⚲ in the row) come from their canonical; the
    // ORDER BY is qualified because stream.users has its own id / created_at.
    // A platform line's avatar is the one stream-api keeps on the canonical
    // (stream.users.avatar_url, written from the live frames) — without it a
    // restored Twitch / YouTube / Kick line would draw a letter where the live
    // frame drew the picture. A native line has none here: its picture is the
    // Matrix avatar route, which ChatMessage derives from matrixId.
    // That avatar is the LAST one any of the person's platforms showed, so it
    // is used only when the person has no other platform: a Twitch line drawn
    // with the person's YouTube picture would publish the link between them.
    `SELECT combined.*, pu.pronouns,
            CASE WHEN combined.matrix_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM stream.links ol
                                   WHERE ol.canonical = combined.canonical_id
                                     AND ol.platform NOT IN ${NATIVE_SQL} AND ol.platform <> combined.platform)
                 THEN pu.avatar_url END AS avatar_url
       FROM (${subqueries}) combined
     LEFT JOIN stream.users pu ON pu.id = combined.canonical_id
     ORDER BY combined.created_at DESC, combined.platform DESC, combined.id DESC
     LIMIT $1`,
    params
  );

  // Oldest-first for direct prepending; BIGSERIAL ids arrive as strings
  const messages = rows.reverse().map((r) => {
    // Full-precision keyset cursor for this row (echoed back as beforeTs). Not
    // rendered — paired with (platform, id) it uniquely orders the merged feed.
    const cts = r.cts as string;
    // A persisted monetization card (migrate-v61): re-render it AS a card by
    // restoring the full payload from event_json, but with the DB-authoritative
    // id/platform/reply/vote fields (so vote totals attach and threading works).
    if (r.event_kind) {
      const card = typeof r.event_json === "string" ? JSON.parse(r.event_json) : (r.event_json ?? {});
      // Matrix-linked events (gift/sub/donation/cheer/sticker/tts/sound/bot)
      // show LIVE identity — current color/username style and badges, same as
      // any other message — not a snapshot frozen at event time. The name is
      // live too, except a tip's: a tip keeps the name it was given, typed or
      // not (lib/eventCardName.ts). External alerts (no matrix_id) keep
      // whatever event_json carried.
      const liveActor = liveCardActor(r.event_kind, card, r);
      // A card's stored payload is shown as written, minus any canonical id a
      // producer put in it — the row is public (historyIds).
      const { canonicalId: storedCanonical, ...shown } = card as Record<string, unknown>;
      return {
        ...shown,
        ...(isMod && typeof storedCanonical === "string" ? { canonicalId: storedCanonical } : {}),
        ...liveActor,
        id: Number(r.id),
        platform: NATIVE_PLATFORM,
        system: r.event_kind,
        reply_to_id: r.reply_to_id != null ? Number(r.reply_to_id) : null,
        reply_to_username: r.reply_to_username ?? null,
        reply_to_text: r.reply_to_text ?? null,
        deleted: r.is_deleted ?? false,
        ts: new Date(r.created_at).getTime(),
        cts,
        score: 0,
        myVote: null as number | null,
      };
    }
    return {
      id: Number(r.id),
      platform: r.platform,
      username: r.username,
      message: r.message,
      isMod: r.is_mod,
      isVip: r.is_vip,
      isMember: r.is_member,
      // ⑤ Behavior "Hide bots" — the same flag the live frame carries.
      isBot: r.is_bot === true,
      ...historyIds(r, isMod, publicIdFor),
      usernameColor: r.username_color ?? null,
      usernameStyle: r.username_style ?? null,
      pronouns: r.pronouns ?? null,
      avatarUrl: r.avatar_url ?? null,
      destPlatform: r.dest_platform ?? null,
      destPlatforms: r.dest_platforms ? String(r.dest_platforms).split(",") : null,
      reply_to_id: r.reply_to_id != null ? Number(r.reply_to_id) : null,
      reply_to_username: r.reply_to_username ?? null,
      reply_to_text: r.reply_to_text ?? null,
      emotes: r.emotes ?? null,
      encrypted: r.encrypted === true,
      deleted: r.is_deleted ?? false,
      ts: new Date(r.created_at).getTime(),
      cts,
      score: 0,
      myVote: null as number | null,
    };
  });

  // Attach vote totals (and the viewer's own vote, when signed in)
  if (messages.length > 0) {
    const { rows: votes } = await pool.query(
      `SELECT v.platform, v.message_id, SUM(v.vote)::int AS score,
              MAX(CASE WHEN v.voter_matrix_id = $3 THEN v.vote END)::int AS my_vote
       FROM site.message_votes v
       JOIN unnest($1::text[], $2::bigint[]) AS k(platform, message_id)
         ON v.platform = k.platform AND v.message_id = k.message_id
       GROUP BY v.platform, v.message_id`,
      [messages.map((m) => m.platform), messages.map((m) => m.id), me]
    );
    const byKey = new Map(votes.map((v) => [`${v.platform}:${v.message_id}`, v]));
    for (const m of messages) {
      const v = byKey.get(`${m.platform}:${m.id}`);
      if (v) {
        m.score = v.score;
        m.myVote = v.my_vote ?? null;
      }
    }
  }

  return { messages: messages as (ChatMsg & { cts: string })[], hasMore: rows.length >= limit };
}
