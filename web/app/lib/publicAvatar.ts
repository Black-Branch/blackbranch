// Server-side avatar cache for the handful of accounts whose face must render
// for EVERYONE — including signed-out visitors and viewers who never linked
// Matrix.
//
// WHY THIS EXISTS. /api/avatar/user/[id] fetches media with the VIEWER's own
// Matrix token, so a viewer without a session gets the deterministic letter
// circle for every user — the help desk's button and the broadcaster's pfp
// included. That is fine for people (you get initials until you sign in) and
// wrong for the two accounts that ARE the site's furniture.
//
// THERE IS NO TOKEN-FREE PATH, measured against a Synapse homeserver:
//   /_matrix/client/v3/profile/<id>/avatar_url   200  (the mxc IS public)
//   /_matrix/media/v3/thumbnail/...              404  (Matrix 1.11 media freeze)
//   /_matrix/media/v3/download/...               404
//   /_matrix/client/v1/media/thumbnail/...       401
// So a cache cannot fill itself without a credential. STREAMER_MEDIA_TOKEN is a
// long-lived MAS compatibility token for a service account (issued with
// `mas-cli manage issue-compatibility-token`), NOT a user session — borrowing a
// user session as a service credential expires silently and dies on a logout.
//
// ALLOWLIST ONLY. Serving arbitrary ids from here would turn avatars into a
// public enumeration endpoint — anyone could confirm whether a matrix_id exists
// and pull its picture without an account. The two entries below are accounts
// that are already publicly visible on every page.
//
// Fails to null, never throws and never caches a failure. The caller 404s and
// the UI keeps the letter/initials fallback, so a missing or expired token
// degrades to that instead of a broken image.

// Relative, with the `.ts` extension (allowImportingTsExtensions): `node --test`
// cannot resolve the `@/` alias, so an aliased import here makes this module —
// and every test of it — unloadable. Same reason coins.ts imports this way.
import { imageContentType } from "./mediaHeaders.ts";
import { instanceString } from "./instanceConfigServer.ts";
import { matrixBaseUrl } from "./matrixConfig.ts";
import { readBytesCapped, readJsonCapped, MATRIX_JSON_MAX_BYTES } from "./boundedBody.ts";
import { AVATAR_MAX_BYTES } from "./avatarThumb.ts";

// Plain `fetch`, NOT homeserverFetch, and that is a deliberate difference from
// /api/avatar/user/[id]. That route fetches the VIEWER's own homeserver — an
// arbitrary, attacker-influenced host — so it needs the SSRF guard. Here the host
// is this install's configured homeserver (matrix.baseUrl, install tier — never
// user-influenced): the `server` component of the mxc is only ever
// interpolated into the PATH, never the origin, and it is shape-checked before it
// gets there. There is no host to inject, so the guard would buy nothing, and its
// aliased import chain makes this module unloadable under `node --test`.
const UPSTREAM_TIMEOUT_MS = 8000;
const TTL_MS = 60 * 60 * 1000;

/** The only ids this module will ever fetch: the streamer's and the bot's (instance keys
 *  streamer.matrixId — env STREAMER_MATRIX_ID / BROADCASTER_MATRIX_ID — and bot.matrixId),
 *  lower-cased for comparison. Read per call so a stored value applies without a restart; an
 *  unset key simply allows nothing.
 *  @test-only exported so the allowlist's size is pinned (it answers to the public). */
export function publicAvatarIds(): string[] {
  return [instanceString("streamer.matrixId"), instanceString("bot.matrixId")]
    .filter((s): s is string => !!s)
    .map((s) => s.trim().toLowerCase());
}

export function isPublicAvatarId(matrixId: string): boolean {
  return publicAvatarIds().includes(matrixId.trim().toLowerCase());
}

/** Role words the public avatar route also accepts, so a client never needs an account id
 *  (`/api/avatar/public/bot`): the same two allowlisted accounts, named by role. */
export function publicAvatarIdForRole(role: string): string | null {
  if (role === "bot") return instanceString("bot.matrixId");
  if (role === "streamer") return instanceString("streamer.matrixId");
  return null;
}

export type CachedAvatar = { body: ArrayBuffer; type: string };
type Entry = CachedAvatar & { until: number };

const cache = new Map<string, Entry>();
// One in-flight fetch per id. Without this, a cold cache plus a burst of first
// paints fans out one upstream request per viewer.
const inflight = new Map<string, Promise<CachedAvatar | null>>();

/** @test-only reset between cases — the module-level cache would otherwise leak
 *  state across tests and make the second assertion depend on the first. */
export function __resetPublicAvatarCache(): void {
  cache.clear();
  inflight.clear();
}

async function fetchAvatar(matrixId: string): Promise<CachedAvatar | null> {
  const token = process.env.STREAMER_MEDIA_TOKEN ?? "";
  if (!token) return null;

  // The profile lookup is genuinely public; only the media needs the token.
  const prof = await fetch(
    `${matrixBaseUrl()}/_matrix/client/v3/profile/${encodeURIComponent(matrixId)}/avatar_url`,
    { cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }
  ).catch(() => null);
  if (!prof?.ok) return null;

  const { avatar_url: mxc } = ((await readJsonCapped(prof, MATRIX_JSON_MAX_BYTES)) ?? {}) as { avatar_url?: string };
  if (!mxc || !String(mxc).startsWith("mxc://")) return null;

  const [, , server, mediaId] = String(mxc).split("/");
  // Same shape guard the other media routes use: these land in a URL path, so a
  // stray slash or dot-dot must never get there.
  if (!server || !mediaId || !/^[A-Za-z0-9.\-]+$/.test(server) || !/^[A-Za-z0-9_\-]+$/.test(mediaId)) {
    return null;
  }

  const media = await fetch(
    `${matrixBaseUrl()}/_matrix/client/v1/media/thumbnail/${server}/${mediaId}?width=96&height=96&method=crop`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "image/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }
  ).catch(() => null);
  if (!media?.ok) return null;
  const bytes = await readBytesCapped(media, AVATAR_MAX_BYTES);
  if (!bytes) return null;

  return {
    body: bytes.buffer,
    type: imageContentType(media.headers.get("content-type")),
  };
}

/**
 * The avatar bytes for one allowlisted account, or null.
 *
 * Cached for an hour. A miss is not cached: an expired token or a homeserver
 * blip must not pin the letter fallback in place for the next hour.
 */
export async function publicAvatar(matrixId: string): Promise<CachedAvatar | null> {
  if (!isPublicAvatarId(matrixId)) return null;
  const key = matrixId.trim().toLowerCase();

  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return { body: hit.body, type: hit.type };

  const pending = inflight.get(key);
  if (pending) return pending;

  const run = fetchAvatar(matrixId)
    .then((res) => {
      if (res) cache.set(key, { ...res, until: Date.now() + TTL_MS });
      return res;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));

  inflight.set(key, run);
  return run;
}
