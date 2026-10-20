"use client";

import { lsGetJSON, lsSetJSON } from "./safeLocalStorage";
import type { EmoteMap } from "./emoteMap";
import { parseStore, rankNames, bump } from "./recentEmotesCore";

// Device-local "frecency" store of used emotes (localStorage `recentEmotes`), shared
// by the emote PICKER (its "Frequent" row), the COMPLETION ranking (used emotes get a
// scoring boost + lead the empty-query list) and the warmer's seed order — recording
// a use from any of them keeps all three fresh. The frequency+decay logic lives in
// the pure, unit-tested recentEmotesCore; this file is just the localStorage + clock I/O.

const KEY = "recentEmotes";

/** Used emote names, strongest frecency first, filtered to ones that still exist. */
export function getRecentEmotes(emotes: EmoteMap): string[] {
  const now = Date.now();
  return rankNames(parseStore(lsGetJSON<unknown>(KEY, []), now), now, (n) => Boolean(emotes[n]));
}

/**
 * Record a use of `name` (from the picker or a completion commit).
 *
 * Takes no EmoteMap on purpose: recording a use must never depend on, or prune
 * against, the manifest that happens to be loaded right now. Existence is
 * resolved at READ time by getRecentEmotes.
 */
export function saveRecentEmote(name: string): void {
  const now = Date.now();
  const store = parseStore(lsGetJSON<unknown>(KEY, []), now);
  // No `exists` arg: bump must never prune persisted history on a degraded
  // manifest. rankNames() filters to existing emotes at read time instead.
  lsSetJSON(KEY, bump(store, name, now));
}
