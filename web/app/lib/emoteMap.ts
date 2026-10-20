// The emote manifest shape.
//
// Lives in its own core module rather than inside the useEmotes hook because
// emoteWarmer and recentEmotes both need the type, and importing it from the
// hook made the module graph cyclic:
//   useEmotes -> emoteWarmer -> useEmotes
//   useEmotes -> emoteWarmer -> recentEmotes -> useEmotes
// Those cycles were type-only (they erase at build, so nothing was broken at
// runtime) but they are real declaration coupling, and a graph with cycles
// cannot be checked for direction. Splitting the type out removes them for real
// instead of exempting them. useEmotes re-exports both names, so every existing
// `import type { EmoteMap } from "./useEmotes"` still works.

// `ar` = intrinsic aspect ratio (width/height), set by /api/emotes when the CDN
// exposes real dimensions (7TV/FFZ) or the format is square (Twitch). The chat
// renderer applies it as `aspect-ratio` so the emote's width is reserved before
// the image loads — no row shift / CLS. Absent for BTTV and older cached maps.
// `ch` = PERSONAL-SET ONLY (userEmotesCore.buildPersonalMap): the login of the
// Twitch channel owning the emote, `null` for Twitch globals, `""` when the
// owner lookup failed ("Other channels"). The site catalog never sets it; the
// picker groups the personal set by it.
// `still` = a static (first-frame) URL for an animated emote, used when the
// viewer turns animated emotes off. Absent = the emote is static already, or
// its CDN has no static variant.
// `h` = the emote's real 1x height in px: the size ladder is per EMOTE —
// a wide 7TV emote's 1x is ~20 px, not 32 — see emoteRes.ts. Absent = the
// provider's nominal (BTTV squares that are not 28 px, per-message emotes).
// `r` = 30-day usage rank (1 = most used) from /api/emotes; the warmer warms
// by it. Absent = not used in that window.
export type EmoteInfo = { url: string; zeroWidth: boolean; ar?: number; ch?: string | null; still?: string; h?: number; r?: number };
export type EmoteMap = Record<string, EmoteInfo>;
