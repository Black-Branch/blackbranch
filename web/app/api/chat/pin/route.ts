import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { streamApiFetch } from "@/app/lib/streamApi";
import { pinAuthor, type PinAuthorQuery } from "@/app/lib/pinAuthor";
import type { PinnedMessage } from "@/app/lib/pinnedMessage";
import { NextRequest } from "next/server";
import { messageVisibleSql } from "@/app/lib/instanceSchema.generated.mjs";
import { sourceVisible } from "@/app/lib/messageVisibility";
import { isNativePlatform, normalizePlatform } from "@/app/lib/nativePlatform";

// Pinned chat message (one active at a time — Twitch-style banner).
//   GET    — current active pin (public; clients fetch on load, WS keeps live)
//   POST   — mod pin: { platform, messageId } (snapshot resolved server-side)
//   DELETE — mod unpin
// Auto-pinning at +5 lives in /api/chat/vote.

type PinRow = {
  id: string;
  platform: string;
  message_id: string;
  username: string;
  message: string;
  emotes: Record<string, string> | null;
  auto: boolean;
  pinned_by: string | null;
  created_at: string;
};

const authorQuery: PinAuthorQuery = (sql, params) => pool.query(sql, params);

/** The pin frame every reader gets: the stored snapshot plus its author,
 *  resolved live (lib/pinAuthor.ts) so the banner wears the author's current
 *  style and badges. Exported for /api/chat/vote's auto-pin broadcast. */
export async function withAuthor(pin: PinnedMessage): Promise<PinnedMessage> {
  return { ...pin, ...(await pinAuthor(pin.platform, pin.messageId, authorQuery)) };
}

function toClient(r: PinRow): PinnedMessage {
  return {
    id: Number(r.id),
    platform: r.platform,
    messageId: Number(r.message_id),
    username: r.username,
    message: r.message,
    emotes: r.emotes ?? null,
    auto: r.auto,
    pinnedBy: r.pinned_by,
    ts: new Date(r.created_at).getTime(),
  };
}

async function broadcastPin(pin: ReturnType<typeof toClient> | null) {
  // Best-effort — the DB row is authoritative either way
  try {
    await streamApiFetch("/chat/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
  } catch (e) {
    console.error("[chat/pin] broadcast failed:", (e as Error).message);
  }
}

// Auto-pins (crowd upvote threshold) self-clear after 10 minutes — a mod pin
// never does. Exported so /api/chat/vote can arm an in-process timer right
// after creating an auto-pin (the common path — the banner disappears live
// for anyone already looking); GET below double-checks lazily in case a
// server restart dropped that timer. The `auto` guard in the UPDATE means
// this can never touch a mod pin even if called with a stale/wrong id.
export const AUTO_PIN_TTL_MS = 10 * 60 * 1000;

export async function expireAutoPinIfDue(id: number, createdAtMs: number): Promise<boolean> {
  if (Date.now() - createdAtMs < AUTO_PIN_TTL_MS) return false;
  const { rows } = await pool.query(
    `UPDATE site.pinned_messages SET active = FALSE, unpinned_at = now()
     WHERE id = $1 AND active AND auto RETURNING id`,
    [id]
  );
  const expired = rows.length > 0;
  if (expired) await broadcastPin(null);
  return expired;
}

export async function GET() {
  const { rows } = await pool.query(
    `SELECT * FROM site.pinned_messages WHERE active LIMIT 1`
  );
  const row = rows[0] as PinRow | undefined;
  if (row?.auto && await expireAutoPinIfDue(Number(row.id), new Date(row.created_at).getTime())) {
    return Response.json({ pin: null });
  }
  // A pin is a snapshot: a message deleted since (by a mod, or with its account) is unpinned here
  // and never served again.
  if (row && !(await sourceVisible(row.platform, Number(row.message_id), authorQuery))) {
    await pool.query(`UPDATE site.pinned_messages SET active = FALSE, unpinned_at = now() WHERE id = $1 AND active`, [row.id]);
    await broadcastPin(null);
    return Response.json({ pin: null });
  }
  return Response.json({ pin: row ? await withAuthor(toClient(row)) : null });
}

export async function POST(req: NextRequest) {
  const me = await requireMod();
  if (me instanceof Response) return me;

  const body = await req.json().catch(() => ({}));
  const platform = String(normalizePlatform(String(body.platform ?? "")));
  const id = Number(body.messageId);
  if (!platform || !Number.isInteger(id) || id <= 0) {
    return new Response("Bad Request", { status: 400 });
  }

  // Snapshot the message from whichever table owns it
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
  if (src.rows.length === 0) return new Response("Not Found", { status: 404 });

  const client = await pool.connect();
  let row: PinRow;
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE site.pinned_messages SET active = FALSE, unpinned_at = now() WHERE active`
    );
    const { rows } = await client.query(
      `INSERT INTO site.pinned_messages
         (platform, message_id, username, message, emotes, auto, pinned_by)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6)
       RETURNING *`,
      [platform, id, src.rows[0].username, src.rows[0].message,
       src.rows[0].emotes, me]
    );
    await client.query("COMMIT");
    row = rows[0] as PinRow;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // After the release, never inside the transaction: withAuthor runs its own
  // pool.query, and doing that while this handler still held a client is a
  // deadlock at pool exhaustion — and placed after COMMIT inside the try it
  // would put a committed pin under a ROLLBACK-and-rethrow path. The vote
  // route's auto-pin has the same shape.
  const pin = await withAuthor(toClient(row));

  await broadcastPin(pin);
  return Response.json({ pin });
}

export async function DELETE() {
  const me = await requireMod();
  if (me instanceof Response) return me;

  await pool.query(
    `UPDATE site.pinned_messages SET active = FALSE, unpinned_at = now() WHERE active`
  );
  await broadcastPin(null);
  return Response.json({ pin: null });
}
