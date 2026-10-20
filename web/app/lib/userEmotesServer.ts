// Server-side personal Twitch emote sets: Helix fetch with the USER's token,
// site.user_emotes cache (24h TTL) + a 60s in-process cache so the chat/send
// hot path costs at most one SELECT per sender per minute. Collision policy
// (site catalog wins) is NOT here — it lives where the per-message map is
// built (chat/send), by resolving only words absent from the manifest.

import pool from "@/lib/db";
import { getAccessToken } from "@/app/lib/platformTokens";
import { twitchClientId } from "@/app/lib/twitch";
import type { EmoteMap } from "@/app/lib/emoteMap";
import { buildPersonalMap, hasEmoteScope, isPersonalCacheStale, type HelixUserEmote } from "@/app/lib/userEmotesCore";

// Not exported: no second file references it yet (route.ts only destructures
// getPersonalEmotes' return value). Re-export it if/when a real consumer needs
// the named type — don't pre-export against the orphan gate.
type PersonalEmotes = { emotes: EmoteMap; needsRelink: boolean };

const DB_TTL_MS = 24 * 60 * 60 * 1000;
const PROC_TTL_MS = 60_000;
const MAX_PAGES = 100;
const MAX_EMOTES = 5_000;
const NONE: PersonalEmotes = { emotes: {}, needsRelink: false };

const procCache = new Map<string, { data: PersonalEmotes; ts: number }>();

type AcctRow = { provider_account_id: string | null; scope: string | null };

async function twitchAccount(matrixId: string): Promise<AcctRow | null> {
  const { rows } = await pool.query<AcctRow>(
    `SELECT provider_account_id, scope FROM site.accounts
     WHERE matrix_id = $1 AND provider = 'twitch' AND type = 'oauth' LIMIT 1`,
    [matrixId]
  );
  return rows[0] ?? null;
}

async function fetchAllUserEmotes(token: string, userId: string): Promise<HelixUserEmote[] | null> {
  const acc: HelixUserEmote[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://api.twitch.tv/helix/chat/emotes/user");
    url.searchParams.set("user_id", userId);
    if (cursor) url.searchParams.set("after", cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": twitchClientId() },
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: 0 },
    });
    if (!res.ok) return null; // caller keeps stale cache
    const data = (await res.json()) as { data?: HelixUserEmote[]; pagination?: { cursor?: string } };
    acc.push(...(data.data ?? []));
    cursor = data.pagination?.cursor ?? null;
    if (!cursor || acc.length >= MAX_EMOTES) break;
  }
  return acc.slice(0, MAX_EMOTES);
}

// Helix Get Users, batched (the API caps at 100 ids per request). Returns
// whatever resolved; missing ids simply stay unnamed. Failures degrade to {}
// — never throw (same reasoning as the fetch guard below).
async function resolveOwnerNames(token: string, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length && i < 1000; i += 100) {
    const url = new URL("https://api.twitch.tv/helix/users");
    for (const id of ids.slice(i, i + 100)) url.searchParams.append("id", id);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, "Client-Id": twitchClientId() },
        signal: AbortSignal.timeout(10_000),
        next: { revalidate: 0 },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { data?: Array<{ id: string; login?: string }> };
      for (const u of data.data ?? []) if (u.id && u.login) out[u.id] = u.login;
    } catch (e) {
      console.warn("[userEmotes] owner lookup failed:", e);
    }
  }
  return out;
}

async function refreshFromHelix(matrixId: string, userId: string): Promise<EmoteMap | null> {
  const token = await getAccessToken(matrixId, "twitch");
  if (!token) return null;
  let list: HelixUserEmote[] | null;
  try {
    list = await fetchAllUserEmotes(token, userId);
  } catch (e) {
    // A REJECTION (network down, the AbortSignal.timeout(10_000) above)
    // must take the same route as an HTTP failure (fetchAllUserEmotes's
    // `!res.ok` -> null): otherwise this throws UNCAUGHT through load() ->
    // getPersonalEmotes(), which never reaches its procCache.set — every
    // subsequent send for this user re-stalls for the whole outage, and
    // /api/emotes/mine 500s instead of returning its designed shape.
    console.warn("[userEmotes] helix fetch failed:", e);
    return null;
  }
  if (!list) return null;
  // Channel attribution: resolve distinct owner ids to their logins so the
  // picker can group per channel. Best-effort — a failed lookup leaves those
  // emotes as ch:"" ("Other channels") for one TTL cycle rather than failing
  // the whole refresh.
  const ownerIds = [...new Set(list.map((e) => e.owner_id).filter((id): id is string => !!id && id !== "0"))];
  const ownerNames = await resolveOwnerNames(token, ownerIds);
  const map = buildPersonalMap(list, ownerNames);
  await pool
    .query(
      `INSERT INTO site.user_emotes (matrix_id, emotes, fetched_at) VALUES ($1, $2, now())
       ON CONFLICT (matrix_id) DO UPDATE SET emotes = EXCLUDED.emotes, fetched_at = now()`,
      [matrixId, map]
    )
    .catch((e) => console.warn("[userEmotes] cache write failed:", e));
  return map;
}

async function load(matrixId: string): Promise<PersonalEmotes> {
  const acct = await twitchAccount(matrixId);
  if (!acct?.provider_account_id) return NONE;
  if (!hasEmoteScope(acct.scope)) return { emotes: {}, needsRelink: true };

  const { rows } = await pool.query<{ emotes: EmoteMap | null; fetched_at: string }>(
    `SELECT emotes, fetched_at FROM site.user_emotes WHERE matrix_id = $1`,
    [matrixId]
  );
  const cached = rows[0];
  // isPersonalCacheStale: a v1-format row (entries without `ch` — written
  // before channel attribution) is treated as expired so the picker gets
  // groupable data on the next read instead of in 24h.
  const fresh =
    cached &&
    Date.now() - new Date(cached.fetched_at).getTime() < DB_TTL_MS &&
    !isPersonalCacheStale(cached.emotes ?? {});
  if (fresh) {
    return { emotes: cached.emotes ?? {}, needsRelink: false };
  }
  const refreshed = await refreshFromHelix(matrixId, acct.provider_account_id);
  if (refreshed) return { emotes: refreshed, needsRelink: false };
  // Helix/token failure: a day-stale set beats an empty one; don't clobber it.
  return { emotes: cached?.emotes ?? {}, needsRelink: false };
}

export async function getPersonalEmotes(matrixId: string): Promise<PersonalEmotes> {
  const hit = procCache.get(matrixId);
  if (hit && Date.now() - hit.ts < PROC_TTL_MS) return hit.data;
  const data = await load(matrixId);
  procCache.set(matrixId, { data, ts: Date.now() });
  if (procCache.size > 2000) {
    for (const [k, v] of procCache) if (Date.now() - v.ts >= PROC_TTL_MS) procCache.delete(k);
  }
  return data;
}

/** Force-refresh (link/re-link): bypasses both caches; best-effort. */
export async function refreshPersonalEmotes(matrixId: string): Promise<void> {
  procCache.delete(matrixId);
  const acct = await twitchAccount(matrixId);
  if (!acct?.provider_account_id || !hasEmoteScope(acct.scope)) return;
  await refreshFromHelix(matrixId, acct.provider_account_id);
}
