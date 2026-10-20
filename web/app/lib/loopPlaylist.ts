// The community fallback playlist's embed URL.
//
// Deliberately a standalone module with NO imports. `node --test` resolves this
// file directly, and Node's ESM loader cannot follow the extensionless imports
// that streamView.ts (this function's natural home) carries — a lib that pulls
// one in silently loses its whole test suite. Hence the structural param type
// instead of importing LoopVideo.

/**
 * Embed URL that loops the whole fallback playlist — no YouTube API, no quota.
 *
 * Two rules the embed player enforces, neither obvious:
 *   1. The first id goes in the PATH and `playlist=` carries only the REST.
 *      Putting the whole list in `playlist` plays the first video twice per lap.
 *   2. A single-video list only loops if that same id is REPEATED in `playlist=`.
 *      With `loop=1` alone it plays once and stops on the end screen.
 *
 * Returns null for an empty list, so the caller renders nothing rather than a
 * malformed embed.
 */
export function loopPlaylistSrc(videos: { video_id: string }[]): string | null {
  const ids = videos.map((v) => v.video_id).filter(Boolean);
  const first = ids[0];
  if (!first) return null;
  const rest = ids.length === 1 ? first : ids.slice(1).join(",");
  // The tail is written as a literal, not imported: this module keeps ZERO
  // imports on purpose (see the header) so `node --test` can resolve it.
  // playerApiReach.test.ts asserts it still equals playerSource.ts's
  // YT_EMBED_PARAMS.
  return (
    `https://www.youtube.com/embed/${first}` +
    `?autoplay=1&playsinline=1&rel=0&iv_load_policy=3&enablejsapi=1&mute=1&loop=1&playlist=${rest}`
  );
}
