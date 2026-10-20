import { siteName } from "./siteName.ts";
import { normalizePlatform } from "./nativePlatform.ts";
/**
 * What is playing in the player slot — ONE selection, not two.
 *
 * "Which platform am I watching" and "am I watching the stream at all" are one
 * question: every thing you can watch is one icon in one row. VODs stays a
 * separate labelled button because it is a browse list rather than a source,
 * and that button is MOBILE ONLY — desktop browses VODs in the bottom dock
 * instead; see StreamEmbedBar.
 *
 * The legacy state (tab + active + spThinPlayer) is what the player area still
 * consumes, but it is DERIVED: the live source is persisted as ONE localStorage
 * value (`player_live_source`, see LIVE_SOURCE_KEY) with one writer, StreamView's
 * setSource. The two keys it replaced (`embed_source` = sp|yt|tw and
 * `chatStyle_spThinPlayer` = "1"|"0") are read ONLY as the fallback when the new
 * key is absent, so nobody's remembered platform or in-house opt-in resets;
 * nothing writes them (playerEmbeds.test.ts pins that).
 */

/**
 * A registered fallback player mode's id — what plays when nothing is live and no featured
 * streamer is on (an install's plugin registers it, app/lib/plugins/player.ts). Its id is also
 * its tab and its rail mode. `string & {}` keeps the built-in names' autocomplete.
 */
export type FallbackId = string & {};

export type PlayerSource =
  | "native"       // the site's own WHEP player (StreamplaceThinPlayer)
  | "streamplace"  // the stream.place embed
  | "youtube"
  | "twitch"
  | "community"    // the featured streamer
  | FallbackId;    // a registered fallback

/** The four things the live row can persist — the tab is session state. */
export type LiveSource = Extract<PlayerSource, "native" | "streamplace" | "youtube" | "twitch">;

/** The one persisted key. Absent → the legacy pair is consulted (liveSourceFromLegacy). */
export const LIVE_SOURCE_KEY = "player_live_source";

const LIVE_SOURCES: readonly LiveSource[] = ["native", "streamplace", "youtube", "twitch"];

/** Validate a stored value; null means "absent or junk". */
export function parseLiveSource(stored: string | null): LiveSource | null {
  // A value saved before the platform-key rename names the site's player by the old id.
  const v = String(normalizePlatform(stored ?? ""));
  return (LIVE_SOURCES as readonly string[]).includes(v) ? (v as LiveSource) : null;
}

/**
 * The pre-slice-6 pair, read once when the new key is absent. `embed_source`
 * was sp|yt|tw (anything else meant sp) and `chatStyle_spThinPlayer` was "1"
 * for the in-house opt-in — which only ever applied on sp.
 */
export function liveSourceFromLegacy(embedSource: string | null, spThinPlayer: string | null): LiveSource {
  if (embedSource === "yt") return "youtube";
  if (embedSource === "tw") return "twitch";
  return spThinPlayer === "1" ? "native" : "streamplace";
}

/** What the player area consumes, from the one stored value. */
export function legacyForLiveSource(source: LiveSource): Pick<PlayerState, "active" | "spThinPlayer"> {
  switch (source) {
    case "native":      return { active: "sp", spThinPlayer: true };
    case "streamplace": return { active: "sp", spThinPlayer: false };
    case "youtube":     return { active: "yt", spThinPlayer: false };
    case "twitch":      return { active: "tw", spThinPlayer: false };
  }
}

/** The inverse: which stored value a legacy state amounts to (the tab is ignored). */
export function liveSourceFromState(s: Pick<PlayerState, "active" | "spThinPlayer">): LiveSource {
  if (s.active === "yt") return "youtube";
  if (s.active === "tw") return "twitch";
  return s.spThinPlayer ? "native" : "streamplace";
}

/** Legacy player state this file maps to and from. */
export type PlayerState = {
  tab: "live" | "community" | "replay" | FallbackId;
  active: "sp" | "yt" | "tw";
  spThinPlayer: boolean;
};

