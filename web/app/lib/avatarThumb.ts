// The fetch behind /api/avatar/user/[id]: resolve a user's avatar on our own
// homeserver, then pull its 96 px thumbnail through the VIEWER's homeserver (a
// federated viewer's token is only valid on theirs). Dependency-injected so the
// trust and memory rules below are tested without Synapse.
//
// Two rules hold it together:
//  - Only bytes that came from OUR homeserver go into the shared cache. The
//    cache is keyed by the target's matrix id and served to every viewer, so a
//    thumbnail a federated viewer's homeserver supplied would otherwise become
//    that user's avatar for everyone until the TTL ran out — and a hostile
//    homeserver can serve any image it likes. Federated viewers read the shared
//    cache, but what their homeserver sends is served to them alone, uncached.
//  - Memory is bounded three ways: each body is read with a byte ceiling, a
//    gate bounds how many upstream fetches are open at once, and the cache caps
//    its total bytes.
//  - A homeserver we do not run gets only a share of that gate (remoteGate),
//    so a federated viewer's stalled server cannot starve our own avatars.

import type { Release } from "./concurrencyGate.ts";
import type { MicroCache } from "./avatarMicroCache.ts";
import { readBytesCapped } from "./boundedBody.ts";

export type AvatarBytes = { bytes: ArrayBuffer; contentType: string };

/** A real 96 px crop is a few KB to a few tens of KB even as a lossless PNG
 *  (96 × 96 × 4 bytes raw is 36 KiB). 256 KiB is several times any honest
 *  thumbnail, and anything larger is not one. */
export const AVATAR_MAX_BYTES = 256 * 1024;

/** Total bytes the shared cache may hold. Honest thumbnails run ~5–40 KB, so
 *  the 500-entry count cap is the working bound (~20 MB at worst); this keeps
 *  500 entries at the per-entry ceiling (125 MiB) from ever being possible. */
export const AVATAR_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/** The gate every avatar fetch passes: it bounds the bytes held in flight
 *  (each open fetch may hold up to AVATAR_MAX_BYTES). A chat screen asks for
 *  many avatars at once, so a short queue serves them as slots free; past it
 *  the letter avatar answers. */
export const AVATAR_GATE_LIMITS = { maxConcurrent: 16, maxQueued: 100, maxWaitMs: 3000 };

/** The extra gate a fetch through a homeserver that is NOT ours passes first.
 *  A federated viewer's homeserver is one we do not run: if it trickles or
 *  never answers, its fetches hold their slots for the whole timeout. Without
 *  a share of their own they could hold every slot of the main gate, and
 *  every avatar not already cached would fall back to letters for everyone.
 *  Capped at 4 of the 16, foreign fetches always leave our own homeserver 12. */
export const AVATAR_REMOTE_GATE_LIMITS = { maxConcurrent: 4, maxQueued: 32, maxWaitMs: 3000 };

export type AvatarThumbDeps = {
  /** The target's mxc:// avatar URL from our own homeserver, or null. */
  resolveMxc: (matrixId: string) => Promise<string | null>;
  /** The homeserver transport (homeserverFetch). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Is this homeserver base ours? (homeserverTrust.isLocalHomeserverUrl) */
  isLocal: (homeserver: string) => boolean;
  gate: { acquire: () => Promise<Release | null> };
  /** Passed first, and held for the whole fetch, when the viewer's homeserver
   *  is not ours (AVATAR_REMOTE_GATE_LIMITS). */
  remoteGate: { acquire: () => Promise<Release | null> };
  cache: MicroCache<AvatarBytes>;
  /** Maps an upstream Content-Type to the image type we answer with. */
  contentType: (upstream: string | null) => string;
  timeoutMs: number;
};

/** The target's thumbnail, or null for "use the letter avatar" — no avatar,
 *  a malformed mxc, an upstream failure, an oversized body, or a full gate. */
export function createAvatarThumbLoader(deps: AvatarThumbDeps) {
  return async function loadAvatarThumb(
    matrixId: string,
    viewer: { homeserver: string; accessToken: string },
  ): Promise<AvatarBytes | null> {
    const cached = deps.cache.get(matrixId);
    if (cached) return cached;

    // A foreign homeserver's share first: a fetch refused here never waits
    // for, or holds, a slot of the main gate.
    const local = deps.isLocal(viewer.homeserver);
    const releaseRemote = local ? null : await deps.remoteGate.acquire();
    if (!local && !releaseRemote) return null;
    const release = await deps.gate.acquire();
    if (!release) {
      releaseRemote?.();
      return null;
    }
    try {
      const mxc = await deps.resolveMxc(matrixId);
      if (!mxc) return null;
      const [, , server, mediaId] = mxc.split("/");
      if (!server || !mediaId || !/^[A-Za-z0-9.-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(mediaId)) {
        return null;
      }
      const media = await deps.fetch(
        `${viewer.homeserver}/_matrix/client/v1/media/thumbnail/${server}/${mediaId}?width=96&height=96&method=crop`,
        {
          headers: { Authorization: `Bearer ${viewer.accessToken}` },
          cache: "no-store",
          signal: AbortSignal.timeout(deps.timeoutMs),
        },
      );
      if (!media.ok) {
        void media.body?.cancel().catch(() => {});
        return null;
      }
      const bytes = await readBytesCapped(media, AVATAR_MAX_BYTES);
      if (!bytes) return null; // over the ceiling or unreadable — never cached
      const thumb = { bytes: bytes.buffer, contentType: deps.contentType(media.headers.get("content-type")) };
      if (local) deps.cache.set(matrixId, thumb);
      return thumb;
    } catch {
      return null;
    } finally {
      release();
      releaseRemote?.();
    }
  };
}
