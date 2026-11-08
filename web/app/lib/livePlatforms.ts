// The Live row follows each platform's live state (per-platform liveness, Task 7). stream-api
// publishes every platform's public state (/stream/current `liveness`, the `platformStates` frame);
// this file decides, from it, which of the offered live sources still has a broadcast behind it and
// what the player says when none does. Pure — usePlatformStates.ts holds the React side.

import { PLATFORM_LIVENESS } from "./platformLiveness.generated.mjs";
import type { Platform, PublicSnapshot } from "./platformLiveness.generated.mjs";
import type { LiveSource } from "./playerSource.ts";

/** Each platform's public state, as the snapshot carries it (absent = not configured / not yet read). */
export type PlatformStates = PublicSnapshot["platforms"];

/**
 * The platform whose state decides each live source: the site's own player plays stream.place.
 * @test-only exported so livePlatforms.test.ts pins the map itself; this module's own functions are
 * its runtime readers.
 */
export const SOURCE_PLATFORM: Readonly<Record<LiveSource, Platform>> = Object.freeze({
  native: "streamplace",
  streamplace: "streamplace",
  youtube: "youtube",
  twitch: "twitch",
  kick: "kick",
});

/** A platform known to have no broadcast now: answered offline, or only scheduled (upcoming). */
function ended(platforms: PlatformStates, p: Platform): boolean {
  const s = platforms[p]?.state;
  return s === "offline" || s === "upcoming";
}

/**
 * The offered sources (`on`, liveSourcesOn) whose platform may be live: a source whose platform is
 * offline or upcoming is dropped; a missing or `unknown` platform keeps its source (nothing known is
 * no reason to hide a player). NO fail-open: every one dropped answers `[]`, and the player shows
 * its card (liveCardReason) — liveSourceOn then keeps the viewer's stored pick for when it returns.
 */
export function liveSourcesLive(on: readonly LiveSource[], platforms: PlatformStates): LiveSource[] {
  return on.filter((s) => !ended(platforms, SOURCE_PLATFORM[s]));
}

export type LiveCardReason =
  | { kind: "elsewhere"; platform: Platform }
  | { kind: "ended" }
  | { kind: "none" };

/**
 * What the Live card says when no source is playable, in this order:
 *  1. `elsewhere` — a platform is live but no shown source plays it ("Live on Kick.").
 *  2. `ended` — every set-up source's platform is offline or upcoming ("The stream has ended.").
 *  3. `none` — no player is set up (or nothing is known yet).
 * `setUp` = the sources this install has a channel for; `shown` = the ones the Live row offers.
 */
export function liveCardReason(setUp: readonly LiveSource[], shown: readonly LiveSource[], platforms: PlatformStates): LiveCardReason {
  const played = new Set(shown.map((s) => SOURCE_PLATFORM[s]));
  const elsewhere = PLATFORM_LIVENESS.PLATFORMS.find((p) => platforms[p]?.state === "live" && !played.has(p));
  if (elsewhere) return { kind: "elsewhere", platform: elsewhere };
  if (setUp.length > 0 && setUp.every((s) => ended(platforms, SOURCE_PLATFORM[s]))) return { kind: "ended" };
  return { kind: "none" };
}

/** The newer of two snapshots by their `at` (stream-api's clock); a tie keeps `cur` (what is shown). */
export function newest(cur: PublicSnapshot, next: PublicSnapshot | null | undefined): PublicSnapshot {
  return next && next.at > cur.at ? next : cur;
}
