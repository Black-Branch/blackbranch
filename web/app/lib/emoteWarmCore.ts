// The pure half of the emote warm (emoteWarmer.ts): which URLs, in which tier and
// order, and whether a finished walk can be skipped. No DOM, no storage — unit-tested
// in emoteWarmCore.test.ts. See emoteWarmer.ts for the why.

import type { EmoteInfo, EmoteMap } from "./emoteMap";
import { emoteUrlOnHost } from "./emoteRes.ts";

/** The 300 most-used ≈ 90 % of uses (30-day measurement). */
const HOT_RANKS = 300;
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WarmNet = { saveData?: boolean; effectiveType?: string };
export type WarmPlan = { hot: string[]; tail: string[] };

const isChannelTwitch = (info: EmoteInfo) => emoteUrlOnHost(info.url, "jtvnw.net");

/**
 * Pure: which URLs to warm, in which tier and order. `size` maps a URL (+ the
 * emote's 1x height) to the rung this display renders.
 */
export function planWarm(args: {
  emotes: EmoteMap;
  recent: readonly string[];
  still: boolean;
  net: WarmNet;
  size: (url: string, h?: number) => string;
  /** The rung a sticker of this emote renders (the largest — emoteRes stickerResEmoteUrl). */
  sticker?: (url: string, still: boolean) => string;
}): WarmPlan {
  const { emotes, recent, still, net, size, sticker } = args;
  const et = net.effectiveType ?? "";
  if (net.saveData || et === "slow-2g" || et === "2g") return { hot: [], tail: [] };

  const names = Object.keys(emotes);
  const hotNames: string[] = [];
  const isHot = new Set<string>();
  const take = (n: string) => { if (!isHot.has(n) && emotes[n]) { isHot.add(n); hotNames.push(n); } };
  for (const n of recent) take(n);
  for (const n of names) if (isChannelTwitch(emotes[n]!)) take(n);
  names
    .filter((n) => (emotes[n]!.r ?? Infinity) <= HOT_RANKS)
    .sort((a, b) => emotes[a]!.r! - emotes[b]!.r!)
    .forEach(take);
  // The tail: anything ranked beyond the hot set by rank, then the never-used in
  // REVERSE manifest order (the manifest assembles globals first, channel sets
  // last, so reversing reaches the channel's own sets before the global tail).
  const ranked = names.filter((n) => !isHot.has(n) && emotes[n]!.r).sort((a, b) => emotes[a]!.r! - emotes[b]!.r!);
  const unranked = names.filter((n) => !isHot.has(n) && !emotes[n]!.r).reverse();

  const seen = new Set<string>();
  const urls = (list: string[]) => {
    const out: string[] = [];
    for (const n of list) {
      const info = emotes[n]!;
      const u = size(still && info.still ? info.still : info.url, info.h);
      if (u && !seen.has(u)) { seen.add(u); out.push(u); }
    }
    return out;
  };
  const hot = urls(hotNames);
  if (et === "3g") return { hot, tail: [] };
  // Stickers head the tail: a sticker renders the largest rung, which chat never fetches, and
  // it is the biggest thing on screen when it pops in late. The emotes this chat has stickered
  // in the last 30 days (`s`), by rank.
  const stickers: string[] = [];
  if (sticker) {
    for (const n of names.filter((x) => emotes[x]!.s).sort((a, b) => emotes[a]!.s! - emotes[b]!.s!)) {
      const u = sticker(emotes[n]!.url, still);
      if (u && !seen.has(u)) { seen.add(u); stickers.push(u); }
    }
  }
  return { hot, tail: [...stickers, ...urls([...ranked, ...unranked])] };
}

/** Pure: the record key — any change in display size, still/animated, catalog or the set of
 *  stickered emotes re-runs the walk. */
export function warmRecordKey(sizingKey: string, still: boolean, emotes: EmoteMap): string {
  let h = 0;
  for (const n of Object.keys(emotes)) {
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) | 0;
    if (emotes[n]!.s) h = (h * 31 + 7) | 0;
  }
  return `${sizingKey}|${still ? "s" : "a"}|${Object.keys(emotes).length}:${(h >>> 0).toString(36)}`;
}

export type WarmRecord = { k: string; t: number; tier: "hot" | "all" };

/** Pure: what still needs doing given the record. */
export function warmNeeded(rec: WarmRecord | null, key: string, now: number, plan: WarmPlan): WarmPlan {
  if (!rec || rec.k !== key || now - rec.t > RECORD_TTL_MS) return plan;
  if (rec.tier === "all") return { hot: [], tail: [] };
  return { hot: [], tail: plan.tail };
}

