// The single home for emote CDN URL tier sizing, so the ladders + per-provider URL
// shapes live once (no regexes scattered across files). Plain util — no "use client",
// no hooks, all DOM access guarded inside functions — so it imports cleanly into both
// client components and server routes (e.g. the sticker spend route calls stickerResEmoteUrl).
//
//   • sizeEmoteUrl / rightSizeEmoteUrl / pickerEmoteUrl — the SMALLEST rung whose native
//     height covers the drawn device pixels. Never one below (never blurry), never
//     more than needed (the bytes).
//   • baselineEmoteUrl — the 2x rung, what server-rendered HTML carries.
//   • stepDownEmoteUrl — step DOWN one rung for load-error recovery (a picked tier a
//     given emote doesn't actually render 404s into a broken image; the next-lower
//     rung usually exists — Chatterino's ImageSet fall-down).
//   • lowerResEmoteUrl / stickerResEmoteUrl — force the smallest / largest rung, for
//     tiny thumbnails + sent-message emotes (min) and the large sticker render (max).
//
// Per-EMOTE heights, not per-provider. A rung's height is `h1 × multiplier`, where
// h1 is THAT emote's real 1x height (EmoteInfo.h, from /api/emotes). A ladder that
// assumes every 7TV 1x is 32 px is wrong: a wide emote's 1x is 19–21 px, so its "2x"
// is 42 px, and on a DPR2 screen a 60.6 device-px draw from a 42 px file is blurry
// (ratio 0.69). BTTV 1x runs 28–40 px. Without h1 the provider's nominal 1x height is
// assumed.
//
// No 2x floor. The layout's prepaint script restores --chat-font-size / --chat-emote-size
// before any script runs, so the read is the real value from the first render; and a later
// change (browser zoom, the emote-size or font slider) bumps the sizing key below, which
// re-sizes every rendered emote. Formats are WebP on purpose: animated AVIF costs
// ~1.75× the CPU of animated WebP for as long as it is on screen.
//
// The renderer (renderText), the warmer (emoteWarmer) and the picker all size through
// here, so the bytes we prefetch are the exact bytes chat and the picker render.

// The emote CDNs that send CORS headers — the same hosts public/sw.js caches (EMOTE_HOSTS;
// emoteCors.test.ts holds the two equal). BTTV sends none, so it must stay a plain request.
const CORS_EMOTE_HOSTS = /(?:^|\.)(?:7tv\.app|frankerfacez\.com|jtvnw\.net)$/;

/**
 * The CORS mode every request for this emote image uses — <img crossOrigin>, the warmers and
 * the service worker alike. One mode means one cached copy: 7TV answers `Vary: origin`, so a
 * plain <img> copy (no Origin) never satisfied the worker's CORS request and every 7TV emote
 * was downloaded a second time on the first return visit (emoteCors.test.ts has the numbers).
 * Anonymous also matches the layout's `crossOrigin` preconnects, which a plain <img> could not use.
 */
export function emoteCrossOrigin(url: string): "anonymous" | undefined {
  try {
    return CORS_EMOTE_HOSTS.test(new URL(url).host) ? "anonymous" : undefined;
  } catch {
    return undefined;
  }
}

type Ladder ={ tokens: string[]; mult: number[]; h1: number };

