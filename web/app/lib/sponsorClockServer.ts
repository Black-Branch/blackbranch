// Server-side: is this viewer's sponsor clock lit right now? Asked by the earn
// path (coinsServer.ts createEarn) to decide the 2x participation bonus.
// Reads stream-api's GET /sponsors/clock through streamApi.ts, which carries
// the shared secret.
//
// Never import this into a client component.
//
// FAILURE IS 1x. A missing, slow or broken stream-api must never block or fail
// an earn — the base award is unconditional and this only adds to it. So: a
// hard 2s deadline (the chat-send path is waiting on us), and EVERY failure
// mode — non-2xx, bad body, thrown, timed out — answers false, warned once.
//
// 30s per-viewer cache, both answers. A clock that expires mid-window pays the
// bonus for at most 30s longer; one that lights mid-window starts paying
// within 30s. The badge itself resyncs on a ~60s heartbeat, so this is not
// the coarse part. Both answers are cached on purpose: a failing stream-api
// must not be asked once per chat message.

import { streamApiFetch } from "./streamApi.ts";

/** @test-only asserted by sponsorClockServer.test.ts as the published TTL;
 *  read only through clockActiveFor(). */
export const CLOCK_CACHE_MS = 30_000;

/** @test-only asserted by sponsorClockServer.test.ts as the published
 *  deadline — deliberately NOT streamApi's 10s default. */
export const CLOCK_TIMEOUT_MS = 2_000;

// Mirrors stream-api/sponsors.js's own `MATRIX_ID_RE` — the guard its
// `GET /sponsors/clock` route 400s a request against. earnUpvoteReceived's
// `recipient` is sometimes a PLATFORM message's canonical id (12-char hex,
// stream.chat_log.user_id), not a matrix id — that recipient has no site
// wallet, so the bonus was never owed either way, but without this check
// every such call still made the round trip and stream-api warned "400 —
// paying 1x" once per platform upvote (56/stream on the first live run). A
// shape check that costs nothing skips the HTTP call for the case that was
// never going anywhere.
const MATRIX_ID_RE = /^@[^:\s]+:[^\s]+$/;

const cache = new Map<string, { active: boolean; until: number }>();

/** @test-only clears the per-viewer cache between tests. */
export function _resetClockCache(): void { cache.clear(); }

/** Wired into coinsServer.ts's createEarn, which calls this to gate
 *  earnRules.ts's bonusFor(). */
export async function clockActiveFor(matrixId: string, nowMs: number = Date.now()): Promise<boolean> {
  // Not matrix-shaped → definitely no clock (and definitely no round trip).
  // This is an EXPECTED shape, not a stream-api failure, so no warning —
  // unlike every other `false` path below, which all mean something upstream
  // broke.
  if (!MATRIX_ID_RE.test(matrixId)) return false;
  const hit = cache.get(matrixId);
  if (hit && hit.until > nowMs) return hit.active;
  let active = false;
  try {
    const res = await streamApiFetch(
      `/sponsors/clock?matrixId=${encodeURIComponent(matrixId)}`, undefined, CLOCK_TIMEOUT_MS,
    );
    if (res.ok) {
      const body = (await res.json()) as { ok?: unknown; active?: unknown };
      if (body.ok !== true || typeof body.active !== "boolean") {
        // A 200 with valid JSON but the wrong shape (a route/field rename on
        // the stream-api side, say) used to fall through the checks below and
        // silently answer false with nothing to notice — see
        // sponsorClockParity.test.ts. Still pays 1x; this only makes it loud.
        console.warn("[coins] clock lookup 200'd with an unexpected body shape — paying 1x: %s", JSON.stringify(body));
      }
      active = body.ok === true && body.active === true;
    } else {
      console.warn("[coins] clock lookup answered %d — paying 1x", res.status);
    }
  } catch (e) {
    console.warn("[coins] clock lookup failed — paying 1x: %s", e instanceof Error ? e.message : String(e));
  }
  cache.set(matrixId, { active, until: nowMs + CLOCK_CACHE_MS });
  return active;
}
