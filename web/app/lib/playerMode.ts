// The rail's model: which of the three modes is on, what colour each icon
// reads, what the expanded item says. Pure — StreamView derives everything
// from `tab`, the poll status and the persisted live source, and
// StreamEmbedBar renders it.
//
// "none" is the FOLDED state: nothing selected, no player mounted.
// It is the only value of PLAYER_MODE_KEY that changes what mounts. The other
// values are written by exactly three things — unfolding with the fold button,
// a rail pick made WHILE folded, and the going-live unfold — so a mode change
// on an unfolded player records nothing. Read the key as a fold FLAG that
// happens to carry the mode it was last written with, not as a remembered
// mode: the current tab is session state, and the going-live edge, not this
// key, decides where a fresh visit lands.
import { SOURCE_META, type FallbackId, type LiveSource, type PlayerState } from "./playerSource.ts";

/** The two modes every install has. After them come the REGISTERED FALLBACKS — player modes an
 *  install's plugin adds (app/lib/plugins/player.ts), each named by its id. With none registered
 *  the rail is Live · Community. */
export type BuiltinRailMode = "live" | "community";
export type RailMode = BuiltinRailMode | FallbackId;
export type PlayerMode = RailMode | "none";
export type RailTone = "off" | "available" | "live";

export const PLAYER_MODE_KEY = "player_mode";
const BUILTIN_RAIL_MODES: readonly BuiltinRailMode[] = ["live", "community"];
export const MODE_LABEL: Record<BuiltinRailMode, string> = { live: "Live", community: "Community" };

/** The rail, in order: the built-in modes, then each registered fallback's id. */
export function railModes(fallbacks: readonly FallbackId[]): RailMode[] {
  return [...BUILTIN_RAIL_MODES, ...fallbacks];
}

export function parsePlayerMode(stored: string | null, fallbacks: readonly FallbackId[] = []): PlayerMode | null {
  return stored === "none" || railModes(fallbacks).includes(stored ?? "")
    ? (stored as PlayerMode)
    : null;
}

/** A VOD replay plays in Live's slot — the rail has no replay item. A fallback's tab is its mode. */
export function modeForTab(tab: PlayerState["tab"]): RailMode {
  return tab === "community" ? "community" : tab === "live" || tab === "replay" ? "live" : tab;
}

export type RailStatus = { live: boolean; communityLive: boolean; hasPlaylist: boolean; fallbackUp: boolean };

/** grey = nothing there · white = available · red = live. A fallback is available while up. */
export function railTone(mode: RailMode, s: RailStatus): RailTone {
  switch (mode) {
    case "live":      return s.live ? "live" : "off";
    case "community": return s.communityLive ? "live" : s.hasPlaylist ? "available" : "off";
    default:          return s.fallbackUp ? "available" : "off";
  }
}

/**
 * What the expanded item shows after " · ": the mode's current option, or null.
 *
 * A VOD replay has no rail item of its own (modeForTab puts it under Live), so
 * without `replay` the rail read "Live · Twitch" over a recording — naming a
 * source that is not what is playing. On a replay the detail is the word
 * "Replay"; the VOD's own title is the bottom bar's job, so this does not
 * repeat it.
 */
export function modeDetail(
  mode: RailMode,
  d: { liveSource: LiveSource; communityName: string | null; hasPlaylist: boolean; replay: boolean },
): string | null {
  switch (mode) {
    case "live":      return d.replay ? "Replay" : SOURCE_META[d.liveSource].label;
    // Never the channel's name: the featured streamer is named on the bottom
    // bar, so the rail reads "Community" alone while someone is live.
    // "Playlist" survives — it says what is playing when nobody is, and it is
    // not a name.
    case "community": return d.communityName ? null : (d.hasPlaylist ? "Playlist" : null);
    default:          return null;
  }
}

const LIVE_ORDER: readonly LiveSource[] = ["native", "streamplace", "youtube", "twitch"];

/**
 * Which modes carry a second level. Live always does (its four sources).
 * Community does only when the featured streamer is on more than one platform
 * — one platform is not a choice, and an empty caret is a lie. This menu is
 * the platform switcher; it does not list live CHANNELS.
 */
export function modeHasMenu(mode: RailMode, s: { communityPlatforms: number; liveSources?: number }): boolean {
  // Live has its sources — unless the Stream tab's embed switches left only one.
  if (mode === "live") return (s.liveSources ?? LIVE_ORDER.length) > 1;
  if (mode === "community") return s.communityPlatforms > 1;
  return false;
}

/** A row in a mode's dropdown. `key` is the mode's own option vocabulary — a
 *  LiveSource for Live, a platform name for Community — so it is a string here
 *  and each consumer narrows it. */
export type ModeOption = { key: string; label: string; platform: string | null; checked: boolean };

/** The Live dropdown: the sources that are on (all four unless the Stream tab switched some off),
 *  plain names, the current one checked. */
export function liveOptions(current: LiveSource, on: readonly LiveSource[] = LIVE_ORDER): ModeOption[] {
  return LIVE_ORDER.filter((key) => on.includes(key)).map((key) => ({
    key, label: SOURCE_META[key].label, platform: SOURCE_META[key].platform, checked: key === current,
  }));
}

// The platforms a featured streamer can be watched on. Not SOURCE_META: that is
// keyed on OUR six sources, and a featured streamer's platform is whatever the
// community embed row says (`site.community_embeds`), which can name one we do
// not carry ourselves. Unknown platforms fall through to their raw name rather
// than being dropped — a row a viewer cannot pick is worse than an unstyled one.
const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube",
  twitch: "Twitch",
  streamplace: "stream.place",
  kick: "Kick",
};

/**
 * The Community dropdown: one row per platform the featured streamer streams
 * on. `selected` is the viewer's pick; with none, the first source is what the
 * player shows (StreamView's `communitySources.find(...) ?? communitySources[0]`),
 * so that is the row that must read as checked.
 */
export function communityOptions(
  sources: readonly { platform: string }[],
  selected: string | null,
): ModeOption[] {
  const current = selected ?? sources[0]?.platform ?? null;
  return sources.map((s) => ({
    key: s.platform,
    label: PLATFORM_LABEL[s.platform] ?? s.platform,
    platform: s.platform,
    checked: s.platform === current,
  }));
}
