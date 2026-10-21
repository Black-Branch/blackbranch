// The watch page's header numbers, from whichever platforms this install streams to. Pure, so a
// Twitch-less install is tested as plainly as a Twitch one (watchHeader.test.ts).

/** The live title: Twitch's live stream, else the first platform row that has one (Twitch's
 *  channel, YouTube's confirmed broadcast, Kick's channel — the Stream tab's order), else the
 *  install's fallback. Offline there is no title. */
export function watchTitle(v: {
  live: boolean;
  twitchLive: string | null;
  rows: readonly { title: string | null }[];
  fallback: string;
}): string {
  if (!v.live) return "";
  return v.twitchLive || v.rows.find((r) => r.title)?.title || v.fallback;
}

/** Followers across the platforms that report a count; null when none does. */
export function followerTotal(counts: readonly (number | null)[]): number | null {
  const known = counts.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}
