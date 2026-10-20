import pool from "@/lib/db";
import { safeFetch } from "@/app/lib/ssrf";
import { readBodyCapped } from "@/app/lib/boundedBody";
import { requireMod } from "@/app/lib/admin";
import { reorderByPriority } from "@/app/lib/reorderPriority";
import { NextRequest } from "next/server";

// Community embed rotation management (mod only; the /embed chat command and
// the CommunityEmbedManager dialog both land here).
//   GET    — list the rotation, priority order
//   POST   — add/merge: { youtube?, twitch? } (legacy { channel } = youtube),
//            the YouTube handle/URL/UC… id resolved by scraping the channel page
//   DELETE — remove: { id } (the dialog — a row id, stable across reorders) or
//            { target } — a UC… id or a (case-insensitive) channel/display name.
//            No positional form: `priority` is rewritten by every reorder, so
//            a number a mod read a moment ago names a different row now.
//   PATCH  — reorder or toggle flags (see below)

const UC_RE = /^UC[A-Za-z0-9_-]{22}$/;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Deadline on the channel-page scrape, matching the OG route's. Without it a
// stalling page would pin the mod's request and the manager's `busy` state
// indefinitely.
const RESOLVE_TIMEOUT_MS = 6_000;

// One row shape for GET and the reorder PATCH, so the dialog can replace its
// list with what the server returns.
const ROW_COLUMNS = `id, priority, display_name, channel_name, youtube_channel_id,
                     twitch_login, ingest_enabled, ingest_twitch, ingest_youtube`;

function channelUrl(input: string): string | null {
  const s = input.trim();
  if (UC_RE.test(s)) return `https://www.youtube.com/channel/${s}`;
  if (s.startsWith("@")) return `https://www.youtube.com/${s}`;
  if (/^(https?:\/\/)?(www\.)?youtube\.com\//.test(s)) {
    return s.startsWith("http") ? s : `https://${s}`;
  }
  // Bare handle without the @
  if (/^[A-Za-z0-9_.-]{3,30}$/.test(s)) return `https://www.youtube.com/@${s}`;
  return null;
}

async function resolveChannel(
  input: string
): Promise<{ channelId: string; name: string; handle: string | null } | null> {
  const url = channelUrl(input);
  if (!url) return null;
  try {
    // channelUrl pins the host to youtube.com, but every other outbound fetch
    // of a user-influenced URL goes through the SSRF guard — match it.
    const res = await safeFetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    // A channel page runs ~1 MB of HTML with its inline JSON; the ids sit in the first part.
    const html = await readBodyCapped(res, 4 * 1024 * 1024);
    if (html === null) return null;
    // externalId / itemprop identifier are the page's OWN channel — the loose
    // channel/UC… pattern would match featured-channel links too
    const channelId =
      /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1] ??
      /itemprop="identifier" content="(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1] ??
      /"channelId":"(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1] ??
      null;
    if (!channelId) return null;
    const name =
      /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ??
      /<title>([^<]*)<\/title>/.exec(html)?.[1]?.replace(/ - YouTube$/, "") ??
      channelId;
    const handle = /"canonicalBaseUrl":"\/(@[^"]+)"/.exec(html)?.[1] ?? null;
    return { channelId, name, handle };
  } catch {
    return null;
  }
}

export async function GET() {
  const me = await requireMod();
  if (me instanceof Response) return me;
  const { rows } = await pool.query(
    `SELECT ${ROW_COLUMNS} FROM site.community_embeds ORDER BY priority ASC`
  );
  return Response.json({ embeds: rows });
}

export async function DELETE(req: NextRequest) {
  const me = await requireMod();
  if (me instanceof Response) return me;

  const body = await req.json().catch(() => ({}));

  // Precise removal by row id (used by the manage UI — stable across reorders).
  if (Number.isInteger(Number(body.id))) {
    const { rows } = await pool.query(
      `DELETE FROM site.community_embeds WHERE id = $1 RETURNING display_name`,
      [Number(body.id)]
    );
    if (rows.length === 0) return Response.json({ error: `No embed with id ${body.id}` }, { status: 404 });
    return Response.json({ removed: rows[0].display_name });
  }

  const target = String(body.target ?? "").trim();
  if (!target) {
    return Response.json({ error: "Usage: /embed remove <name | UC…>" }, { status: 400 });
  }

  let rows;
  if (UC_RE.test(target)) {
    ({ rows } = await pool.query(
      `DELETE FROM site.community_embeds WHERE youtube_channel_id = $1
       RETURNING display_name`, [target]
    ));
  } else {
    const { rows: matches } = await pool.query(
      `SELECT id, display_name FROM site.community_embeds
       WHERE LOWER(display_name) = LOWER($1) OR LOWER(channel_name) = LOWER($1)
          OR LOWER(channel_name) = LOWER($2)`,
      [target, target.replace(/^@/, "")]
    );
    if (matches.length > 1) {
      return Response.json(
        { error: `"${target}" matches ${matches.length} channels — use the UC… id` },
        { status: 409 }
      );
    }
    ({ rows } = await pool.query(
      `DELETE FROM site.community_embeds WHERE id = $1 RETURNING display_name`,
      [matches[0]?.id ?? -1]
    ));
  }

  if (rows.length === 0) {
    return Response.json(
      { error: `No embed matching "${target}" — use the channel name or its UC… id` },
      { status: 404 }
    );
  }
  return Response.json({ removed: rows[0].display_name });
}

