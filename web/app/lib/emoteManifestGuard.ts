// Guard for the /api/emotes manifest rebuild. The emote CDNs (7TV especially) are
// intermittently flaky — a 5xx/timeout (the fetcher swallows it into an empty
// slice), or a truncated 200 that returns only a fraction of a set. The rebuild
// does a full replace, so without a guard one bad fetch silently drops emotes from
// the manifest until the next good rebuild (the "it only found 178 emotes, was
// ~1150" case). This decides, per provider slice, whether to take the freshly-
// fetched set or keep the last-good one from earlier in this process's life.
//
// A hard failure and a truncated response both land here as a shrunken count
// (a failure is count 0), so one count-based rule covers both.

/** A fresh slice under this fraction of its last-good count is treated as a
 *  truncated/failed response and rejected in favour of last-good. Deliberately
 *  low so a genuine mod removal (a handful of emotes) always passes — only a
 *  drastic drop (e.g. 1150 → 178, or → 0 on failure) trips it. */
// @test-only emoteManifestGuard.test.ts drives the shrink floor.
export const SHRINK_FLOOR = 0.5;

/** Only guard once a provider has proven it carries a real set; below this there's
 *  nothing trustworthy to fall back to, so take whatever we get. */
// @test-only emoteManifestGuard.test.ts drives the trust floor.
export const MIN_TRUST = 8;

/**
 * Decide a single provider slice for a rebuild.
 * @param freshCount emotes in the freshly-fetched slice (0 if the fetch failed or returned empty).
 * @param prevCount  emotes in the last-good slice (0 if none seen yet this process).
 * @param force      bypass the shrink guard — an intentional mass change (`/emotes force`).
 * @returns "fresh" to take the new slice, "keep-prev" to reuse last-good.
 */
export function sliceDecision(
  freshCount: number,
  prevCount: number,
  force: boolean,
): "fresh" | "keep-prev" {
  if (!force && prevCount >= MIN_TRUST && freshCount < prevCount * SHRINK_FLOOR) return "keep-prev";
  return "fresh";
}
