import { timingSafeEqual } from "crypto";
import { createCooldown } from "@/app/lib/rateLimit";
import { sliceDecision } from "@/app/lib/emoteManifestGuard";
import { twitchAppToken, twitchClientId } from "@/app/lib/twitch";
import { usageTokensWithin, rankByUsage } from "@/app/lib/emoteUsageServer";
import { instanceString } from "@/app/lib/instanceConfigServer";

export const dynamic = "force-dynamic";

// `ar` = intrinsic aspect ratio (width / height). Sent so the client can reserve
// the emote's exact width before the image loads (kills the chat-row layout shift
// / CLS). Only set when the CDN gives real dimensions (7TV, FFZ) or the format is
// guaranteed square (Twitch) — never guessed, since a wrong `aspect-ratio` would
// visibly squish the emote. Omitted for BTTV (no dimensions in its API).
// `still` = a static (first-frame) URL for an animated emote — see emoteMap.ts.
// `h` = the emote's real 1x height (px), so the client sizes per emote (emoteRes.ts).
// `r` (usage rank) is merged at GET time from emoteUsageServer — never cached in here.
type EmoteInfo = { url: string; zeroWidth: boolean; ar?: number; still?: string; h?: number; r?: number };
type EmoteMap = Record<string, EmoteInfo>;

// Module-level cache — survives across requests on the same server instance.
// Stale-while-revalidate: serve cached data instantly, refresh in background
// after TTL expires. Cold start waits once; every request after is <1ms.
let manifest: EmoteMap | null = null;
let manifestTs = 0;
let refreshing: Promise<RebuildResult> | null = null;
const MANIFEST_TTL = 30 * 60 * 1000; // 30 min

// Last successful per-provider slice (keyed by provider id). A rebuild does a
// full replace, so if one provider's fetch fails or comes back truncated the
// guard reuses that provider's last-good slice instead of dropping its emotes
// from the manifest — see emoteManifestGuard + rebuild().
const lastGood: Record<string, EmoteMap> = {};

type ProviderSlice = { id: string; fresh: number; prev: number; kept: "fresh" | "last-good" };
type RebuildResult = { map: EmoteMap; slices: ProviderSlice[]; guarded: string[] };

export async function getManifest(): Promise<EmoteMap> {
  const stale = Date.now() - manifestTs > MANIFEST_TTL;
  if (manifest && !stale) return manifest;
  if (manifest && stale) {
    // Serve stale immediately; kick off background refresh if not already running
    if (!refreshing) refreshing = rebuild(false, true).finally(() => { refreshing = null; });
    return manifest;
  }
  // Cold start: must wait for first build (deduplicated if concurrent requests)
  if (!refreshing) refreshing = rebuild(false, true).finally(() => { refreshing = null; });
  await refreshing;
  return manifest ?? {};
}

/** The manifest if it is ready within `ms`, else `{}`. For the pages that
 *  inline an emote slice into their HTML (emoteSubset.ts): a COLD manifest —
 *  the first request after every deploy — rebuilds from four providers with
 *  no fetch timeout of its own, and that must never hold the page's HTML. The
 *  rebuild keeps running and is warm for the next request; the page just
 *  renders its emotes as text this once, and the client fills them in. */
export function manifestWithin(ms = 1500): Promise<EmoteMap> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<EmoteMap>((resolve) => { timer = setTimeout(() => resolve({}), ms); });
  return Promise.race([getManifest().finally(() => clearTimeout(timer)), late]);
}

const FETCH_OPTS = { next: { revalidate: 0 } }; // we own the cache, skip Next.js fetch cache

type TwitchEmote = { id: string; name: string; format: string[]; images: { url_2x: string } };

function twitchEmoteUrl(e: TwitchEmote): string {
  const fmt = e.format.includes("animated") ? "animated" : "static";
  return `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/${fmt}/dark/3.0`;
}

// Twitch emote images are square by spec (28/56/112 px), so ar:1 is exact.
const twitchEntry = (e: TwitchEmote): [string, EmoteInfo] => [
  e.name,
  {
    url: twitchEmoteUrl(e), zeroWidth: false, ar: 1, h: 28,
    ...(e.format.includes("animated")
      ? { still: `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/static/dark/3.0` }
      : {}),
  },
];

