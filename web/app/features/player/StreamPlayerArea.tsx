"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePlayerFallbacks } from "@/app/lib/plugins/player";
import StreamplaceThinPlayer from "./StreamplaceThinPlayer";
import { TwitchPlayer } from "./TwitchPlayer";
import { usePlayerAdapter } from "./usePlayerAdapter";
import { PlayerFailurePanel } from "./PlayerFailurePanel";
import { createYouTubeAdapter } from "./adapters/youtube";
import { createScriptLoader, browserScriptEnv } from "@/app/lib/playerScripts";
import type { AdapterSource } from "@/app/lib/playerAdapter";
import { communitySrc, type Platform, type CommunityStatus, type CommunitySource, type LoopVideo } from "@/app/lib/streamView";
import { loopPlaylistSrc } from "@/app/lib/loopPlaylist";
import { YT_EMBED_PARAMS, type PlayerState } from "@/app/lib/playerSource";
import { type Vod } from "@/app/lib/vods";
import { usePlayerSeen } from "@/app/lib/usePlayerSeen";
import { setPlayerSeen, setPlayerSrc } from "@/app/lib/playerHealth";
import { usePlayerDebug } from "./usePlayerDebug";

type StreamPlayerAreaProps = {
  tab: PlayerState["tab"];
  live: boolean;
  active: Platform;
  spSrc: string;
  ytSrc: string | null;
  twSrc: string;
  /** The live tab's Twitch channel — TwitchPlayer needs it apart from twSrc
   *  because the adapter path builds its own player rather than an iframe src. */
  twitchChannel: string;
  /** The device's "start stream muted" setting, same value twSrc already bakes
   *  into its `muted=true` query param. */
  twStartMuted: boolean;
  community: CommunityStatus | null;
  communitySource: CommunitySource | null;
  /** Fallback playlist, looped in the community slot when nobody is live. */
  loopVideos: LoopVideo[];
  embedHost: string;
  selectedVod: Vod | null;
  /** The device's "start stream muted" setting. A VOD pick is a click, so the
   *  replay only starts muted when the viewer asked for that. */
  vodStartMuted: boolean;
  // In-house WebRTC player for the stream.place (`sp`) slot — opt-in through
  // the source row's "site player" icon; the stream.place/embed iframe is
  // the default. See StreamplaceThinPlayer.
  spThinPlayer: boolean;
  spStartMuted: boolean;
  spChannel: string;
  /** The thin player's way back to the embed (its "Embed" button and the
   *  failed panel's option). */
  onToggleSpPlayer: () => void;
  isSignedIn: boolean;
  /** A registered fallback's own collapse (persisted per fallback by StreamView). */
  fallbackCollapsed: boolean;
  onToggleFallbackCollapsed: () => void;
  /** Twitch's own liveness, straight from whichever TwitchPlayer is mounted —
   *  for the rail's tone only (StreamView scopes it to the Live icon). The
   *  SAME setter is wired to both TwitchPlayer mounts below; each reports its
   *  own `scope` alongside the value so StreamView can tell them apart. Must
   *  be referentially stable (StreamView's wrapped setter): TwitchPlayer's own
   *  reporting effect keys on this identity, and a fresh arrow every render
   *  would loop it. */
  onPlayerLive: (live: boolean | null, scope: "live" | "community") => void;
  /** False = this install has no live source set up: the Live tab says so instead of
   *  mounting an embed with an empty channel. Default true. */
  livePlayable?: boolean;
  /** The Kick channel, "" when unset. There is no Kick player yet: with no other source, a live
   *  stream links to Kick instead. */
  kickChannel?: string;
};

// What every cross-origin player iframe carries. YouTube's own oEmbed markup,
// Twitch's and stream.place's embed docs agree on the shape:
//  - `allow`: autoplay is delegated from the page's activation; fullscreen and
//    picture-in-picture are the player's own controls; encrypted-media is
//    YouTube's for DRM'd inventory.
//  - `referrerPolicy`: YouTube refuses a missing Referer (error 153, since late
//    2025). Stating it on the frame stops the embed depending on the site-wide
//    header.
//  - `title`: the frame's accessible name — a screen reader otherwise reads the
//    URL.
const IFRAME_ALLOW = "autoplay; fullscreen; picture-in-picture; encrypted-media";
const IFRAME_REFERRER = "strict-origin-when-cross-origin";
const IFRAME_CLASS = "absolute inset-0 w-full h-full border-0";
// Local rather than platforms.ts's platformLabel(): keyed on CommunitySource["platform"], so tsc refuses a platform this map does not name.
const COMMUNITY_PLATFORM_LABEL: Record<CommunitySource["platform"], string> = {
  youtube: "YouTube",
  twitch: "Twitch",
};

