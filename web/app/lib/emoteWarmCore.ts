// The pure half of the emote warm (emoteWarmer.ts): which URLs, in which tier and
// order, and whether a finished walk can be skipped. No DOM, no storage — unit-tested
// in emoteWarmCore.test.ts. See emoteWarmer.ts for the why.

import type { EmoteInfo, EmoteMap } from "./emoteMap";

/** The 300 most-used ≈ 90 % of uses (30-day measurement). */
const HOT_RANKS = 300;
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WarmNet = { saveData?: boolean; effectiveType?: string };
export type WarmPlan = { hot: string[]; tail: string[] };

const isChannelTwitch = (info: EmoteInfo) => info.url.includes("jtvnw.net");

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
}): WarmPlan {
  const { emotes, recent, still, net, size } = args;
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
  const tail = et === "3g" ? [] : urls([...ranked, ...unranked]);
  return { hot, tail };
}

/** Pure: the record key — any change in display size, still/animated or catalog re-runs the walk. */
export function warmRecordKey(sizingKey: string, still: boolean, emotes: EmoteMap): string {
  let h = 0;
  for (const n of Object.keys(emotes)) for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) | 0;
  return `${sizingKey}|${still ? "s" : "a"}|${Object.keys(emotes).length}:${(h >>> 0).toString(36)}`;
}

export type WarmRecord = { k: string; t: number; tier: "hot" | "all" };

/** Pure: what still needs doing given the record. */
export function warmNeeded(rec: WarmRecord | null, key: string, now: number, plan: WarmPlan): WarmPlan {
  if (!rec || rec.k !== key || now - rec.t > RECORD_TTL_MS) return plan;
  if (rec.tier === "all") return { hot: [], tail: [] };
  return { hot: [], tail: plan.tail };
}