// The channel's own emote set, and nothing else from Twitch (see the provider
// list for why the global set is excluded). Credentials
// come from the shared app token; if it is unavailable this returns {} like every
// other provider, and the manifest guard then falls back to that slice's
// last-good rather than dropping it.
async function fetchTwitchEmotes(broadcasterId: string): Promise<EmoteMap> {
  const token = await twitchAppToken();
  if (!token) return {};
  try {
    const res = await fetch(`https://api.twitch.tv/helix/chat/emotes?broadcaster_id=${broadcasterId}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": twitchClientId() },
      ...FETCH_OPTS,
    });
    if (!res.ok) return {};
    const data: { data: TwitchEmote[] } = await res.json();
    return Object.fromEntries((data.data ?? []).map(twitchEntry));
  } catch { return {}; }
}

// BTTV's API carries no zero-width flag — the overlay emotes are a well-known
// fixed set (the winter/costume globals). Chatterino and DankChat both hardcode
// this exact list; without it SoSnowy/cvHazmat & co. render as normal emotes
// instead of stacking onto the one before them.
const BTTV_ZERO_WIDTH = new Set([
  "SoSnowy", "IceCold", "SantaHat", "TopHat", "ReinDeer", "CandyCane", "cvMask", "cvHazmat",
]);

// width/height are present only when the emote is not 28×28. Every emote without
// them is square (some at 25×25 or 35×35), so ar 1 is exact for those, and `h` is
// left out for the client's nominal.
type BttvEmote = { id: string; code: string; imageType: string; width?: number; height?: number };
// BTTV serves a `/static/` rung (image/webp) for every emote, animated or not —
// no per-emote animated flag is needed, so only gif-format emotes (BTTV's
// animated format) get a `still`.
const bttvEntry = (e: BttvEmote): [string, EmoteInfo] => [
  e.code,
  {
    url: `https://cdn.betterttv.net/emote/${e.id}/3x.${e.imageType}`, zeroWidth: BTTV_ZERO_WIDTH.has(e.code),
    ar: e.width && e.height ? e.width / e.height : 1,
    ...(e.height ? { h: e.height } : {}),
    ...(e.imageType === "gif" ? { still: `https://cdn.betterttv.net/emote/${e.id}/static/3x.webp` } : {}),
  },
];

async function fetchBTTVChannel(userId: string): Promise<EmoteMap> {
  try {
    const res = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${userId}`, FETCH_OPTS);
    if (!res.ok) return {};
    const data: { channelEmotes: BttvEmote[]; sharedEmotes: BttvEmote[] } = await res.json();
    return Object.fromEntries([...(data.channelEmotes ?? []), ...(data.sharedEmotes ?? [])].map(bttvEntry));
  } catch { return {}; }
}

// Global sets — the overlay/stacking staples live here (BTTV's SoSnowy set,
// 7TV's global zero-widths), and Chatterino/DankChat both include Global
// BTTV/FFZ/7TV in their source order. Merged BELOW channel emotes (globals
// first in the merge, so a channel emote of the same name wins).
async function fetchBTTVGlobal(): Promise<EmoteMap> {
  try {
    const res = await fetch("https://api.betterttv.net/3/cached/emotes/global", FETCH_OPTS);
    if (!res.ok) return {};
    const data: BttvEmote[] = await res.json();
    return Object.fromEntries((data ?? []).map(bttvEntry));
  } catch { return {}; }
}

type FfzSets = { sets: Record<string, { emoticons: Array<{ name: string; width?: number; height?: number; urls: Record<string, string> }> }> };

function ffzSetsToMap(data: FfzSets): EmoteMap {
  const emotes: EmoteMap = {};
  for (const set of Object.values(data.sets ?? {})) {
    for (const e of set.emoticons ?? []) {
      const raw = e.urls["4"] ?? e.urls["2"] ?? e.urls["1"];
      if (raw) emotes[e.name] = {
        url: raw.startsWith("//") ? `https:${raw}` : raw,
        zeroWidth: false,
        ar: e.width && e.height ? e.width / e.height : undefined,
        // FFZ's width/height ARE the 1x dimensions.
        ...(e.height ? { h: e.height } : {}),
      };
    }
  }
  return emotes;
}

async function fetchFFZ(channel: string): Promise<EmoteMap> {
  try {
    const res = await fetch(`https://api.frankerfacez.com/v1/room/${channel}`, FETCH_OPTS);
    if (!res.ok) return {};
    return ffzSetsToMap(await res.json());
  } catch { return {}; }
}

async function fetchFFZGlobal(): Promise<EmoteMap> {
  try {
    const res = await fetch("https://api.frankerfacez.com/v1/set/global", FETCH_OPTS);
    if (!res.ok) return {};
    // Only the default sets are meant for everyone (the payload can carry more).
    const data: FfzSets & { default_sets?: number[] } = await res.json();
    const keep = new Set((data.default_sets ?? []).map(String));
    const sets = Object.fromEntries(Object.entries(data.sets ?? {}).filter(([id]) => keep.size === 0 || keep.has(id)));
    return ffzSetsToMap({ sets });
  } catch { return {}; }
}

type StvFile = { name: string; static_name?: string; width?: number; height?: number };
// flags bit 0 = ZeroWidth (1 << 0) on the active-emote entry, not the base emote data
type StvEmote = { name: string; flags?: number; data: { animated?: boolean; host: { url: string; files: StvFile[] } } };

// Intrinsic aspect ratio from any file that carries dimensions — every size rung
// of a 7TV emote shares the same ratio, so the first one with width & height wins.
function stvAspect(e: StvEmote): number | undefined {
  const f = e.data.host.files.find((f) => f.width && f.height);
  return f ? f.width! / f.height! : undefined;
}

// The 1x file's real height — 32 for most, ~20 for very wide emotes (7TV caps width).
function stvH1(e: StvEmote): number | undefined {
  const f = e.data.host.files.find((f) => f.name.startsWith("1x.") && f.height);
  return f?.height;
}

// Shared entry builder for the four 7TV fetchers (twitch/kick channel + global).
function stvEntry(e: StvEmote): [string, EmoteInfo] {
  const h = stvH1(e);
  const info: EmoteInfo = { url: stvBestUrl(e), zeroWidth: Boolean((e.flags ?? 0) & 1), ar: stvAspect(e), ...(h ? { h } : {}) };
  // The still frame comes from the SAME file stvBestUrl chose — its `static_name`
  // sibling — not a separately-picked rung, so the still and the animated image
  // are guaranteed to be the same emote at the same size.
  if (e.data.animated) {
    const file = stvPickFile(e);
    if (file?.static_name) info.still = `https:${e.data.host.url}/${file.static_name}`;
  }
  return [e.name, info];
}

// The file stvBestUrl's URL is built from — factored out so stvEntry can read
// its `static_name` sibling without re-deriving the pick (and without stvBestUrl
// itself changing behavior).
function stvPickFile(e: StvEmote): StvFile | undefined {
  const files = e.data.host.files;
  const pick = (name: string) => files.find((f) => f.name === name);
  const webp =
    pick("2x.webp") ?? pick("1x.webp") ?? pick("3x.webp") ?? pick("4x.webp") ??
    files.find((f) => f.name.endsWith(".webp"));
  if (webp) return webp;
  const gif =
    pick("2x.gif") ?? pick("3x.gif") ?? pick("4x.gif") ??
    files.find((f) => f.name.endsWith(".gif"));
  if (gif) return gif;
  return files[files.length - 1];
}

function stvBestUrl(e: StvEmote): string {
  // Prefer WebP at 2x for BOTH animated and static emotes. 7TV serves the same
  // emote as animated WebP (universally supported now) at ~5-10x smaller than the
  // equivalent GIF — 7TV emotes are by far the largest page payload, and a single
  // 4x.gif can be >3 MB while rendered at ~28px. 2x is the sweet spot: crisp on
  // hi-dpi displays (a 1x downgrade visibly blurs at DPR≥2) at a fraction of the
  // 4x size. Walk the WebP ladder, then GIF, then whatever's last as a final
  // fallback. (buildMatrixMessage's /[234]x→/1x downscale on SENT messages still
  // matches "2x.webp".)
  const file = stvPickFile(e);
  return file ? `https:${e.data.host.url}/${file.name}` : "";
}

// One fetcher for both channel connections — the twitch and kick bodies were
// byte-identical apart from the URL segment (7TV keys users by platform link).
async function fetch7TVUser(connection: "twitch" | "kick", userId: string): Promise<EmoteMap> {
  try {
    const res = await fetch(`https://7tv.io/v3/users/${connection}/${userId}`, FETCH_OPTS);
    if (!res.ok) return {};
    const data: { emote_set?: { emotes: StvEmote[] } } = await res.json();
    const emotes = data.emote_set?.emotes ?? [];
    return Object.fromEntries(
      emotes.filter((e) => e.data?.host?.files?.length).map(stvEntry)
    );
  } catch { return {}; }
}

async function fetch7TVGlobal(): Promise<EmoteMap> {
  try {
    const res = await fetch("https://7tv.io/v3/emote-sets/global", FETCH_OPTS);
    if (!res.ok) return {};
    const data: { emotes?: StvEmote[] } = await res.json();
    return Object.fromEntries(
      (data.emotes ?? []).filter((e) => e.data?.host?.files?.length).map(stvEntry)
    );
  } catch { return {}; }
}


// Rebuild the manifest from every provider. `force` bypasses the shrink guard
// (an intentional mass change); `commit` writes the result to the module cache +
// last-good slices (false = dry run, for the mod panel's `/emotes check`).
// Returns a per-provider summary so the caller can report what was taken vs kept.
async function rebuild(force: boolean, commit: boolean): Promise<RebuildResult> {
  // Instance keys (env first, then the stored values): an install without one simply has no
  // channel emotes from that platform.
  const twitchChannel = instanceString("platform.twitch.channel") ?? "";
  const twitchUserId = instanceString("platform.twitch.broadcasterId") ?? "";
  const kickUserId = instanceString("platform.kick.userId") ?? "";

  // GLOBAL sets first, channel sets after — Object.assign lets later entries
  // win, so a channel emote overrides a global of the same name (Chatterino's
  // source priority). Globals are where the stacking staples live (BTTV's
  // SoSnowy/cvHazmat set, 7TV's global zero-widths). Named so a failed/truncated
  // slice can fall back to its own last-good rather than nuking the whole map.
  // Twitch's GLOBAL emotes (Kappa/LUL/PogChamp/4Head, some three hundred) are
  // deliberately NOT a provider: from Twitch only the CHANNEL set is taken. The
  // third-party globals below already cover what chatters reach for, and Twitch's
  // own globals would compete with them for the same autocomplete. Adding
  // `helix/chat/emotes/global` back is a product decision, not a fix.
  const providers: Array<{ id: string; fetch: () => Promise<EmoteMap> }> = [
    { id: "bttv:global", fetch: fetchBTTVGlobal },
    { id: "ffz:global", fetch: fetchFFZGlobal },
    { id: "7tv:global", fetch: fetch7TVGlobal },
    { id: "ffz:channel", fetch: () => fetchFFZ(twitchChannel) },
  ];
  if (twitchUserId) {
    providers.push(
      { id: "bttv:channel", fetch: () => fetchBTTVChannel(twitchUserId) },
      { id: "7tv:channel", fetch: () => fetch7TVUser("twitch", twitchUserId) },
      { id: "twitch:channel", fetch: () => fetchTwitchEmotes(twitchUserId) },
    );
  }
  if (kickUserId) {
    providers.push({ id: "7tv:kick", fetch: () => fetch7TVUser("kick", kickUserId) });
  }

  const fetched = await Promise.all(providers.map(async (p) => ({ id: p.id, freshMap: await p.fetch() })));
  const slices: ProviderSlice[] = [];
  const guarded: string[] = [];
  const committedMaps: EmoteMap[] = [];
  for (const { id, freshMap } of fetched) {
    const prevMap = lastGood[id];
    const freshCount = Object.keys(freshMap).length;
    const prevCount = prevMap ? Object.keys(prevMap).length : 0;
    if (sliceDecision(freshCount, prevCount, force) === "keep-prev") {
      guarded.push(id);
      committedMaps.push(prevMap ?? {});
      slices.push({ id, fresh: freshCount, prev: prevCount, kept: "last-good" });
    } else {
      if (commit) lastGood[id] = freshMap;
      committedMaps.push(freshMap);
      slices.push({ id, fresh: freshCount, prev: prevCount, kept: "fresh" });
    }
  }

  const map = Object.assign({}, ...committedMaps);
  if (commit) {
    manifest = map;
    manifestTs = Date.now();
  }
  return { map, slices, guarded };
}

// The manifest with each used emote's 30-day rank (`r`) merged in — a NEW object,
// memoized per (manifest, usage list), so the module cache that emoteSubset and the
// server pages read never carries ranks. Ranks are a warm-order hint only.
let ranked: { base: EmoteMap; tokens: string[] | null; map: EmoteMap } | null = null;
function withRanks(base: EmoteMap, tokens: string[] | null): EmoteMap {
  if (!tokens) return base;
  if (ranked && ranked.base === base && ranked.tokens === tokens) return ranked.map;
  const ranks = rankByUsage(tokens, new Set(Object.keys(base)));
  const map: EmoteMap = {};
  for (const [name, info] of Object.entries(base)) {
    const r = ranks.get(name);
    map[name] = r ? { ...info, r } : info;
  }
  ranked = { base, tokens, map };
  return map;
}

export async function GET() {
  // Named `map`, not `manifest` — shadowing the module-level cache here made
  // the cache invisible to anyone reading this handler.
  const base = await getManifest();
  const tokens = await usageTokensWithin(Object.keys(base));
  const map = withRanks(base, tokens);
  // Let the browser/edge cache the manifest so repeat loads and new tabs skip the
  // origin round-trip. The route is server-memoized already (30-min SWR above), and
  // the client always refetches once per load, so a short max-age + long SWR keeps
  // emotes fresh without a guaranteed request every load. A mod's `/emotes refresh`
  // still goes live promptly for new loads once this window lapses (it POSTs to
  // force a rebuild; already-loaded clients were never live-updated anyway).
  return Response.json(map, {
    headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=1800" },
  });
}

// Force an immediate rebuild, bypassing the 30-min TTL — used by the mod
// panel's `/emotes refresh|force` so a mod-added emote can go live without
// waiting on the stale-while-revalidate cycle. A forced (guard-bypassing) rebuild runs on its
// own so the override actually applies; an ordinary manual refresh deduplicates
// against any in-flight background rebuild rather than starting a second one.
async function forceRefreshManifest(force: boolean): Promise<RebuildResult> {
  if (force) return rebuild(true, true);
  if (!refreshing) refreshing = rebuild(false, true).finally(() => { refreshing = null; });
  return refreshing;
}

// `check` (dry run) has its own cooldown bucket so a preview doesn't block the
// real refresh that usually follows it.
const refreshCooldown = createCooldown(20_000);

// POST has no in-app caller — /api/mod/emotes calls emoteAdminAction
// in-process. It stays as a secret-gated ops/curl surface. The route is
// reachable publicly through the tunnel, where the real client IP is lost — so gate on the shared internal
// secret (the same `Authorization: Bearer <STREAM_API_SECRET>` the web app
// already uses to reach stream-api) rather than by IP. Without this, ANYONE
// could POST ?force=1 to bypass the shrink guard and nuke the emote manifest AND
// its last-good fallback (a forced rebuild overwrites lastGood).
function isInternal(req: Request): boolean {
  const secret = process.env.STREAM_API_SECRET || "";
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  const token = m ? m[1] : "";
  if (!secret || !token) return false;
  const a = Buffer.from(token), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The refresh/check operation itself, callable IN-PROCESS. /api/mod/emotes
 * imports this directly rather than fetching its own public URL: that hairpin
 * runs out through the tunnel and back into the same server, so a tunnel blip
 * would surface as "Refresh failed" with no error recorded anywhere. The POST
 * below stays only as the secret-gated surface for ops/curl.
 *
 * Cooldowns live in here so both surfaces share one bucket.
 */
export async function emoteAdminAction(
  opts: { check?: boolean; force?: boolean }
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Dry run: report what a refresh WOULD do (added/removed + which providers the
  // guard would hold) without committing — so a truncated 7TV response can be
  // spotted before it lands. Still hits the providers, hence its own cooldown.
  if (opts.check) {
    if (refreshCooldown.hit("check")) {
      return { status: 429, body: { ok: false, error: "cooldown" } };
    }
    // getManifest(), not the raw module variable: after a restart the module
    // cache is empty until the first GET builds it, so a raw read would report
    // `current: 0` / "everything added" against a site serving emotes fine.
    // The comparison base must be what the site would actually serve.
    const current = new Set(Object.keys(await getManifest()));
    const { map, slices, guarded } = await rebuild(false, false);
    const next = new Set(Object.keys(map));
    const added = [...next].filter((k) => !current.has(k));
    const removed = [...current].filter((k) => !next.has(k));
    return {
      status: 200,
      body: {
        ok: true, dryRun: true,
        current: current.size, wouldLoad: next.size,
        added: added.length, removed: removed.length,
        addedSample: added.slice(0, 15), removedSample: removed.slice(0, 15),
        guarded, slices,
      },
    };
  }

  if (refreshCooldown.hit("global")) {
    return { status: 429, body: { ok: false, error: "cooldown" } };
  }
  const before = manifest ? Object.keys(manifest).length : 0;
  const { map, guarded, slices } = await forceRefreshManifest(opts.force === true);
  return {
    status: 200,
    body: { ok: true, count: Object.keys(map).length, before, forced: opts.force === true, guarded, slices },
  };
}

export async function POST(req: Request) {
  if (!isInternal(req)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const { status, body } = await emoteAdminAction({
    check: params.get("check") === "1",
    force: params.get("force") === "1",
  });
  return Response.json(body, { status });
}