export async function POST(req: NextRequest) {
  const me = await requireMod();
  if (me instanceof Response) return me;

  const body = await req.json().catch(() => ({}));
  // New multi-platform shape: { youtube?, twitch? } (any subset).
  // Legacy back-compat: { channel } is treated as a YouTube handle/URL/UC… id.
  const ytInput = String(body.youtube ?? body.channel ?? "").trim();
  const twitchLogin = String(body.twitch ?? "").trim().toLowerCase().replace(/^@/, "") || null;

  if (!ytInput && !twitchLogin) {
    return Response.json(
      { error: "Usage: /embed y <youtube> t <twitch> (any subset)" },
      { status: 400 }
    );
  }

  // YouTube is the only platform we resolve to a canonical id (zero-quota page
  // scrape); the Twitch handle is stored as given.
  let resolved: { channelId: string; name: string; handle: string | null } | null = null;
  if (ytInput) {
    resolved = await resolveChannel(ytInput);
    if (!resolved) {
      return Response.json(
        { error: `Couldn't resolve "${ytInput}" to a YouTube channel` },
        { status: 404 }
      );
    }
  }

  // Find any existing row matching one of the supplied identities, so repeat
  // /embed calls merge platforms onto the same streamer instead of duplicating.
  const { rows: matches } = await pool.query<{
    id: number;
    display_name: string;
  }>(
    `SELECT id, display_name FROM site.community_embeds
     WHERE ($1::text IS NOT NULL AND youtube_channel_id = $1)
        OR ($2::text IS NOT NULL AND LOWER(twitch_login) = $2)`,
    [resolved?.channelId ?? null, twitchLogin]
  );
  if (matches.length > 1) {
    return Response.json(
      { error: `Those handles match ${matches.length} different rotation entries — remove one first` },
      { status: 409 }
    );
  }

  const existing = matches[0];
  if (existing) {
    // Merge: only overwrite the platforms supplied this call (COALESCE keeps the rest).
    const { rows } = await pool.query(
      `UPDATE site.community_embeds SET
         youtube_channel_id = COALESCE($2, youtube_channel_id),
         twitch_login       = COALESCE($3, twitch_login),
         display_name       = COALESCE($4, display_name),
         channel_url        = COALESCE($5, channel_url)
       WHERE id = $1
       RETURNING display_name, youtube_channel_id, twitch_login, priority`,
      [
        existing.id,
        resolved?.channelId ?? null,
        twitchLogin,
        resolved?.name ?? null,
        resolved ? `https://www.youtube.com/${resolved.handle ?? `channel/${resolved.channelId}`}` : null,
      ]
    );
    return Response.json({ ...rows[0], updated: true });
  }

  // New entry. channel_name/display_name/channel_url derive from whatever
  // platform we have, preferring YouTube.
  const displayName = resolved?.name ?? twitchLogin;
  const channelName = resolved?.handle ?? resolved?.name ?? twitchLogin;
  const platform = resolved ? "youtube" : "twitch";
  const channelUrl = resolved
    ? `https://www.youtube.com/${resolved.handle ?? `channel/${resolved.channelId}`}`
    : `https://twitch.tv/${twitchLogin}`;

  const { rows } = await pool.query(
    `INSERT INTO site.community_embeds
       (channel_name, platform, channel_url, display_name, youtube_channel_id,
        twitch_login, priority, added_by)
     VALUES ($1, $2, $3, $4, $5, $6,
             COALESCE((SELECT MAX(priority) FROM site.community_embeds), 0) + 1, $7)
     RETURNING display_name, youtube_channel_id, twitch_login, priority`,
    [channelName, platform, channelUrl, displayName, resolved?.channelId ?? null,
     twitchLogin, me]
  );

  return Response.json({ ...rows[0], updated: false });
}

// PATCH — two shapes:
//   { order: number[] }  → reorder: set priority = position+1 for each id, in order
//   { id, ingest_enabled?, ingest_twitch?, ingest_youtube? }
//                        → toggle the video-source flags for one embed
//   (`ingest_kick` is not accepted — there is no Kick player.)
export async function PATCH(req: NextRequest) {
  const me = await requireMod();
  if (me instanceof Response) return me;

  const body = await req.json().catch(() => ({}));

  // Reorder
  if (Array.isArray(body.order)) {
    const ids = (body.order as unknown[]).map(Number).filter(Number.isInteger);
    if (ids.length === 0) {
      return Response.json({ error: "order must be a non-empty array of embed ids" }, { status: 400 });
    }
    await reorderByPriority(pool, "site.community_embeds", ids);
    const { rows } = await pool.query(
      `SELECT ${ROW_COLUMNS} FROM site.community_embeds ORDER BY priority ASC`
    );
    return Response.json({ reordered: rows });
  }

  // Flag toggle
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return Response.json({ error: "id (integer) required" }, { status: 400 });
  }
  const FLAGS = ["ingest_enabled", "ingest_twitch", "ingest_youtube"] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of FLAGS) {
    if (typeof body[f] === "boolean") {
      sets.push(`${f} = $${sets.length + 1}`);
      vals.push(body[f]);
    }
  }
  if (sets.length === 0) {
    return Response.json({ error: "no flag fields to update" }, { status: 400 });
  }
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE site.community_embeds SET ${sets.join(", ")} WHERE id = $${vals.length}
     RETURNING id, ingest_enabled, ingest_twitch, ingest_youtube`,
    vals
  );
  if (rows.length === 0) {
    return Response.json({ error: `No embed with id ${id}` }, { status: 404 });
  }
  return Response.json(rows[0]);
}