/**
 * Which sources the viewer may pick, in display order.
 *
 * Live:    the site's player · stream.place · YouTube · Twitch · community · fallbacks
 * Offline: community · fallbacks
 *
 * Community only appears when one is actually configured — an icon that plays
 * nothing is worse than no icon. The live row lists it too, but the status
 * endpoint drops the featured streamer on the streamer's takeover (no community
 * toggles while they are live), so in practice the live row has no
 * community icon; the slot exists so the model needs no special case.
 */
export function availableSources(opts: { live: boolean; hasCommunity: boolean; fallbacks: readonly FallbackId[]; liveOn?: readonly LiveSource[] }): PlayerSource[] {
  const community: PlayerSource[] = opts.hasCommunity ? ["community"] : [];
  return opts.live
    ? [...(opts.liveOn ?? LIVE_SOURCES), ...community, ...opts.fallbacks]
    : [...community, ...opts.fallbacks];
}

/**
 * The live sources the watch page offers, in the Live row's order: every one but those the
 * `player.embedsOff` setting switches off (the Stream tab's embed switches). Unknown names are
 * ignored. FAIL OPEN: a setting that switches every source off is ignored — a player with no
 * source is a dark site.
 */
export function liveSourcesOn(embedsOff: readonly string[]): LiveSource[] {
  const on = LIVE_SOURCES.filter((s) => !embedsOff.includes(s));
  return on.length ? on : [...LIVE_SOURCES];
}

/** A remembered live source that is switched off plays the first one still on. Nothing stored is
 *  rewritten: switching it back on returns the viewer to their own choice. */
export function liveSourceOn(source: LiveSource, on: readonly LiveSource[]): LiveSource {
  return on.includes(source) ? source : (on[0] ?? source);
}

const BUILTIN_TABS: readonly string[] = ["live", "community", "replay"];

/** The legacy state a source selection implies. */
export function stateForSource(source: PlayerSource, prev: PlayerState): PlayerState {
  switch (source) {
    case "native":      return { ...prev, tab: "live", active: "sp", spThinPlayer: true };
    case "streamplace": return { ...prev, tab: "live", active: "sp", spThinPlayer: false };
    case "youtube":     return { ...prev, tab: "live", active: "yt" };
    case "twitch":      return { ...prev, tab: "live", active: "tw" };
    case "community":   return { ...prev, tab: "community" };
    default:            return { ...prev, tab: source };   // a registered fallback: its id is its tab
  }
}

/**
 * Which icon should read as selected.
 *
 * Returns null on the VOD tabs — nothing in the source row is playing then, and
 * highlighting a stale icon would claim otherwise.
 */
export function sourceFromState(s: PlayerState): PlayerSource | null {
  if (!BUILTIN_TABS.includes(s.tab)) return s.tab;
  if (s.tab === "community") return "community";
  if (s.tab === "replay") return null;
  if (s.active === "yt") return "youtube";
  if (s.active === "tw") return "twitch";
  return s.spThinPlayer ? "native" : "streamplace";
}

/** Icon + tooltip for a source. `platform` keys into PlatformIcon's PATHS. */
export const SOURCE_META: Record<LiveSource | "community", { label: string; platform: string | null }> = {
  native:      { label: `${siteName()} player`, platform: "native" },
  streamplace: { label: "stream.place",     platform: "streamplace" },
  youtube:     { label: "YouTube",          platform: "youtube" },
  twitch:      { label: "Twitch",           platform: "twitch" },
  community:   { label: "Community",        platform: "community" },
};

/**
 * The source the fallback effect moves the viewer to when the selected one
 * stops being offered (StreamView).
 *
 * Offline: the featured community over dead air, else the first registered fallback, else the
 * viewer's live source (the player shows the offline card).
 * LIVE: where this viewer last watched live — their persisted platform and
 * in-house opt-in, read back from the legacy state — so the move changes
 * nothing they chose (a device still on the legacy pair gets that same answer
 * written forward under LIVE_SOURCE_KEY, and nothing else). A bare
 * "streamplace" answer went through stateForSource, which set
 * `active: "sp"` and `spThinPlayer: false`, silently clearing a viewer's
 * opt-in and remembered platform every time the streamer went live while they
 * watched a community stream. A viewer who never opted in still lands on the
 * embed (the in-house player is never entered FOR anyone); one who did stays
 * on the player they chose.
 */