// One loader for the whole app, not one per mount: StreamPlayerArea unmounts
// whenever the frame is folded (see the `!folded` guard at its call site), and
// a fresh loader per remount would re-append a <script> tag it already fetched
// last time. Constructed lazily — never at module load — because
// browserScriptEnv() reads `window`/`document`, and this module is first
// imported during this "use client" component's SERVER render.
let scriptLoader: ReturnType<typeof createScriptLoader> | null = null;
function playerScriptLoader() {
  if (!scriptLoader) scriptLoader = createScriptLoader(browserScriptEnv());
  return scriptLoader;
}

// Attaches the IFrame Player API to an existing YouTube embed. Unlike Twitch,
// YouTube's API never builds its own frame, so every call site keeps the exact
// <iframe> it already had — this only adds the ref + the adapter hook, once,
// instead of repeating that pair at all four YouTube embeds in this file.
//
// UNLIKE TwitchPlayer, THIS UPGRADES WHEN THE SCRIPT ARRIVES LATE. Twitch's
// API BUILDS its own iframe, so swapping it in after the fact would black a
// playing video — its choice is frozen at mount (see TwitchPlayer.tsx).
// YouTube's API only ATTACHES to the iframe that is already there, so an
// upgrade costs the viewer nothing: a viewer who lands on a cold page while
// the stream is already live (isLive is server-rendered, so this mounts on
// the hydration commit, before iframe_api can possibly have loaded) still
// ends up with a working adapter once the script resolves, instead of never
// getting one for the rest of the session.
function YouTubeFrame({ src, title, className, allow, referrerPolicy, playerKey, ready }: {
  src: string;
  title: string;
  className: string;
  allow: string;
  referrerPolicy: "strict-origin-when-cross-origin";
  /** Re-create the adapter when this changes — a new video id, a new channel. */
  playerKey: string;
  ready: (source: "youtube") => boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  // A mount-time snapshot, upgraded once — never downgraded — when the
  // script resolves. Seeded from the synchronous ready() so a warm page (the
  // common case) never waits on the effect below at all.
  const [scriptReady, setScriptReady] = useState(() => ready("youtube"));

  useEffect(() => {
    if (scriptReady) return;
    let cancelled = false;
    // load() is idempotent — this never appends a second <script> even if
    // StreamPlayerArea's own preload effect already started the fetch.
    void playerScriptLoader().load("youtube").then((ok) => {
      // A promise continuation, not a synchronous set-state-in-effect: this
      // runs on a later microtask, after the effect body has already
      // returned — react-hooks/set-state-in-effect does not fire on it.
      if (ok && !cancelled) setScriptReady(true);
    });
    return () => { cancelled = true; };
  }, [scriptReady]);

  const create = useCallback(() => {
    if (!scriptReady) return null;
    const api = (window as unknown as { YT?: never }).YT;
    if (!api || !ref.current) return null;
    // YT.Player's constructor is the one call here we do not control; contain
    // a construction-time throw to "no adapter" rather than this render.
    try {
      return createYouTubeAdapter({ YT: api, element: ref.current });
    } catch {
      return null;
    }
    // playerKey is not read in this body — React already remounts this whole
    // component on a new key (every call site keys its <YouTubeFrame> by the
    // same value it passes as playerKey), and usePlayerAdapter's own effect
    // re-runs on `key` regardless of whether `create`'s identity changed.
  }, [scriptReady]);

  // YouTube is the only source with error DETAIL (CAPABILITIES.youtube.errorDetail
  // is true, Twitch's is false — playerAdapter.ts's capability table), so it is
  // the one that most needs the panel: codes 100/101/150 (removed / embedding
  // disallowed) and 153 (referer refused) are exactly the failures that would
  // otherwise render an identical black rectangle a viewer cannot act on.
  const { blocked, failure, dismissFailure, play } = usePlayerAdapter({
    source: "youtube", key: playerKey, create,
  });

  return (
    <>
      <iframe
        ref={ref}
        src={src}
        title={title}
        className={className}
        allow={allow}
        referrerPolicy={referrerPolicy}
        allowFullScreen
      />
      <PlayerFailurePanel blocked={blocked} failure={failure} onPlay={play} onDismiss={dismissFailure} />
    </>
  );
}

/** The telemetry name of what this area is showing — mirrors the mount conditions below. */
function playerSrcFor(isFallback: boolean, tab: StreamPlayerAreaProps["tab"], live: boolean, active: Platform, spThin: boolean,
  hasVod: boolean, hasCommunity: boolean, hasLoop: boolean): string {
  if (isFallback) return tab;
  if (tab === "replay") return hasVod ? "replay" : "none";
  if (tab === "community") return hasCommunity || hasLoop ? "community" : "none";
  if (!live) return "none";
  if (active === "sp") return spThin ? "native" : "streamplace";
  if (active === "yt") return "youtube";
  if (active === "tw") return "twitch";
  return "none";
}

// Player — sized by .player-attached / .player-fill (see globals.css). It is
// NEVER squished out of 16:9 — so short/wide viewports (mobile landscape,
// ultrawide) get clean page-coloured space instead of harsh black letterbox
// bars, and the video is never cropped. On mobile it's a natural full-width
// 16:9 block and the page scrolls.
export function StreamPlayerArea({
  tab, live, active, spSrc, ytSrc, twSrc, twitchChannel, twStartMuted, community, communitySource,
  loopVideos, embedHost, selectedVod, vodStartMuted, spThinPlayer, spStartMuted, spChannel,
  onToggleSpPlayer, isSignedIn, fallbackCollapsed, onToggleFallbackCollapsed, onPlayerLive,
  livePlayable = true, kickChannel = "",
}: StreamPlayerAreaProps) {
  const { ids: fallbackIds, fallbackFor } = usePlayerFallbacks();
  const fallback = fallbackFor(tab);
  const loopSrc = loopPlaylistSrc(loopVideos);

  // Stable across renders (the singleton never changes), so it is safe inside
  // any child's own useCallback dependency array.
  const ready = useCallback(
    (source: AdapterSource) => playerScriptLoader().ready(source),
    [],
  );

  // Prefetch both platform scripts as soon as the player area is on screen —
  // NOT gated on `tab`. A viewer who lands on Community or opens a VOD
  // without ever visiting Live would otherwise fetch neither script, leaving the
  // Community/replay scope inert for them for the whole session. load() is
  // idempotent and never throws — an ad blocker just leaves ready() false
  // forever, and a later switch to Live still gets exactly this same call.
  useEffect(() => {
    const loader = playerScriptLoader();
    void loader.load("youtube");
    void loader.load("twitch");
  }, []);

  // Device-health telemetry: which player is up and whether its box can
  // be seen. MEASUREMENT ONLY — nothing pauses or changes a player because of it.
  const boxRef = useRef<HTMLDivElement>(null);
  const seen = usePlayerSeen(boxRef);
  const src = playerSrcFor(!!fallback, tab, live && livePlayable, active, spThinPlayer, !!selectedVod, !!community, !!loopSrc);
  // Live with no source this site can play: never an embed with an empty channel.
  const playLive = live && livePlayable;
  useEffect(() => { setPlayerSeen(seen); }, [seen]);
  // The per-device debug log (?playerdebug=1) — inert unless switched on.
  usePlayerDebug(boxRef, src);
  useEffect(() => {
    setPlayerSrc(src);
    return () => setPlayerSrc("none");
  }, [src]);

  return (
    <div className="player-area">
      <div ref={boxRef} className="player-box bg-black">
        <div className="absolute inset-0">
          {/* VOD replay lives under the "replay" tab; BROWSING happens outside
              the player since cycle 6b (desktop: bottom dock; mobile: the chat
              panel's armed VODs tab) — so browsing never unmounts the replay
              iframe. Picking a VOD sets tab → "replay" and mounts it fresh
              (keyed by VOD id, so a different pick remounts from 0). */}
          {/* Player content is driven by `tab` (the always-visible toggle), so a fallback can
              take over even while live, and the live stream lives behind the "Live" tab. */}

          {/* A registered fallback (the install's plugin — app/lib/plugins/player.ts);
              available regardless of live state. */}
          {fallback && <fallback.Player active isSignedIn={isSignedIn} collapsed={fallbackCollapsed} onToggleCollapsed={onToggleFallbackCollapsed} />}

          {/* The offline card: the end of the chain when this install registers no fallback
              (live → featured → registered fallbacks → offline). */}
          {tab === "live" && !live && fallbackIds.length === 0 && (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted">Offline</div>
          )}

          {/* Replay — the picked VOD. A pick is a click, and `allow="autoplay"`
              delegates that activation to the frame, so unmuted autoplay is allowed
              wherever the browser honours delegated activation (where it does not,
              YouTube shows a paused player — nothing worse); only the device's own
              "start muted" setting mutes it. */}
          {tab === "replay" && selectedVod && (
            <YouTubeFrame
              key={`vod-${selectedVod.id}`}
              src={`https://www.youtube.com/embed/${selectedVod.id}?${YT_EMBED_PARAMS}${vodStartMuted ? "&mute=1" : ""}`}
              title={`Replay: ${selectedVod.title}`}
              className={IFRAME_CLASS}
              allow={IFRAME_ALLOW}
              referrerPolicy={IFRAME_REFERRER}
              playerKey={selectedVod.id}
              ready={ready}
            />
          )}

          {/* Live tab — the streamer's stream on the chosen platform. */}
          {tab === "live" && live && !livePlayable && (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted">
              {kickChannel ? (
                <>
                  <p>Live on Kick — this site has no Kick player yet.</p>
                  <a
                    href={`https://kick.com/${encodeURIComponent(kickChannel)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md bg-surface-2 px-3 py-1.5 text-body hover:bg-surface-3"
                  >
                    Watch on Kick
                  </a>
                </>
              ) : (
                <p>Live — but no player is set up on this site yet.</p>
              )}
            </div>
          )}
          {tab === "live" && playLive && active === "sp" && (
            spThinPlayer ? (
              <StreamplaceThinPlayer startMuted={spStartMuted} channel={spChannel} onFallback={onToggleSpPlayer} />
            ) : (
              <iframe
                src={spSrc}
                title="Live stream — Streamplace"
                className={IFRAME_CLASS}
                allow={IFRAME_ALLOW}
                referrerPolicy={IFRAME_REFERRER}
                allowFullScreen
              />
            )
          )}
          {tab === "live" && playLive && active === "yt" && ytSrc && (
            <YouTubeFrame
              key={ytSrc}
              src={ytSrc}
              title="Live stream — YouTube"
              className={IFRAME_CLASS}
              allow={IFRAME_ALLOW}
              referrerPolicy={IFRAME_REFERRER}
              playerKey={ytSrc}
              ready={ready}
            />
          )}
          {tab === "live" && playLive && active === "tw" && (
            <TwitchPlayer
              // Load-bearing, not decoration: adapters/twitch.ts has no destroy()
              // ("the caller empties the container"), so if this instance stayed
              // mounted across a channel change, create() would construct a SECOND
              // Twitch.Player into the same <div> — two players stacked in one
              // container. Keying by channel forces a fresh <div> (a fresh useId())
              // instead. This key covers a CHANNEL change only — a `parent` or
              // `muted` change recreates the adapter without a remount, and
              // TwitchPlayer's own teardown effect is what empties the container
              // for those (its `create`-keyed useEffect cleanup).
              key={twitchChannel}
              twSrc={twSrc}
              channel={twitchChannel}
              parent={embedHost}
              muted={twStartMuted}
              ready={ready}
              className={IFRAME_CLASS}
              allow={IFRAME_ALLOW}
              referrerPolicy={IFRAME_REFERRER}
              scope="live"
              onPlayerLive={onPlayerLive}
            />
          )}
          {/* Community is its own source, not the offline fallback of the Live
              tab. The status endpoint drops the featured streamer on the streamer's
              takeover (no community toggles while they are
              live), so this slot empties when he goes live and the viewer is
              moved by the source fallback in StreamView. */}
          {/* Nobody live, but the fallback playlist has videos — loop them in the
              community slot. A LIVE featured streamer always wins (the !community
              guard), so this only fills the state that previously showed nothing.
              URL rules live in loopPlaylistSrc — they are not obvious. */}
          {tab === "community" && !community && loopSrc && (
            <YouTubeFrame
              // Re-mount when the playlist itself changes (a mod edits it), not on
              // every status poll — the ids are the identity.
              key={loopSrc}
              src={loopSrc}
              title="Community playlist"
              className={IFRAME_CLASS}
              allow={IFRAME_ALLOW}
              referrerPolicy={IFRAME_REFERRER}
              playerKey={loopSrc}
              ready={ready}
            />
          )}
          {tab === "community" && community && communitySource && (
            // One mount point, branching on platform — not two separate `&&`
            // blocks — so the community slot stays a single call site the way
            // it always was; only one of the two ever renders at once anyway.
            communitySource.platform === "youtube" ? (
              <YouTubeFrame
                // Re-mount when the chosen source changes so the player reloads.
                // The YouTube source's `id` is already the live video id when the
                // scrape found one (streamStatus.ts), so communitySource.id alone is right.
                key={communitySource.id}
                src={communitySrc(communitySource, embedHost)}
                title={`${community.display_name} — ${COMMUNITY_PLATFORM_LABEL.youtube}`}
                className={IFRAME_CLASS}
                allow={IFRAME_ALLOW}
                referrerPolicy={IFRAME_REFERRER}
                playerKey={communitySource.id}
                ready={ready}
              />
            ) : (
              <TwitchPlayer
                key={communitySource.id}
                // communitySrc's Twitch branch always mutes (autoplay=true&muted=true) —
                // the same `muted` value the plain iframe path already carried.
                twSrc={communitySrc(communitySource, embedHost)}
                channel={communitySource.id}
                parent={embedHost}
                muted={true}
                ready={ready}
                className={IFRAME_CLASS}
                allow={IFRAME_ALLOW}
                referrerPolicy={IFRAME_REFERRER}
                scope="community"
                onPlayerLive={onPlayerLive}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}
