import { randomUUID } from "node:crypto";
import pool from "@/lib/db";
import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { streamApiFetch } from "@/app/lib/streamApi";
import { fanOutPurge } from "@/app/lib/platformMod";
import { copiesForMessages } from "@/app/lib/platformCopies";
import { NextRequest } from "next/server";
import { NATIVE_PLATFORM, NATIVE_SQL } from "@/app/lib/nativePlatform";
import { parsePurgeRequest, windowLabel } from "@/app/lib/modRequests";

// Bounded purge: flag a user's recent messages deleted everywhere at once.
// Native rows are flagged here (site.chat_messages is ours to write); the
// stream.chat_log flags + the single {type:'purge'} broadcast happen in
// stream-api via POST /chat/purge; platform-side removal fans out best-effort
// (Twitch 1s timeout, Kick/YouTube per-message deletes).
//
// Caps: window ≤ 24h (in minutes — `/purge x 10m` reaches back ten minutes), ≤250 native + ≤250 platform rows per purge — one WS frame,
// one pass, no unbounded sweep. A prolific spammer may need a second purge.
const MAX_ROWS_PER_SIDE = 250;

export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  // Target is a matrix id, OR a canonical stream id (12-hex) for a platform-only
  // chatter. Both flow through the same queries: the canon CTE below resolves either
  // shape, and the native-side UPDATE matches nothing for a canonical with no site account.
  // The body's shape is shared with every client (modRequests.ts).
  const body = await req.json().catch(() => null);
  const parsed = parsePurgeRequest(body);
  if (!parsed) return new Response("Bad Request", { status: 400 });
  const { targetId, windowMinutes } = parsed;

  // Privilege ceiling: a non-admin mod may not purge the owner's messages,
  // whether named by matrix id or by the owner's linked platform canonical.
  const denied = await assertCanModerate(mod, targetId);
  if (denied) return denied;

  const batchId = randomUUID();

  // Native messages — flag directly (bounded via subquery so RETURNING is the
  // exact set that goes in the broadcast frame).
  const native = await pool.query<{ id: string }>(
    `UPDATE site.chat_messages SET is_deleted = true
     WHERE id IN (
       SELECT id FROM site.chat_messages
       WHERE matrix_id = $1 AND NOT is_deleted
         AND created_at > now() - make_interval(mins => $2::int)
       ORDER BY created_at DESC LIMIT $3
     )
     RETURNING id`,
    [targetId, windowMinutes, MAX_ROWS_PER_SIDE]
  );

  // Platform messages — every canonical identity linked to this user, then
  // their recent chat_log rows. Read-only here; stream-api does the flagging.
  const platform = await pool.query<{ id: string; platform: string; platform_msg_id: string | null }>(
    `WITH canon AS (
       SELECT canonical_id AS c FROM site.platform_links WHERE matrix_id = $1
       UNION
       SELECT canonical AS c FROM stream.links
         WHERE platform IN ${NATIVE_SQL} AND platform_id = $1
       UNION
       SELECT id AS c FROM stream.users WHERE id = $1
     )
     SELECT l.id, l.platform, l.platform_msg_id
     FROM stream.chat_log l JOIN canon ON l.user_id = canon.c
     WHERE l.platform NOT IN ${NATIVE_SQL} AND NOT l.is_deleted
       AND l.created_at > now() - make_interval(mins => $2::int)
     ORDER BY l.created_at DESC LIMIT $3`,
    [targetId, windowMinutes, MAX_ROWS_PER_SIDE]
  );

  // One frame's worth of (platform, id) pairs — the same keys clients render by.
  const items = [
    ...native.rows.map((r) => ({ platform: NATIVE_PLATFORM, id: Number(r.id) })),
    ...platform.rows.map((r) => ({ platform: r.platform.toLowerCase(), id: Number(r.id) })),
  ];

  if (items.length > 0) {
    await streamApiFetch(`/chat/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, batchId }),
    }).catch(() => {});
  }

  await appendModLog({
    action: "purge", target: targetId, by: mod, batchId,
    reason: `${items.length} messages / last ${windowLabel(windowMinutes)}`,
  });

  // Platform-side removal (best-effort, after the site purge is done). Kick and
  // YouTube need the platform-native message ids; their per-purge caps are
  // applied inside the fan-out. The purged NATIVE messages' cross-posted copies
  // (site.chat_message_platform_copies) are merged in too — their Twitch copies
  // need no ids (the 1s-timeout clear covers the user's own account there).
  const copyMap = await copiesForMessages(native.rows.map((r) => Number(r.id)));
  const msgIdsFor = (p: string) => [
    ...platform.rows.filter((r) => r.platform.toLowerCase() === p && r.platform_msg_id)
      .map((r) => r.platform_msg_id as string),
    ...(copyMap.get(p) ?? []),
  ];
  fanOutPurge(mod, targetId, msgIdsFor("kick"), msgIdsFor("youtube"), batchId);

  return Response.json({ ok: true, batchId, purged: items.length });
}