export function fallbackSource(
  opts: { live: boolean; hasCommunity: boolean; fallbacks: readonly FallbackId[] },
  prev: PlayerState,
): PlayerSource {
  const ownLive = sourceFromState({ ...prev, tab: "live" }) ?? "streamplace";
  if (opts.live) return ownLive;
  return opts.hasCommunity ? "community" : (opts.fallbacks[0] ?? ownLive);
}

/**
 * The parameters every YouTube embed on this site carries.
 *
 * ONE COPY, plus ONE deliberate duplicate: loopPlaylist.ts keeps zero imports
 * (node --test loads it directly) and so restates this literal;
 * playerApiReach.test.ts asserts the two agree.
 *
 *  - rel=0            related videos are restricted to the same channel. It no
 *                     longer removes them; it is still the closest thing to
 *                     "don't advertise other channels in our player".
 *  - iv_load_policy=3 hides annotations.
 *  - enablejsapi=1    lets the IFrame Player API attach (drift correction,
 *                     blocked-autoplay recovery). One token, fails silently.
 *  - playsinline=1    iOS plays inline instead of taking over the screen.
 *
 * No `origin`: it is optional, this builder runs during SSR where
 * window.location.origin does not exist, and a value that differs between the
 * server and client render would remount the frame off-prod for no gain.
 * `modestbranding`, `showinfo`, `autohide` and `theme` are all deprecated
 * no-ops — do not reach for them.
 */
export const YT_EMBED_PARAMS = "autoplay=1&playsinline=1&rel=0&iv_load_policy=3&enablejsapi=1";

/**
 * The YouTube live source URL. By broadcast id when stream-ingest has confirmed
 * one (the id is the streamer's LIVE broadcast, ownership + isLiveNow verified,
 * debounced over three polls, and validated at stream-api's trust boundary),
 * otherwise the undocumented `live_stream?channel=` form, which asks YouTube to
 * resolve "whatever this channel is featuring" and can land on a scheduled
 * placeholder, a 0:00 DVR start or "An error occurred".
 * The id can take a few minutes to arrive (the poller idles at 180 s between
 * sessions, then the page's 30 s revalidate and the 30 s poll), so an early
 * viewer sees ONE reload when the source flips from the channel form to the
 * id — accepted: it lands them on the right broadcast. Null with neither.
 */
export function youtubeLiveSrc(opts: { videoId: string | null; channelId: string; autoMute: boolean }): string | null {
  const tail = `${YT_EMBED_PARAMS}${opts.autoMute ? "&mute=1" : ""}`;
  if (opts.videoId) return `https://www.youtube.com/embed/${opts.videoId}?${tail}`;
  if (opts.channelId) return `https://www.youtube.com/embed/live_stream?channel=${opts.channelId}&${tail}`;
  return null;
}

/**
 * Which tab the live/community edge moves the viewer to.
 *
 * "Primary" = something is on: the streamer live, a featured streamer live, or the
 * fallback playlist configured. Only EDGES move anyone — a viewer who chose
 * Radio mid-stream must not be dragged back on every poll:
 *   - The streamer going live takes over whatever was on, Radio included — and
 *     including a configured playlist, which keeps `primaryOn` true while they
 *     is offline and would otherwise hide this edge entirely.
 *   - Something else coming on (a featured stream, the playlist) with the streamer
 *     offline → the community player, the tab that has content.
 *   - Everything going off → the offline tab: the first registered fallback, else Live (which
 *     then shows the offline card).
 *   - The streamer ending while a community stream or the playlist stays on is NOT
 *     an edge here: his sources leave the row and StreamView's source
 *     fallback moves the viewer.
 * No edge → null: leave the tab alone.
 */
export function edgeTab(
  prev: { live: boolean; primaryOn: boolean },
  next: { live: boolean; primaryOn: boolean },
  offlineTab: PlayerState["tab"],
): PlayerState["tab"] | null {
  if (next.live && !prev.live) return "live";
  if (next.primaryOn && !prev.primaryOn) return "community";
  if (!next.primaryOn && prev.primaryOn) return offlineTab;
  return null;
}
