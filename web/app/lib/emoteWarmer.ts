"use client";

import type { EmoteMap } from "./emoteMap";
import { planWarm, warmNeeded, warmRecordKey, type WarmNet, type WarmRecord } from "./emoteWarmCore";
import { getRecentEmotes } from "./recentEmotes";
import { emoteCrossOrigin, emoteSizingKey, rightSizeEmoteUrl } from "./emoteRes";
import { settingGet } from "./settingsRegistry";
import { lsGetJSON, lsSetJSON } from "./safeLocalStorage";

// Background emote warm — usage first, the tail after, ONCE per device.
//
// Walking the WHOLE manifest on every page load — animated even with animation
// off, at a 2x floor, with no Save-Data check — costs tens of MB on a first
// visit and a thousand-plus fetches through the service worker on every load
// after. So, in order:
//   1. HOT — this viewer's recents, the channel's own Twitch emotes (the picker's
//      first screen), then the 300 most-used emotes of the last 30 days (`r`, from
//      /api/emotes) — ≈ 90 % of every emote typed. Warmed at once, 6 in flight.
//   2. TAIL — everything else, after the hot set, a few at a time at idle.
//      The tail is NOT optional polish: a cold 7TV fetch can cost 360–830 ms
//      against single-digit ms from cache, so without it the remaining ~10 % of
//      emote uses would arrive late.
//   3. A localStorage record says the walk is done (same display size, same
//      still/animated choice, same catalog, < 7 days) — a returning visit makes
//      ZERO warm requests; the bytes live in the service worker's LRU cache.
// Every URL is the SAME right-sized URL the renderer and the picker request
// (emoteRes.ts), so warmed bytes == rendered bytes.
//
// Animated emotes off (and Low power, which turns that switch off) → only the
// still frames are warmed. Save-Data or a 2g link → nothing at all; 3g → hot only.

const HOT_CONCURRENCY = 6;
const TAIL_CONCURRENCY = 4;
const RECORD_KEY = "emoteWarm_v1";

function prefetch(url: string): Promise<void> {
  // A GET warms the cache WITHOUT decoding — the later <img> for the same URL is a
  // cache hit and decodes on demand, so no decoded bitmaps are held for emotes not
  // on screen. In the <img>'s own CORS mode (emoteCrossOrigin): a copy warmed in
  // another mode is one the image cannot use. priority:"low" is load-bearing:
  // warming must YIELD to the fetchPriority:high emotes on screen (the service
  // worker forwards the difference — sw.js), or the warm becomes head-of-line
  // blocking for them.
  const init = emoteCrossOrigin(url) === "anonymous"
    // credentials "same-origin" (fetch's default) is what <img crossOrigin="anonymous"> sends;
    // "omit" looks equivalent cross-origin but its copy is not reused by the image (measured).
    ? { mode: "cors", credentials: "same-origin", cache: "force-cache", priority: "low" }
    : { mode: "no-cors", cache: "force-cache", priority: "low" };
  return fetch(url, init as RequestInit).then(() => {}, () => {});
}

function drain(urls: string[], concurrency: number, idle: boolean): Promise<void> {
  return new Promise((resolve) => {
    if (urls.length === 0) { resolve(); return; }
    let next = 0;
    let active = 0;
    const wait = (fn: () => void) =>
      idle && typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(() => fn(), { timeout: 2000 }) : fn();
    const pump = (): void => {
      if (next >= urls.length) { if (active === 0) resolve(); return; }
      const u = urls[next++]!;
      active++;
      prefetch(u).then(() => { active--; wait(pump); });
    };
    for (let c = 0; c < concurrency; c++) pump();
  });
}

function net(): WarmNet {
  const c = (navigator as Navigator & { connection?: WarmNet }).connection;
  return { saveData: c?.saveData, effectiveType: c?.effectiveType };
}

// Per-page dedupe: the mount-time warm of the cached manifest and the later warm of
// the fresh one share one in-flight walk per URL.
const inFlight = new Set<string>();
let latest: EmoteMap | null = null;
let latestTail = false;
let listening = false;

/** Warm the emote set (see the header). Safe to call repeatedly.
 *  `withTail: false` — the hot set only: useEmotes warms the CACHED manifest at
 *  mount this way, because a cache written before usage ranks existed has no `r`,
 *  and starting the tail from it would queue all 1,187 ahead of the ranked hot set
 *  the fresh manifest brings a moment later. */
export function warmEmotes(emotes: EmoteMap, withTail = true): void {
  if (typeof window === "undefined") return;
  latest = emotes;
  latestTail = withTail;
  if (!listening) {
    listening = true;
    // Flipping "Animated emotes" (or Low power) changes which URLs chat renders.
    window.addEventListener("bb:setting", (e) => {
      if ((e as CustomEvent).detail === "chatStyle_animEmotes" && latest) warmEmotes(latest, latestTail);
    });
  }
  const still = settingGet("chatStyle_animEmotes") === "0";
  const key = warmRecordKey(emoteSizingKey(), still, emotes);
  const plan = planWarm({ emotes, recent: getRecentEmotes(emotes), still, net: net(), size: (u, h) => rightSizeEmoteUrl(u, h) });
  const todo = warmNeeded(lsGetJSON<WarmRecord | null>(RECORD_KEY, null), key, Date.now(), plan);
  const fresh = (l: string[]) => l.filter((u) => !inFlight.has(u) && (inFlight.add(u), true));
  const hot = fresh(todo.hot);
  const tail = withTail ? fresh(todo.tail) : [];
  if (hot.length === 0 && tail.length === 0) return;
  void drain(hot, HOT_CONCURRENCY, false)
    .then(() => { if (withTail && plan.hot.length) lsSetJSON(RECORD_KEY, { k: key, t: Date.now(), tier: plan.tail.length ? "hot" : "all" }); })
    .then(() => drain(tail, TAIL_CONCURRENCY, true))
    .then(() => { if (withTail && plan.tail.length) lsSetJSON(RECORD_KEY, { k: key, t: Date.now(), tier: "all" }); });
}
