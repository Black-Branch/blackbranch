import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { NextRequest } from "next/server";
import { canonicalFromMatrixSql } from "@/app/lib/canonicalFromMatrix";
import { NATIVE_PLATFORM, NATIVE_SQL, isNativePlatform, normalizePlatform } from "@/app/lib/nativePlatform";

// GET /api/mod/chat-history — mod-gated searchable chat history across BOTH
// sources (stream.chat_log platform rows + site.chat_messages native rows),
// modeled on the public /api/chat/history keyset merge but filterable:
//   q=<text>          message substring (ILIKE, accelerated by trigram indexes)
//   user=<name|id>    username substring, or an exact matrix/canonical id
//   platform=<p>      one platform only ("native" = native side only)
//   deleted=1         only rows already flagged deleted (reviewing moderation)
//   id=<n>            exactly one message (with platform=) — the user card's message details
//   beforeTs/beforePlatform/beforeId — keyset cursor, older page (same triple as chat/history)
//   afterTs/afterPlatform/afterId    — keyset cursor, NEWER page (Show in context)
//   limit ≤ 100 (default 50)
// Each row carries its platform emotes (name → image) so the panel renders it as live chat does.
// Mods always receive deleted rows (flagged, struck out client-side) — this is
// the moderation-transparency view, not the public feed.
//
// Every row is fully inspectable: where it was sent (a site message's
// cross-post destinations), what it replied to, and the per-message scores stored in the product's
// own stream.chat_log columns — a site message reads them from its chat_log mirror row (platform
// native, platform_msg_id = its id; idx_chat_log_platform_msg). Which scores the panel SHOWS is the
// install plugin's to declare; this route returns the columns either way.
export async function GET(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  const user = (sp.get("user") ?? "").trim();
  const platform = String(normalizePlatform((sp.get("platform") ?? "").trim().toLowerCase()));
  const deletedOnly = sp.get("deleted") === "1";
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 50, 1), 100);
  const idRaw = sp.get("id");
  const oneId = idRaw !== null && /^\d+$/.test(idRaw) ? idRaw : null;

  const cursor = (p: "before" | "after") => {
    const ts = sp.get(`${p}Ts`), plat = sp.get(`${p}Platform`), id = sp.get(`${p}Id`);
    return ts !== null && plat !== null && id !== null && /^\d+$/.test(id) ? { ts, plat: String(normalizePlatform(plat)), id } : null;
  };
  const before = cursor("before");
  const after = before ? null : cursor("after");

  // Conditions are built per side with shared, explicitly-cast params (every $N
  // is referenced, so Postgres type inference never sees an unused param).
  const params: unknown[] = [limit];
  const platCond: string[] = [];
  const natCond: string[] = [];

  const keyset = before ?? after;
  if (keyset) {
    params.push(keyset.ts, keyset.plat, keyset.id);
    const [t, p, i] = [params.length - 2, params.length - 1, params.length];
    const op = before ? "<" : ">";
    platCond.push(`(cl.created_at, cl.platform, cl.id) ${op} ($${t}::timestamptz, $${p}::text, $${i}::bigint)`);
    natCond.push(`(m.created_at, '${NATIVE_PLATFORM}', m.id) ${op} ($${t}::timestamptz, $${p}::text, $${i}::bigint)`);
  }
  if (oneId) {
    params.push(oneId);
    platCond.push(`cl.id = $${params.length}::bigint`);
    natCond.push(`m.id = $${params.length}::bigint`);
  }
  if (q) {
    params.push(q);
    const n = params.length;
    platCond.push(`cl.message ILIKE '%' || $${n}::text || '%'`);
    natCond.push(`m.message ILIKE '%' || $${n}::text || '%'`);
  }
  if (user) {
    params.push(user);
    const n = params.length;
    platCond.push(`(cl.username ILIKE '%' || $${n}::text || '%' OR cl.user_id = $${n}::text)`);
    natCond.push(`(COALESCE(u.display_name, '') ILIKE '%' || $${n}::text || '%' OR m.matrix_id = $${n}::text)`);
  }
  if (deletedOnly) {
    platCond.push(`cl.is_deleted`);
    natCond.push(`m.is_deleted`);
  }
  let includePlatform = true;
  let includeNative = true;
  if (platform) {
    if (isNativePlatform(platform)) {
      includePlatform = false;
    } else {
      includeNative = false;
      params.push(platform);
      platCond.push(`cl.platform = $${params.length}::text`);
    }
  }
  // An exact id names one side: without a platform it is ambiguous, so refuse rather than guess.
  if (oneId && !platform) return Response.json({ error: "id needs platform" }, { status: 400 });

  // Newest-first for an older page (and the first page); oldest-first for a newer page, so the
  // LIMIT keeps the rows nearest the cursor — reversed below into one order for the client.
  const dir = after ? "ASC" : "DESC";

  const platformSub =
    `(SELECT cl.id, cl.platform, cl.username, cl.message,
             cl.user_id AS canonical_id, NULL AS matrix_id,
             cl.is_deleted, cl.created_at, cl.created_at::text AS cts,
             NULL::text AS dest_platforms, cl.reply_to_username, cl.reply_to_text,
             cl.karma, cl.intelligence, cl.emotes
      FROM stream.chat_log cl
      WHERE cl.platform NOT IN ${NATIVE_SQL}
        ${platCond.map((c) => `AND ${c}`).join("\n        ")}
      ORDER BY cl.created_at ${dir}, cl.platform ${dir}, cl.id ${dir} LIMIT $1)`;
  // Native rows resolve canonical_id through the matrix→canonical hop (see
  // canonicalFromMatrix.ts) — a NULL here left every native history row's
  // UserCard without a profile lookup key (no banner/stats/bot read).
  const nativeSub =
    `(SELECT m.id, '${NATIVE_PLATFORM}' AS platform,
             COALESCE(u.display_name, m.matrix_id) AS username, m.message,
             ${canonicalFromMatrixSql("m.matrix_id")} AS canonical_id, m.matrix_id,
             m.is_deleted, m.created_at, m.created_at::text AS cts,
             COALESCE(NULLIF(m.dest_platforms, ''), m.dest_platform) AS dest_platforms,
             m.reply_to_username, m.reply_to_text,
             s.karma, s.intelligence, m.emotes
      FROM site.chat_messages m
      LEFT JOIN site.users u ON u.matrix_id = m.matrix_id
      LEFT JOIN LATERAL (
        SELECT c.karma, c.intelligence FROM stream.chat_log c
         WHERE c.platform IN ${NATIVE_SQL} AND c.platform_msg_id = m.id::text
         LIMIT 1
      ) s ON TRUE
      WHERE TRUE
        ${natCond.map((c) => `AND ${c}`).join("\n        ")}
      ORDER BY m.created_at ${dir}, m.id ${dir} LIMIT $1)`;

  const subqueries = [includePlatform ? platformSub : null, includeNative ? nativeSub : null]
    .filter(Boolean)
    .join(" UNION ALL ");

  const { rows } = await pool.query(
    `SELECT * FROM (${subqueries}) combined
     ORDER BY created_at ${dir}, platform ${dir}, id ${dir}
     LIMIT $1`,
    params
  );
  if (after) rows.reverse();

  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  // Newest-first always (the panel renders top-down). BIGSERIAL ids arrive as strings.
  const messages = rows.map((r) => ({
    id: Number(r.id),
    platform: r.platform as string,
    username: r.username as string,
    message: r.message as string,
    canonicalId: (r.canonical_id ?? null) as string | null,
    matrixId: (r.matrix_id ?? null) as string | null,
    deleted: !!r.is_deleted,
    ts: new Date(r.created_at).getTime(),
    cts: r.cts as string,
    // A site message: the platforms it was also posted to. A platform message: its own.
    destPlatforms: isNativePlatform(r.platform)
      ? String(r.dest_platforms ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      : [r.platform as string],
    replyTo: r.reply_to_username ? { username: r.reply_to_username as string, text: (r.reply_to_text ?? "") as string } : null,
    scores: { karma: num(r.karma), intelligence: num(r.intelligence) },
    // The platform's own emotes in this message (name → image), as live chat renders them.
    emotes: r.emotes && typeof r.emotes === "object" ? (r.emotes as Record<string, string>) : null,
  }));

  // The older-page cursor is the LAST row (oldest); a newer page's cursor is its FIRST row.
  const last = messages[messages.length - 1];
  const first = messages[0];
  const nextCursor = !after && rows.length >= limit && last
    ? { beforeTs: last.cts, beforePlatform: last.platform, beforeId: String(last.id) }
    : null;
  const newerCursor = after && rows.length >= limit && first
    ? { afterTs: first.cts, afterPlatform: first.platform, afterId: String(first.id) }
    : null;

  return Response.json({ messages, nextCursor, newerCursor });
}