/** The lowercased hostname of an emote URL (absolute or protocol-relative), or "" when it does not parse. */
function emoteHost(url: string): string {
  try {
    return new URL(url, "https://emote.invalid").hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Is this emote URL served from `domain` or a subdomain of it? The parsed host, never a substring
 *  of the whole URL: `https://evil.test/jtvnw.net/1.0` is not Twitch. */
export function emoteUrlOnHost(url: string, domain: string): boolean {
  const host = emoteHost(url);
  return host === domain || host.endsWith("." + domain);
}

// `tokens[i]` is the substring in the URL for rung i; its native height is mult[i] × h1.
const STV: Ladder = { tokens: ["1x", "2x", "3x", "4x"], mult: [1, 2, 3, 4], h1: 32 };
const TWITCH: Ladder = { tokens: ["1.0", "2.0", "3.0"], mult: [1, 2, 4], h1: 28 };
const FFZ: Ladder = { tokens: ["1", "2", "4"], mult: [1, 2, 4], h1: 32 };
// BTTV's API gives width/height only for emotes that are not 28×28 — but some of the
// ones without (KEKW 25, OOOO 27, FeelsBadMan 30, SourPls 35) are squares of another
// size. The nominal is the SMALLEST seen, so an unknown height can only over-size.
const BTTV: Ladder = { tokens: ["1x", "2x", "3x"], mult: [1, 2, 3], h1: 25 };

// One descriptor per provider whose URL carries a size rung: how to recognize it,
// its ladder, how to read the current rung token, and how to swap in another.
type Provider = {
  domains: string[]; // the URL's host is one of these or beneath one
  ladder: Ladder;
  token: RegExp; // capture group 1 = the current rung token (a ladder token)
  swap: (url: string, token: string) => string;
};

const PROVIDERS: Provider[] = [
  { // 7TV — .../<id>/<Nx>[_static].<ext>
    domains: ["7tv.app", "7tv.io"],
    ladder: STV,
    token: /\/([1-4]x)(?:_static)?\.(?:webp|gif|avif|png)(?:\?|$)/,
    swap: (u, t) => u.replace(/\/[1-4]x((?:_static)?\.(?:webp|gif|avif|png))/, `/${t}$1`),
  },
  { // Twitch — .../dark/<N.0>
    domains: ["jtvnw.net"],
    ladder: TWITCH,
    token: /\/([1-3]\.0)(?:\?|$)/,
    swap: (u, t) => u.replace(/\/[1-3]\.0(\?|$)/, `/${t}$1`),
  },
  { // FFZ — .../emote/<id>/<1|2|4>
    domains: ["frankerfacez.com"],
    ladder: FFZ,
    token: /\/([124])(?:\?|$)/,
    swap: (u, t) => u.replace(/\/[124](\?|$)/, `/${t}$1`),
  },
  { // BTTV — .../emote/<id>/[static/]<Nx>[.<ext>]
    domains: ["betterttv.net"],
    ladder: BTTV,
    token: /\/([1-3]x)(?:\.\w+)?(?:\?|$)/,
    swap: (u, t) => u.replace(/\/[1-3]x((?:\.\w+)?(?:\?|$))/, `/${t}$1`),
  },
];
// Anything unrecognized has no rung in the URL → left untouched.

function providerFor(url: string): Provider | null {
  for (const p of PROVIDERS) if (p.domains.some((d) => emoteUrlOnHost(url, d))) return p;
  return null;
}

/** Native px height of each rung for this emote. */
const heights = (l: Ladder, h1?: number) => l.mult.map((m) => m * (h1 && h1 > 0 ? h1 : l.h1));

/** Pure: the smallest rung whose native height is ≥ `targetPx` (the top rung if none is).
 *  `h1` = the emote's real 1x height (EmoteInfo.h); omitted → the provider's nominal one.
 *  @test-only exported so the ladder rules are unit-tested without a DOM; the callers are rightSizeEmoteUrl and pickerEmoteUrl below (check-orphans does not count in-file references). */
export function sizeEmoteUrl(url: string, targetPx: number, h1?: number): string {
  if (!url) return url;
  const p = providerFor(url);
  if (!p || !p.token.test(url)) return url;
  const hs = heights(p.ladder, h1);
  let i = hs.findIndex((h) => h >= targetPx);
  if (i < 0) i = hs.length - 1;
  return p.swap(url, p.ladder.tokens[i]!);
}

/** Pure: the native px height a URL's rung paints, or null when the URL has no rung.
 *  @test-only exported for the unit test; the caller is rightSizeEmoteUrl's keep rule below (check-orphans does not count in-file references). */
export function rungHeight(url: string, h1?: number): number | null {
  const p = url ? providerFor(url) : null;
  const m = p?.token.exec(url);
  if (!p || !m) return null;
  const i = p.ladder.tokens.indexOf(m[1]!);
  return i < 0 ? null : heights(p.ladder, h1)[i]!;
}

/**
 * Pure: the 2x rung — what a SERVER-rendered emote <img> carries, and what the
 * client's first (hydration) render carries too, so the two agree (renderText's
 * EmoteImg). The server cannot know the display; after hydration EmoteImg KEEPS
 * this URL whenever it already covers the display (rightSizeEmoteUrl's `keep`), so a
 * DPR1 screen does not re-fetch a smaller copy of what the HTML already loaded.
 */
export function baselineEmoteUrl(url: string): string {
  if (!url) return url;
  const p = providerFor(url);
  if (!p || !p.token.test(url)) return url;
  return p.swap(url, p.ladder.tokens[1]!);
}

/**
 * Pure: step a recognized emote URL DOWN one rung, for load-error recovery. Returns
 * null when already at the lowest rung or the provider/URL isn't recognized — the
 * caller then shows the emote's name as text (Chatterino's "render the code" fallback).
 */
export function stepDownEmoteUrl(url: string): string | null {
  if (!url) return null;
  const p = providerFor(url);
  if (!p) return null;
  const m = p.token.exec(url);
  if (!m) return null;
  const idx = p.ladder.tokens.indexOf(m[1]!);
  if (idx <= 0) return null; // unknown token or already the lowest rung
  return p.swap(url, p.ladder.tokens[idx - 1]!);
}

/** Force a recognized emote URL to one end of its ladder; unrecognized URLs pass through.
 *  BTTV keeps its fixed URL here: a sent Matrix message and a sticker keep the URL they
 *  always carried. */
function forceTier(url: string, end: "min" | "max"): string {
  if (!url) return url;
  const p = providerFor(url);
  if (!p || p.ladder === BTTV || !p.token.test(url)) return url;
  const t = end === "min" ? p.ladder.tokens[0]! : p.ladder.tokens[p.ladder.tokens.length - 1]!;
  return p.swap(url, t);
}

/**
 * Smallest rung — for picker/reaction thumbnails and the emotes embedded in a SENT
 * Matrix message (rendered ~24-40px, and the bridge/other clients want the light
 * variant). One rule for every provider, FFZ included.
 */
export function lowerResEmoteUrl(url: string): string {
  return forceTier(url, "min");
}

/**
 * Largest rung — stickers render big (up to ~4.2em × boost, and full-size on the OBS
 * overlay), so unlike inline chat emotes they want the highest-res source. 7TV serves
 * that as WebP at a fraction of the equivalent GIF's weight (stvBestUrl already picks
 * webp), and this only bumps the size token, keeping the extension.
 */
export function stickerResEmoteUrl(url: string): string {
  return forceTier(url, "max");
}

/**
 * Still frame of a Twitch emote URL that arrived WITH a message (stream-ingest
 * builds `…/v2/<id>/default/dark/3.0` from the IRC emote tag, for any channel's
 * emote). Twitch serves a `static` format for every emote id, so "animated
 * emotes off" can pause these too (emotes from other channels would otherwise
 * keep moving). Anything that isn't a Twitch v2 URL has no known still.
 */
export function twitchStillUrl(url: string): string | undefined {
  const m = /^(https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/[^/]+\/)(?:default|animated)(\/.*)$/.exec(url);
  return m ? `${m[1]}static${m[2]}` : undefined;
}

// Rendered emote height, resolved EXACTLY from the live settings the app already
// drives the emote with: height = emoteSize(em) × chatFont(px). The `em` on the
// <img> resolves against `--chat-font-size` (see ChatMessage chat-msg-body), and
// emoteSize comes from the RENDERED `--chat-emote-size` custom property — the same
// value renderText actually sizes the <img> with. Computing from the real values,
// not a fudge factor, is what guarantees we never under-estimate and therefore
// never blur. Cached briefly since renders arrive in bursts and getComputedStyle
// forces a style read.
//
// Read the CSS VAR, never localStorage directly. On the /chat OBS
// overlay every settings key is scoped to an `ov:` prefix so the overlay's look is
// independent of the site's. A bare `localStorage.getItem("chatStyle_emoteSize")`
// would pick up the SITE value while the element renders from the scoped one — site
// at 1.4x with the overlay at 3.0x would mean sizing for 1.4x, requesting a CDN tier
// around half the pixels needed, so every emote on stream would be upscaled and blurry,
// and the warmer would prefetch the wrong bytes too.
//
// The var is the better source than a scope-aware settings read would be: it is
// what the browser is actually rendering, so it cannot disagree with the element
// no matter how the scope rule changes. It also keeps this module dependency-free.
// Both writers already honour the scope — settingsRegistry's effect and the
// layout prepaint (which mirrors it) — and globals.css carries the 1.4em default,
// so there is always a value to read.
let cachedHeight = 0;
let cachedAt = 0;

function renderedEmoteHeightPx(): number {
  const now = Date.now();
  if (cachedHeight > 0 && now - cachedAt < 1000) return cachedHeight;
  try {
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const fontRem = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chat-font-size")) || 0.875;
    const emoteEm = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chat-emote-size")) || 1.4;
    cachedHeight = emoteEm * fontRem * rootPx;
  } catch {
    cachedHeight = 1.4 * 0.875 * 16; // ~19.6px — the default config
  }
  cachedAt = now;
  return cachedHeight;
}

const dpr = () => (typeof window !== "undefined" && window.devicePixelRatio) || 1;

/** Drawn device px of a chat emote on THIS display. */
function chatTargetPx(): number {
  return Math.ceil(renderedEmoteHeightPx() * dpr());
}

/**
 * Size an emote URL to THIS display (DOM wrapper around the pure sizeEmoteUrl).
 * `keep`: a URL this element already requested (the server's 2x baseline) — kept when
 * its rung already covers the display, so hydration never re-fetches a smaller copy.
 */
export function rightSizeEmoteUrl(url: string, h1?: number, keep?: string): string {
  // SSR / no DOM → keep the manifest URL. Chat is client-only after hydration.
  if (typeof window === "undefined" || !url) return url;
  const target = chatTargetPx();
  if (keep) {
    const kh = rungHeight(keep, h1);
    if (kh !== null && kh >= target) return keep;
  }
  return sizeEmoteUrl(url, target, h1);
}

/** Picker tiles draw 32 CSS px. They take the chat's rung whenever that one is at least
 *  as big — at the default settings it is the SAME file (30.3 vs 32 px land on the same
 *  rung at DPR 1, 2 and 3), so a warmed chat emote is a warmed picker tile. */
export function pickerEmoteUrl(url: string, h1?: number): string {
  if (typeof window === "undefined" || !url) return url;
  return sizeEmoteUrl(url, Math.max(Math.ceil(32 * dpr()), chatTargetPx()), h1);
}

// ── sizing key: re-size rendered emotes when the drawn device pixels change ──────
// With no 2x floor, a browser zoom (DPR change) or a bigger emote/font setting would
// otherwise leave rows sized for the old value. Subscribers (EmoteImg) re-render and
// pick the new rung; Chrome keeps the old pixels painted until the new src decodes.
let sizingVersion = 0;
const sizingListeners = new Set<() => void>();
let dprWatch: MediaQueryList | null = null;

function watchDpr(): void {
  if (typeof window === "undefined" || !window.matchMedia) return;
  dprWatch?.removeEventListener("change", onDprChange);
  dprWatch = window.matchMedia(`(resolution: ${dpr()}dppx)`);
  dprWatch.addEventListener("change", onDprChange);
}
function onDprChange(): void {
  watchDpr();
  emoteSizingChanged();
}

/** Called by the settings effects that move the drawn emote height (font, emote size). */
export function emoteSizingChanged(): void {
  cachedHeight = 0;
  sizingVersion++;
  for (const l of Array.from(sizingListeners)) l();
}

export function subscribeEmoteSizing(cb: () => void): () => void {
  if (!dprWatch) watchDpr();
  sizingListeners.add(cb);
  return () => { sizingListeners.delete(cb); };
}

export function emoteSizingVersion(): number {
  return sizingVersion;
}

/** A string that changes whenever chat emotes would pick different rungs (the warmer's record key). */
export function emoteSizingKey(): string {
  return `${dpr()}@${chatTargetPx()}`;
}

/**
 * Still frame of a STICKER's stored URL, so stickers pause too.
 * The spend route stores only the animated URL, so the still is derived from
 * it per provider: Twitch's `static` format, 7TV's `<n>x_static.webp` sibling,
 * BTTV's `/static/` rung. Other hosts (FFZ, unknown) have no known still and
 * keep animating. A still that 404s falls back to the animated URL at the
 * <img>'s onError.
 */
export function stickerStillUrl(url: string): string | undefined {
  if (!url) return undefined;
  const tw = twitchStillUrl(url);
  if (tw) return tw;
  const stv = /^(https:\/\/cdn\.7tv\.app\/emote\/[^/]+\/)(\dx)\.(?:webp|gif|avif|png)$/.exec(url);
  if (stv) return `${stv[1]}${stv[2]}_static.webp`;
  const bttv = /^(https:\/\/cdn\.betterttv\.net\/emote\/[^/]+\/)(\dx)(?:\.\w+)?$/.exec(url);
  if (bttv) return `${bttv[1]}static/${bttv[2]}.webp`;
  return undefined;
}
