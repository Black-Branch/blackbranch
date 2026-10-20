// Pure frecency core (frequency + time-decayed recency) — no I/O, no clock, so it's
// unit-testable in isolation (see recentEmotesCore.test.ts). recentEmotes.ts is the
// thin localStorage + Date.now() wrapper around it.
//
// Frecency is the model Firefox's URL bar and Twitch's "Frequently used" picker row
// use: each use adds 1 to an emote's score; scores decay with a HALF_LIFE, so genuine
// favorites stay sticky while one-off uses sink and eventually age out. A pure-recency
// LRU churns the list to uselessness — every distinct emote touched once jumps to the
// front and shoves a real favorite past the cap.

export type FrecencyEntry = { name: string; score: number; at: number };

// @test-only recentEmotesCore.test.ts pins the cap.
export const RECENT_MAX = 40; // bound the stored list; frecency keeps favorites, so headroom is cheap
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — an unused emote loses half its weight in two weeks

/** Decay a stored score forward from its timestamp to `now`. */
function decay(score: number, from: number, now: number): number {
  const dt = now - from;
  return dt <= 0 ? score : score * Math.pow(0.5, dt / HALF_LIFE_MS);
}

/**
 * Parse persisted storage into entries, migrating the legacy `string[]` format
 * (most-recent-first) — seed decreasing scores stamped `now` (so nothing decays on
 * the first read) to preserve the old ordering until real uses re-weight the list.
 */
export function parseStore(raw: unknown, now: number): FrecencyEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (typeof raw[0] === "string") {
    const strs = raw.filter((n): n is string => typeof n === "string");
    return strs.map((name, i) => ({ name, score: strs.length - i, at: now }));
  }
  return (raw as FrecencyEntry[]).filter(
    (e) => e && typeof e.name === "string" && typeof e.score === "number" && typeof e.at === "number",
  );
}

/** Entry names, strongest decayed score first, filtered to ones that still exist. */
export function rankNames(store: FrecencyEntry[], now: number, exists: (name: string) => boolean): string[] {
  return store
    .filter((e) => exists(e.name))
    .map((e) => ({ name: e.name, eff: decay(e.score, e.at, now) }))
    .sort((a, b) => b.eff - a.eff)
    .map((e) => e.name);
}

/**
 * Record a use of `name`: decay-then-+1, cap to RECENT_MAX.
 *
 * Deliberately does NOT filter by `exists`. It used to, which made a single emote
 * pick DESTRUCTIVELY prune every entry missing from the manifest *at that moment* —
 * and the manifest genuinely does collapse sometimes (the 7TV "found 178, was 1150"
 * episode that `emoteManifestGuard` now defends against). One click during a
 * degraded fetch permanently erased the user's whole frecency history, with no way
 * to recover it.
 *
 * Existence is a *view* concern: rankNames() already filters to emotes that
 * currently exist, so a temporarily-missing entry is hidden while the manifest is
 * degraded and comes back on its own once the manifest recovers. Persisted state
 * should outlive a transient fetch failure.
 */
export function bump(store: FrecencyEntry[], name: string, now: number): FrecencyEntry[] {
  const prev = store.find((e) => e.name === name);
  const bumped: FrecencyEntry = { name, score: (prev ? decay(prev.score, prev.at, now) : 0) + 1, at: now };
  return [bumped, ...store.filter((e) => e.name !== name)]
    .sort((a, b) => decay(b.score, b.at, now) - decay(a.score, a.at, now))
    .slice(0, RECENT_MAX);
}
