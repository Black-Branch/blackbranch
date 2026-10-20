"use client";

import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import { authOrigin } from "@/app/lib/authOrigin";
import type { ChatMsg } from "@/app/lib/chatMsg";
import type { EmoteMap } from "@/app/lib/emoteMap";
import { playerPanelClass } from "@/app/lib/playerPanelClass";
import { useRouter } from "next/navigation";
import {
  availableSources, sourceFromState, stateForSource, fallbackSource, youtubeLiveSrc, liveSourcesOn, liveSourceOn,
  LIVE_SOURCE_KEY, parseLiveSource, liveSourceFromLegacy, legacyForLiveSource, liveSourceFromState,
  type PlayerSource, type LiveSource, type PlayerState,
} from "@/app/lib/playerSource";
import {
  PLAYER_MODE_KEY, railModes, parsePlayerMode, modeForTab, railTone, modeDetail,
  type RailMode, type RailTone,
} from "@/app/lib/playerMode";
import { fallbacksSwitchedOn, PlayerFallbacksProvider } from "@/app/lib/plugins/player";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import { useClientValue, useLocalStorageString } from "@/app/lib/useClientState";
import { ChatSidebar } from "@/app/features/chat";
import { ErrorBoundary } from "./ErrorBoundary";
import { Window } from "@/app/components/chrome";
import CommunityEmbedManager from "./CommunityEmbedManager";
import { useKeyboardShortcuts } from "@/app/lib/useKeyboardShortcuts";
import { usePanelResize } from "@/app/lib/usePanelResize";
import { useBillingAvailability } from "@/app/lib/useStripe";
import dynamic from "next/dynamic";
import { type Vod } from "@/app/lib/vods";
import type { HomePayload } from "@/app/lib/homePayload";
import { type CommunitySource } from "@/app/lib/streamView";
import { useKeyboardOpenDetection } from "@/app/lib/useKeyboardOpenDetection";
import { useKeyboardLift } from "@/app/lib/useKeyboardLift";
import { barVisibility, type BarVisibility } from "@/app/lib/barVisibility";
import { useSubscriptionStatus } from "@/app/lib/useSubscriptionStatus";
import { useStreamStatusPoll } from "@/app/lib/useStreamStatusPoll";
import { usePlayerFold } from "@/app/lib/usePlayerFold";
import { useCoinHeartbeat } from "@/app/lib/useCoinHeartbeat";
import { useNarrowViewport, narrowViewportNow } from "@/app/lib/useNarrowViewport";
import { lsGet } from "@/app/lib/safeLocalStorage";
import { writeDockTab } from "@/app/lib/dockState";
import { foldForVisit, OPEN_HOME_EVENT, OPEN_LIVE_EVENT } from "@/app/lib/visitFold";
import { StreamEmbedBar } from "./StreamEmbedBar";
import { StreamPlayerArea } from "@/app/features/player";
import { StreamMetaBar } from "./StreamMetaBar";
import BottomDock from "./BottomDock";
import { CaretLeft } from "@phosphor-icons/react/dist/ssr";
import { setPlayerFolded } from "@/app/lib/playerHealth";

// The panel drop-shadow is not an inline style on the panels: it is
// `.bb-panel { box-shadow: var(--panel-shadow) }` in
// globals.css — inline beats every layer and every media query, so as long as
// it lived here the Shadow setting could not turn it off and phones could not
// opt out of it. Do NOT reintroduce a boxShadow inline style on either panel.
// The border stays inline: it is a real CSS border driven by the
// --frame-color / --frame-width vars (themeable from ChatSettings).

const NO_MODULES_OFF: readonly string[] = [];
const NO_EMBEDS_OFF: readonly string[] = [];

export default function StreamView({
  isLive,
  vods = [],
  homeInitial = null,
  ytChannelId,
  twitchChannel,
  spChannel,
  streamTitle,
  viewerCount,
  initialYtVideoId,
  followerCount,
  donateUrl,
  subscribeUrl,
  streamerAvatar,
  streamerName,
  isSignedIn,
  userId,
  canonicalId,
  isMod,
  isAdmin = false,
  initialMessages,
  initialEmotes,
  offModules = NO_MODULES_OFF,
  embedsOff = NO_EMBEDS_OFF,
}: {
  isLive: boolean;
  vods?: Vod[];
  /** The Home body from the server render, or null when it was not ready in time. */
  homeInitial?: HomePayload | null;
  ytChannelId: string;
  /** The streamer's live YouTube broadcast id from the server render (v115), or null. */
  initialYtVideoId: string | null;
  twitchChannel: string;
  spChannel: string;
  streamTitle: string;
  viewerCount: number | null;
  followerCount: number | null;
  donateUrl: string;
  subscribeUrl: string;
  streamerAvatar: string | null;
  /** The streamer's display name (instance key streamer.displayName); "" when unset. */
  streamerName: string;
  isSignedIn: boolean;
  userId: string | null;
  canonicalId: string | null;
  isMod: boolean;
  /** The owner's account (site.users.is_admin) — see ChatSidebar. */
  isAdmin?: boolean;
  /** The newest page of chat history from the server render — see ChatSidebar. */
  initialMessages?: ChatMsg[];
  /** The emotes those rows use — see ChatSidebar. */
  initialEmotes?: EmoteMap;
  /** The module switches that are off (the home page reads them on the server). A registered
   *  fallback whose module is off is not offered anywhere in the player. */
  offModules?: readonly string[];
  /** The live sources switched off in the Stream tab (instance key player.embedsOff, read on the
   *  server per render). The Live row, its drop-down and the remembered source all go through
   *  liveSourcesOn / liveSourceOn. */
  embedsOff?: readonly string[];
}) {
  // The registered fallbacks whose module is on — this component's own reads, and the context
  // every player part below reads (usePlayerFallbacks).
  const offKey = offModules.join(",");
  const fallbacks = useMemo(() => fallbacksSwitchedOn(offKey ? offKey.split(",") : []), [offKey]);
  const fallbackIds = useMemo(() => fallbacks.map((f) => f.id), [fallbacks]);
  const fallbackFor = (t: string) => fallbacks.find((f) => f.id === t) ?? null;
  // The live source — platform AND the per-device opt-in to the in-house
  // WebRTC player for the stream.place slot (the embed iframe is the default;
  // the row's "site player" icon opts in, the player's "Use the embed"
  // opts back out, both through setSource) — is ONE persisted value
  // (app/lib/playerSource.ts). The two legacy keys are read only as
  // the fallback while the new key is absent, and written by nothing: the
  // first pick through setSource writes the new key forward and the legacy
  // pair is never consulted again on this device. SSR renders the streamplace
  // default (null store values) with no hydration mismatch — useClientState.ts.
  const [storedLive, setStoredLive] = useLocalStorageString(LIVE_SOURCE_KEY);
  const [legacyEmbed] = useLocalStorageString("embed_source");
  const [legacySpThin] = useLocalStorageString("chatStyle_spThinPlayer");
  const embedsOffKey = embedsOff.join(",");
  const liveOn = useMemo(() => liveSourcesOn(embedsOffKey ? embedsOffKey.split(",") : []), [embedsOffKey]);
  // A remembered source that is switched off plays the first one still on; nothing stored changes.
  const liveSource = liveSourceOn(parseLiveSource(storedLive) ?? liveSourceFromLegacy(legacyEmbed, legacySpThin), liveOn);
  const { active, spThinPlayer } = legacyForLiveSource(liveSource);
  const [pfpFailed, setPfpFailed] = useState(false);
  // Compact view: hides the video embed bar + MetaBar to reclaim vertical
  // space. The chat tab bar's far-left toggle is what restores them.
  //
  // DELIBERATELY NOT PERSISTED, unlike every neighbouring
  // toggle. This one hides the support bar and the Qorm/Donate/Gift row —
  // barVisibility.ts's header is explicit that hiding a donate button costs
  // money. A remembered "hide the money" that a viewer set once weeks ago and
  // cannot see the cause of is a worse failure than re-tapping a toggle, so it
  // is session-scoped: every visit opens with the full player.
  const [barsHidden, setBarsHidden] = useState(false);
  // Twitch validates the player's `parent` against the actual embedding host,
  // so it must be the live hostname (whatever host the page or the /popout window runs on).
  // The install's own host during SSR, the live hostname after hydration.
  const embedHost = useClientValue(() => window.location.hostname, new URL(authOrigin()).hostname);

  // Whether the viewer already has an active Supporter subscription — drives the
  // Subscribe⇄Gift button swap (a subscriber gifts instead of re-subscribing).
  const subscribed = useSubscriptionStatus(isSignedIn);
  const router = useRouter();

  // When Stripe is configured the support buttons open the in-place embed scoped
  // to a section; otherwise they fall back to the external links (env URLs).
  // A tip opens in place with EITHER provider (PayPal/Venmo alone included); subscribing is a
  // Stripe checkout, so it needs Stripe.
  const billing = useBillingAvailability();
  const stripeReady = billing.stripe;
  const [guestDonate, setGuestDonate] = useState(false);
  function openSupport(section: "donation" | "subscribe", fallbackUrl: string) {
    const inPlace = section === "donation" ? stripeReady || billing.paypalClientId !== null : stripeReady;
    if (!inPlace) { window.open(fallbackUrl, "_blank", "noopener"); return; }
    if (!isSignedIn) {
      // Guests can DONATE — /api/billing/donate takes a null matrix_id by
      // design (site.donations.matrix_id is nullable); the sign-in wall here
      // would be the only thing refusing their money. Subscribing
      // genuinely needs an account, so it still signs in — but parks WHY, so
      // the first signed-in UserMenu mount reopens the flow instead of
      // dropping the user back on the home page to hunt for the button.
      if (section === "donation") { setGuestDonate(true); return; }
      sessionStorage.setItem("bb_pending-support", section);
      // `push`, not a hard navigation — a signed-out viewer who clicks Support
      // should be able to come Back to the stream rather than reload it.
      router.push("/auth/signin");
      return;
    }
    // dispatchClaimable, not a bare CustomEvent: the hub's one-host guard
    // reads defaultPrevented, which only a cancelable event carries
    // (useUserMenuEvents.ts).
    dispatchClaimable("bb:open-support", { section });
  }

  const rootRef = useRef<HTMLDivElement>(null);
  const videoColRef = useRef<HTMLDivElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowViewport();
  // Panel resize + magnetic snap state machine (extracted to its own hook).
  // Declared here, above the fold code, because the visit rule and the
  // live edge below both call applyMode.
  // `defaultMode`: the visit's shape when nothing is stored, so the
  // server render and a fresh device paint the chat folded while offline.
  const { panelMode, snapZone, snapping, applyMode, resizeHandlers } =
    usePanelResize({ rootRef, narrow, defaultMode: isLive ? "normal" : "chatFolded" });
  // Selected video source for a featured community streamer (their sp/yt/tw-style
  // switcher). Defaults to the first source; reset when the featured streamer changes.
  // Its writer is Community's dropdown on the rail.
  const [communityPlatform, setCommunityPlatform] = useState<CommunitySource["platform"] | null>(null);
  // The VOD the Replay tab plays — defaults to the latest broadcast so the first
  // pick from the dock / the mobile VODs tab has something to land on. Browsing
  // happens outside the player; only a pick changes it. The offline default is
  // the first registered fallback, not a VOD.
  const [selectedVod, setSelectedVod] = useState<Vod | null>(vods[0] ?? null);
  // Which content fills the player slot. The source toggle is ALWAYS visible —
  // a viewer can switch to a registered fallback (or a VOD) even mid-stream.
  // "live" shows the live/community stream; the OFFLINE TAB — the first registered
  // fallback (app/lib/plugins/player.ts), else Live and its offline card — is the
  // default whenever nothing is live.
  const offlineTab: PlayerState["tab"] = fallbackIds[0] ?? "live";
  const [tab, setTab] = useState<PlayerState["tab"]>(isLive ? "live" : offlineTab);
  // What this tab is watching, for the per-source census. Seeded empty, not
  // "none": useStreamStatusPoll's mount effect fires its first poll before
  // this component's own effects have run, and the hydration render has
  // nothing but SSR defaults to report (storedMode/storedLive are still null,
  // currentSource is whatever stateForSource falls back to) — neither is the
  // viewer's real pick, so the first poll has nothing honest to say. An empty
  // ref (see useStreamStatusPoll's fetch) makes that poll cast no vote at all,
  // rather than a wrong one. Cost: a viewer who loads and leaves inside 30s is
  // never counted — an undercount of someone who barely watched, not a
  // miscount of someone who did.
  const sourceRef = useRef<string>("");
  // ── Live/community status poll (see useStreamStatusPoll) — also owns the
  // live/community-edge tab auto-switch. ──
  const { live, community, liveViewers, loopVideos, ytVideoId } =
    useStreamStatusPoll(isLive, viewerCount, initialYtVideoId, setTab, sourceRef, offlineTab);

  // Fold: `player_mode` = "none" unmounts the player and the bottom
  // bar and leaves the rail; any other value is a record of the last pick.
  // Nothing stored (the server render, a fresh device) seeds from the stream
  // state: offline paints folded from the first frame — no player embed in a
  // stranger's HTML, no collapse animation over it.
  // Identical on server and client, so hydration agrees; a device that HAS a
  // stored value is handled by the visit rule below, before paint.
  const [storedModeRaw, setStoredMode] = useLocalStorageString(PLAYER_MODE_KEY);
  const storedMode = storedModeRaw ?? (isLive ? null : "none");
  const folded = parsePlayerMode(storedMode) === "none";
  // The fold's mount lifecycle — see app/lib/usePlayerFold.ts for why the
  // player outlives the collapse and why the wait for `transitionend` needs a
  // fallback. `armFold` runs BEFORE the state flip, on the way INTO a fold.
  const { playerMounted, armFold, onRegionTransitionEnd } = usePlayerFold(folded);
  // Device-health telemetry: time spent with the video panel closed.
  useEffect(() => {
    setPlayerFolded(folded);
    return () => setPlayerFolded(false);
  }, [folded]);
  const toggleFold = useCallback(() => {
    if (!folded) armFold();
    setStoredMode(folded ? modeForTab(tab) : "none");
  }, [folded, tab, setStoredMode, armFold]);

  // ── One source selection (see app/lib/playerSource.ts) ──
  // The legacy triple (tab / active / spThinPlayer) is what the player area
  // consumes; `active` + `spThinPlayer` are derived from the one stored value.
  // "Community" is offered when a featured streamer is live OR when the fallback
  // playlist has anything in it — the icon promises something to watch, and both
  // states deliver one. Without the second clause a configured playlist would be
  // unreachable, because getStatus only reports `community` for a LIVE streamer.
  const hasCommunity = !!community || loopVideos.length > 0;
  const sources = useMemo(
    () => availableSources({ live, hasCommunity, fallbacks: fallbackIds, liveOn }),
    [live, hasCommunity, fallbackIds, liveOn]
  );
  const currentSource = sourceFromState({ tab, active, spThinPlayer });
  // Written in an effect, not during render: assigning a ref while rendering is
  // a side effect in render, and the next poll is at most 30s away.
  useEffect(() => {
    sourceRef.current = folded ? "none" : (currentSource ?? "none");
  }, [folded, currentSource]);
  const setSource = useCallback((next: PlayerSource) => {
    const st = stateForSource(next, { tab, ...legacyForLiveSource(liveSource) });
    setTab(st.tab);
    // Written whenever it differs from what is STORED (not from what is derived):
    // a device still on the legacy pair gets the new key on its first pick even
    // when the pick equals the legacy answer.
    const nextLive = liveSourceFromState(st);
    if (nextLive !== parseLiveSource(storedLive)) setStoredLive(nextLive);
  }, [tab, liveSource, storedLive, setStoredLive, setTab]);

  // THIS SOURCE's own liveness, straight from whichever TwitchPlayer is
  // mounted (StreamPlayerArea wires the same setter to both the Live tab's
  // own Twitch mount and the Community tab's featured-streamer one).
  //
  // It tints the Live rail icon and nothing else. The ingest poller stays
  // the only writer of `live` — coin earning, support-bar stream tagging and
  // the bot's live mode all key on that value, and a third-party embed must
  // never be in a position to decide whether viewers earn coins.
  //
  // Worth having anyway: the poller runs at 60s with a session open and 180s
  // idle, behind a two-miss debounce, so the icon can be minutes wrong while
  // the viewer is looking straight at it. The player knows first.
  const [playerLiveHint, setPlayerLiveHint] = useState<{ scope: "live" | "community"; live: boolean | null } | null>(null);
  // Shape changed (boolean → tagged object), so the raw setter can't be
  // handed to TwitchPlayer directly — wrapped once, stable across renders
  // (setPlayerLiveHint itself never changes identity), so TwitchPlayer's own
  // reporting effect does not loop.
  const setTwitchLiveHint = useCallback(
    (hint: boolean | null, scope: "live" | "community") => setPlayerLiveHint({ scope, live: hint }),
    [],
  );
  // ── The rail — the modes, their state colours and the active
  // mode's current option, all derived from the poll and the one persisted
  // live source. `fallbackUp: true`: a fallback's own player reports its state and
  // the rail has no cheaper signal; a grey fallback would mean a DOWN service,
  // so it waits on the player exposing one. (Declared after
  // setSource because selectMode closes over it.)
  const railStatus = {
    // Both guards below are load-bearing and neither subsumes the other —
    // read this before simplifying to just one of them.
    //
    // `scope === "live"`: StreamPlayerArea wires the SAME onPlayerLive setter
    // to both the Live tab's own Twitch mount and the Community tab's
    // featured-streamer mount, so the hint alone can't say which produced it.
    // Structural, not timing-dependent: switching from a live Twitch featured
    // streamer (Community tab) to the streamer's own Twitch (Live tab) unmounts one
    // TwitchPlayer and mounts a fresh one; `currentSource` flips to "twitch"
    // in the SAME render as the tab switch, one commit before the new mount's
    // reporting effect fires. Without the scope tag, that one paint would
    // read the stale `{ live: true }` the Community mount left behind and
    // show the Live icon red off a different streamer's broadcast.
    //
    // `currentSource === "twitch"`: a live-tab-scoped hint still goes stale
    // when the viewer picks a DIFFERENT live-tab source — Twitch's mount
    // unmounts (StreamPlayerArea only renders it while `active === "tw"`) and
    // nothing tells it to report null on the way out, so its last value would
    // otherwise outlive it and keep tinting the icon after a move to YouTube.
    // `currentSource` (not `liveSource`: see below) is read fresh every
    // render, so it drops the stale value with no effect needed.
    //   `liveSource` is the viewer's PERSISTED Live-tab pick and does not
    //   change while they are on the Community tab, so comparing against it
    //   would let a live report from the featured streamer's own Twitch mount
    //   (scope "community", but on a device whose remembered Live pick also
    //   happens to be Twitch) pass this check too. `currentSource` collapses
    //   tab + active into "twitch" only when the Live tab's own Twitch mount
    //   is the one actually on screen.
    live: (playerLiveHint?.scope === "live" && currentSource === "twitch" ? playerLiveHint.live : null) ?? live,
    communityLive: !!community,
    hasPlaylist: loopVideos.length > 0,
    fallbackUp: true,
  };
  const tones = Object.fromEntries(railModes(fallbackIds).map((m) => [m, railTone(m, railStatus)])) as Record<RailMode, RailTone>;
  const mode = folded ? "none" : modeForTab(tab);
  const detail = folded ? null : modeDetail(modeForTab(tab), {
    liveSource, communityName: community?.display_name ?? null, hasPlaylist: loopVideos.length > 0,
    replay: tab === "replay",
  });
  const selectMode = useCallback((m: RailMode) => {
    if (folded) setStoredMode(m);
    setSource(m === "live" ? liveSource : m);
  }, [folded, liveSource, setSource, setStoredMode]);
  const selectLiveSource = useCallback((s: LiveSource) => setSource(s), [setSource]);
  // The streamer going live while folded unfolds with Live — the same edge the poll
  // uses to move the tab (playerSource.edgeTab), read here as a transition.
  const prevLiveRef = useRef(live);
  useEffect(() => {
    if (folded && live && !prevLiveRef.current) setStoredMode(modeForTab(tab));
    prevLiveRef.current = live;
  }, [live, folded, tab, setStoredMode]);

  // ── The visit rule (app/lib/visitFold.ts): the fold follows the
  // stream state on every visit. Once, from the SERVER's isLive — not the
  // poll, which may be a beat behind — and from what this device stored last
  // time (the seeded reads above stand in for "nothing stored", so a fresh
  // device gets no writes at all). A LAYOUT effect, so a returning viewer's
  // stored shape is corrected before the first paint rather than collapsing
  // in front of them — which is also why a fold here does not armFold: there
  // is no transition to keep the player mounted through. The dock's open tab
  // is written through the same localStorage store BottomDock subscribes to;
  // the phone pane is told by event because ChatSidebar owns that state.
  const [, setDockTabRaw] = useLocalStorageString("dock_tab");
  // Once: a ref guard, not an empty dependency list — exhaustive-deps is a
  // warning under eslint-config-next and the policy is zero standing warnings.
  // `applyMode` is a fresh function every render, so the effect re-runs and
  // returns at the guard; the rule itself applies exactly once per mount.
  const visitRan = useRef(false);
  useLayoutEffect(() => {
    if (visitRan.current) return;
    visitRan.current = true;
    // Both stored modes come from STORAGE, not the hooks: in the hydration
    // commit useSyncExternalStore still answers with the server snapshot (the
    // seeded "none"), so a hook-read rule would see "already folded" and leave
    // a stored unfolded player open on an offline visit.
    const v = foldForVisit({ live: isLive, narrow: narrowViewportNow(), storedPlayerMode: lsGet(PLAYER_MODE_KEY) ?? storedMode, storedPanelMode: lsGet("panelMode") ?? (isLive ? null : "chatFolded") });
    if (v.player === "fold") setStoredMode("none");
    else if (v.player === "unfold") setStoredMode(modeForTab(isLive ? "live" : offlineTab));
    if (v.chat !== null) applyMode(v.chat);
    if (v.openHome) {
      if (!narrowViewportNow()) setDockTabRaw(writeDockTab("home"));
      window.dispatchEvent(new Event(OPEN_HOME_EVENT));
    }
  }, [isLive, storedMode, setStoredMode, applyMode, setDockTabRaw, offlineTab]);

  // The live edge's second half: the player-unfold above already
  // exists; going live also unfolds a folded chat on desktop and moves a phone
  // sitting on Home to Live. Ref-guarded so it fires on the transition only.
  const prevLiveChatRef = useRef(live);
  useEffect(() => {
    if (live && !prevLiveChatRef.current) {
      if (!narrow && panelMode === "chatFolded") applyMode("normal");
      window.dispatchEvent(new Event(OPEN_LIVE_EVENT));
    }
    prevLiveChatRef.current = live;
  }, [live, narrow, panelMode, applyMode]);

  // If the selected source stops being offered (the streamer ends the stream while you
  // are on Twitch), fall back rather than leaving a dead player behind an icon
  // that is no longer in the row.
  // Microtask defer, matching the fallback players' volume restore: setSource fans out to
  // several setStates (including localStorage-backed ones), and doing that
  // synchronously in the effect pass triggers a cascading render.
  // fallbackSource answers with the viewer's own live choice, so the move
  // changes nothing they chose; on a device still on the legacy pair it is
  // the first write of the new key (the same, legacy-derived value).
  // With nothing offered at all (offline, no community, no registered fallback) there is nowhere
  // to move: the Live tab's offline card stays.
  useEffect(() => {
    if (!currentSource || sources.length === 0 || sources.includes(currentSource)) return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setSource(fallbackSource({ live, hasCommunity, fallbacks: fallbackIds }, { tab, active, spThinPlayer }));
    });
    return () => { cancelled = true; };
  }, [currentSource, sources, live, hasCommunity, tab, active, spThinPlayer, setSource, fallbackIds]);
  const [showEmbedMgr, setShowEmbedMgr] = useState(false);
  const keyboardOpen = useKeyboardOpenDetection();
  useKeyboardLift(chatPanelRef);


  // Keyboard shortcuts (desktop only). Alt+R / Shift+Alt+R toggle theatre mode
  // (mirrors Twitch's chat-hide binding); Shift+Alt+P opens popout chat.
  const toggleTheatre = () => applyMode(panelMode === "theatre" ? "normal" : "theatre");
  useKeyboardShortcuts([
    { combo: { key: "r", alt: true },              handler: toggleTheatre },
    { combo: { key: "r", alt: true, shift: true }, handler: toggleTheatre },
    { combo: { key: "p", alt: true, shift: true }, handler: () => window.open("/popout", "_blank", "width=420,height=820,popup=1") },
  ], !narrow);

  useCoinHeartbeat(isSignedIn, live);

  // Per-DEVICE auto-mute (settings → Player → "Start stream muted"; deviceLocal
  // registry entry, so desktop and phone can differ). How it reaches each player
  // differs: the two cross-origin iframes take a query param (changing the src
  // remounts the frame), the Twitch adapter path takes a constructor option, and
  // the in-house player takes a prop.
  const [autoMuteRaw] = useLocalStorageString("chatStyle_streamAutoMute");
  const autoMute = autoMuteRaw === "1";

  // ONE RULE FOR ALL THREE LIVE SOURCES. Muted autoplay is always permitted;
  // unmuted autoplay is refused on phones, and a refused player starts NOTHING.
  // The recovery panel only exists when the platform's API script loaded, so on
  // a phone this mute is what makes video appear at all, for YouTube and Twitch
  // as much as stream.place.
  //
  // THE VIEWPORT CLAUSE IS LATCHED, THE SETTING IS NOT — and the asymmetry is
  // the point. `startMuted` feeds ytSrc/twSrc (iframe srcs, and ytSrc is also a
  // React key) and twStartMuted (part of the Twitch adapter's `create` identity,
  // which recreates the adapter on change). `useNarrowViewport()` is a LIVE
  // matchMedia subscription, so reading it here means a desktop viewer dragging
  // their window across the breakpoint gets the live stream torn down, rebuilt
  // and silently muted — and again on the way back. This file already documents
  // that narrowing a desktop window is an ordinary thing people do.
  // So: the mobile clause is answered ONCE and kept, while `autoMute` stays live
  // because a settings toggle must still apply immediately.
  //
  // Latched in a microtask off a mount effect (the house pattern — see the
  // transport restore in StreamplaceThinPlayer.tsx) rather than a lazy
  // initializer: this component server-renders, useNarrowViewport's server
  // snapshot is `false`, and `false` is what this state must ALSO be for the
  // hydration render or the first client markup disagrees with the server's.
  // The latch reads the media query directly, not the hook's value: during the
  // hydration render the hook is still serving the server snapshot, so a mount
  // effect that closed over it would latch "desktop" on every phone.
  const [narrowAtStart, setNarrowAtStart] = useState(false);
  useEffect(() => {
    Promise.resolve().then(() => setNarrowAtStart(narrowViewportNow()));
  }, []);
  const startMuted = narrowAtStart || autoMute;

  // No automatic fallback from stream.place to another source. Probing the
  // playlist and silently switching the viewer (combined with the player's own
  // demotion of a PERSISTED preference) would walk a viewer down the ladder on
  // one transient error with no way back.
  //
  // Every source is one click away in the source row, so an unreachable embed
  // is a visible dead player the viewer can act on rather than a silent
  // relocation. See the NO AUTOMATIC DEMOTION note in StreamplaceThinPlayer.

  // stream.place's embed is a WebRTC player. Its embed route DOES accept query
  // params (its `queryToProps` maps ?key=value straight onto PlayerProps, incl.
  // `muted`). On MOBILE, unmuted autoplay is blocked → the player's play() throws
  // NotAllowedError and its VideoRetry remounts the player every ~2-3s ("looping
  // on connect, never resolves", plus a stuck play/loading overlay). Starting it
  // MUTED lets mobile autoplay succeed (muted autoplay is always allowed), so the
  // viewer taps to unmute via the player's own controls. Desktop stays unmuted
  // unless the auto-mute setting says otherwise.
  // (Any control-bar auto-hide beyond that is the embed's own cross-origin UI.)
  // Picture-in-picture is gated on document.pictureInPictureEnabled inside their
  // own iframe — which is true only because our IFRAME_ALLOW list in
  // StreamPlayerArea.tsx delegates picture-in-picture to the frame.
  const spParams = new URLSearchParams();
  if (startMuted) spParams.set("muted", "true");
  const spSrc = `https://stream.place/embed/${spChannel}?${spParams.toString()}`;
  // YouTube live embeds carry YouTube's own inherent live latency (typically a
  // few seconds, more on normal-latency broadcasts). With no jump-to-live on the
  // bar, the bare iframe has NO client-side live-edge lever at all: seeking to
  // live, and a re-sync on tab return, both need the IFrame Player API (not
  // built). The real latency lever is enabling low-latency on the broadcast side.
  // `playsinline` because the embed's default on iOS is fullscreen.
  const ytSrc = youtubeLiveSrc({ videoId: ytVideoId, channelId: ytChannelId, autoMute: startMuted });
  // Twitch's player always uses the VIEWER's own Twitch session — we cannot feed
  // it our OAuth token, so ad-free playback requires the viewer's own sub/Turbo
  // logged into twitch.tv. No server-side ad bypass exists (ToS + infra); ads
  // are out of our control.
  const twSrc = `https://player.twitch.tv/?channel=${twitchChannel}&parent=${embedHost}&autoplay=true${startMuted ? "&muted=true" : ""}`;

  // Featured-streamer video sources + the currently selected one (defaults to
  // the first; falls back automatically when the featured streamer changes).
  const communitySources = community?.sources ?? [];
  const communitySource =
    communitySources.find((s) => s.platform === communityPlatform) ?? communitySources[0] ?? null;

  // Bar visibility model — the rules (and WHY the two bars differ) live in
  // app/lib/barVisibility.ts, pure and unit-tested. Read it before changing any
  // of this; the two bars are not symmetric on purpose.
  //
  // FOLDED overrides all of it, and does so HERE rather than inside
  // barVisibility (that function's rules stay untouched). A folded
  // frame is exactly its top bar: the player and the meta bar are unmounted,
  // so the panel has no in-flow children left. Theatre and desktop compact
  // both return `overlay: true`, which takes the top bar out of the flow with
  // `position: absolute` — and a frame whose only child is absolute collapses
  // to its borders, leaving the bar unmoored over nothing. So a folded panel's
  // bars are always in flow, and the fold arrow stays reachable in theatre.
  const bars: BarVisibility = folded
    ? { overlay: false, topHidden: false, bottomHidden: false, barsInFlow: true }
    : barVisibility({ narrow, barsHidden, theatre: panelMode === "theatre" });

  // Video layout mode (desktop). In normal view the bars are in the flow and HUG
  // the video (attached, content-height frame, top-aligned, leftover below). In
  // theatre the bars are absolute overlays and there's nothing to hug, so the
  // video fills & centers in the whole column. --video-chrome — the room the
  // attached video leaves for the bars — is a CSS sum of the two chrome tokens
  // plus the frame borders (globals.css, .bb-video-col); the bars are
  // exactly their tokens tall, so nothing measures.
  // Desktop compact does not fill: the bars park as overlays and the dock
  // KEEPS its space ("compact hides the tabs, not the panel"); the column's
  // `bars-parked` class shrinks the attached video's chrome allowance to the
  // frame alone (globals.css). Theatre alone fills.
  // The phone is different: its compact hides the bars for real.
  const fillMode = panelMode === "theatre" || (narrow && !bars.barsInFlow);
  const barsParked = !narrow && barsHidden && panelMode !== "theatre";

  // Picking a VOD from EITHER host (desktop dock, mobile chat tab) switches
  // the player to replay without unmounting it.
  // A pick from a folded player (the phone offline) pulls it
  // down: the stored mode is the record of the last pick, so writing it IS the
  // unfold — the same write toggleFold makes.
  const pickVod = (v: Vod) => {
    setSelectedVod(v);
    setTab("replay");
    if (folded) setStoredMode(modeForTab("replay"));
  };

  // A fallback panel's collapse (the box fits the panel; collapsible; a drag that
  // leaves too little room snaps to the collapsed row). Persisted per device and
  // per fallback (`<id>_collapsed` — the radio's key is unchanged), same mechanism
  // as dock_tab; the space-squeeze half lives in the fallback's player.
  const currentFallback = fallbackFor(tab);
  const [fallbackCollapsedRaw, setFallbackCollapsedRaw] = useLocalStorageString(`${currentFallback?.id ?? fallbackIds[0] ?? "fallback"}_collapsed`);
  const fallbackCollapsed = fallbackCollapsedRaw === "1";
  const toggleFallbackCollapsed = () => setFallbackCollapsedRaw(fallbackCollapsed ? "0" : "1");

  // Keyboard ramp arming — ONE boolean, two consumers that must never disagree:
  // [data-kb-ramp] on the column (which ramps) and [data-kb-ramp-host] on this
  // root (which publishes HOW FAR it ramps, as --pane-ceiling-rise, to both the
  // column and the chat panel's window layers). If the column ramps and the
  // host does not publish, a keyboard-up panel caps ~50px below the video's
  // edge; if the host publishes and the column does not ramp, it caps ~50px
  // ABOVE it — under the video. Derived from one expression so neither happens.
  const rampArmed = narrow && !barsHidden;

  return (
    <PlayerFallbacksProvider value={fallbacks}>
    <div ref={rootRef} data-kb-ramp-host={rampArmed ? "" : undefined}
      className="flex flex-col md:flex-row h-full overflow-hidden gap-0" style={{ padding: "var(--panel-gap, 12px)" }}>

      {/* ── Left column — on DESKTOP "full" it collapses to zero width (not
           display:none) so the player iframe stays mounted and audio keeps
           playing. On a phone it does not collapse at all: narrow "full" is
           neutered (the style below is `!narrow`-gated) because the drag-up
           MEANS fold — the player unmounts and this column keeps
           its top bar. `group` powers the theatre-mode bar auto-hide. ── */}
      <div
        ref={videoColRef}
        // Keyboard ramp: the ramp arms whenever the top bar is present
        // (compact already pulled both bars) — only the theatre TOGGLES are
        // md:-gated (StreamEmbedBar's button, the Alt+R shortcut), not the
        // mode itself (it restores from localStorage, so narrowing a desktop
        // window can land in narrow + theatre), but `overlay`/`.player-fill`
        // are both `!narrow`-gated regardless, so theatre still needs no term
        // here. Two values, not a boolean: "on" keeps the TRANSFORM armed
        // through a panel-resize snap so the column never un-translates
        // mid-snap; "anim" additionally arms the TRANSITION, and only then —
        // Note: "on" is currently unreachable: narrow's
        // `onToggleFull` is `toggleFold`, so `applyMode` — and therefore
        // `snapping` — cannot fire while `rampArmed` (which is `narrow && …`).
        // The value is kept rather than simplified away because the CSS still
        // distinguishes it (globals.css `[data-kb-ramp]` vs `="anim"`) and
        // videoColRamp.test.ts pins this exact expression: a phone-reachable
        // snap coming back must find the transform still armed.
        // `onToggleFull`'s snap carries its own Tailwind
        // transition-[flex,width,opacity] on this same element, unlayered vs.
        // layered on `transition`, so the two transition rules must stay
        // mutually exclusive on the same `snapping` boolean or check-layering's
        // collision is real (see check-layering.mjs's ALLOW entry for this
        // file, which documents exactly this proof).
        data-kb-ramp={rampArmed ? (snapping ? "on" : "anim") : undefined}
        className={`group bb-video-col @container flex flex-col min-w-0 flex-none md:flex-1 ${barsParked ? "bars-parked" : ""} ${
          snapping ? "transition-[flex,width,opacity] duration-(--anim-slow) will-change-[flex,width] anim-ease" : ""
        }`}
        // Desktop only: on a phone "full" does not collapse this column —
        // the drag-up MEANS fold, so the bar stays and the player
        // unmounts instead of a zero-height column hiding a running player.
        style={
          !narrow && panelMode === "full"
            ? { flex: "0 0 0px", width: 0, overflow: "hidden", opacity: 0 }
            : undefined
        }
      >
        {/* Video panel — a real rounded CSS border (--frame-color/--frame-width);
            no opaque backing, so the bars read against the page/video behind. */}
        <div
          // A folded chat leaves the video panel alone on the row exactly as
          // theatre does — no chat border, no chat width to sit against — so it
          // takes the same all-corners radius; without it the panel's right side
          // stayed square against nothing.
          className={`bb-panel rounded-tl-xl rounded-tr-xl md:rounded-tr-none md:rounded-bl-xl overflow-hidden relative flex flex-col ${
            playerPanelClass({ folded, fallbackClass: currentFallback?.panelClass ?? null, fillMode })
          } ${panelMode === "theatre" || panelMode === "chatFolded" ? "md:!rounded-xl" : ""}`}
          style={{
            border: "var(--frame-width, 2px) solid var(--frame-color, rgba(255,255,255,0.10))",
          }}
        >

          <StreamEmbedBar
            overlay={bars.overlay}
            hidden={bars.topHidden}
            occluded={narrow && keyboardOpen && !bars.topHidden}
            mode={mode}
            tones={tones}
            detail={detail}
            onSelectMode={selectMode}
            liveSource={liveSource}
            liveOn={liveOn}
            onSelectLiveSource={selectLiveSource}
            communityPlatforms={communitySources}
            communityPlatform={communitySource?.platform ?? null}
            onSelectCommunityPlatform={(p) => setCommunityPlatform(p as CommunitySource["platform"])}
            folded={folded}
            onFold={toggleFold}
            isMod={isMod}
            setShowEmbedMgr={setShowEmbedMgr}
            narrow={narrow}
            panelMode={panelMode}
            applyMode={applyMode}
          />

          {/* Player — sized by .player-attached / .player-fill (see globals.css).
              In normal view the bars HUG the video (attached, top-aligned, the
              video the largest 16:9 that fits the column minus --video-chrome,
              which is sized from the token sum rather than measured, leftover
              below); in theatre / bars-hidden it fills & centers. It is
              NEVER squished out of 16:9 — so short/wide viewports (mobile
              landscape, ultrawide) get clean page-coloured space instead of
              harsh black letterbox bars, and the video is never cropped. On
              mobile it's a natural full-width 16:9 block and the page scrolls.
              Folded, the region between the bars collapses over a
              transition rather than in one commit, and expands over the same
              transition on the way back — see .player-fold-region in
              chrome.css. The REGION is therefore never conditional: an element
              that remounts on unfold arrives already at 1fr and has no prior
              value to transition from, so the expand would snap. The PLAYER is
              what comes and goes, and it outlives the collapse (usePlayerFold)
              — a folding player keeps playing for the duration, because an
              audible cut before the visual one is worse. */}
          <div
            className="player-fold-region"
            data-folding={folded ? "" : undefined}
            onTransitionEnd={onRegionTransitionEnd}
          >
            {(!folded || playerMounted) && (
              <StreamPlayerArea
                isSignedIn={isSignedIn}
                fallbackCollapsed={fallbackCollapsed}
                onToggleFallbackCollapsed={toggleFallbackCollapsed}
                tab={tab}
                live={live}
                active={active}
                spSrc={spSrc}
                ytSrc={ytSrc}
                twSrc={twSrc}
                twitchChannel={twitchChannel}
                twStartMuted={startMuted}
                community={community}
                communitySource={communitySource}
                loopVideos={loopVideos}
                embedHost={embedHost}
                selectedVod={selectedVod}
                vodStartMuted={autoMute}
                spThinPlayer={spThinPlayer}
                spStartMuted={startMuted}
                spChannel={spChannel}
                onToggleSpPlayer={() => setSource("streamplace")}
                onPlayerLive={setTwitchLiveHint}
              />
            )}
          </div>

          {!folded && (
            <StreamMetaBar
              overlay={bars.overlay}
              hidden={bars.bottomHidden}
              live={live}
              community={community}
              tab={tab}
              streamerAvatar={streamerAvatar}
              streamerName={streamerName}
              pfpFailed={pfpFailed}
              setPfpFailed={setPfpFailed}
              streamTitle={streamTitle}
              selectedVod={selectedVod}
              followerCount={followerCount}
              liveViewers={liveViewers}
              subscribed={subscribed}
              openSupport={openSupport}
              donateUrl={donateUrl}
              // No Stripe and no outside link = nowhere to subscribe: no button (money.subscribeUrl).
              subscribeUrl={stripeReady || subscribeUrl ? subscribeUrl : null}
            />
          )}

        </div>{/* end video panel frame */}

        {/* ── Bottom dock (desktop) — the registry-armed tab strip in the
             leftover space below the video; the video is sized by the chat
             resize. Fade/collapse/measure rules live in
             BottomDock. On mobile the same registry arms tabs into the chat
             tab bar instead — there is no dock on a phone. Picking a VOD in
             either host switches the player to replay WITHOUT unmounting it.
             Compact keeps the dock with its tab row parked as an overlay;
             theatre alone removes it. ── */}
        {!narrow && panelMode !== "theatre" && (
          <BottomDock
            videoColRef={videoColRef}
            barsOverlay={barsParked}
            vods={vods}
            homeInitial={homeInitial}
            selectedVodId={selectedVod?.id ?? null}
            onPickVod={pickVod}
            isSignedIn={isSignedIn}
            live={live}
            isAdmin={isAdmin}
            onWatchCommunity={() => setSource("community")}
          />
        )}
      </div>

      {/* ── Resize handle — desktop only, transparent drag target. Drag runs
           the full continuum into a magnetic zone that arms a snap on release;
           the state machine lives in usePanelResize. ── */}
      {panelMode === "normal" && (
        <div
          className="hidden md:block shrink-0 cursor-col-resize relative z-10"
          style={{ width: "var(--panel-gap, 12px)" }}
          {...resizeHandlers}
        >
          {/* Always-grabbable hit area straddling the seam — stays usable even
              when --panel-gap is 0 (the visual gap collapses but the drag
              target doesn't). Absolute so it never adds layout width. */}
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-3 cursor-col-resize" />
        </div>
      )}

      {/* ── Chat sidebar — glass gradient border frame ── */}
      {/* Mobile: no top border (the video frame's bottom edge is the shared seam,
          and `.bb-video-col::after` casts the seam shadow down onto this
          panel) — owned by the media query in globals.css, NOT by an inline
          `narrow ? 0`, so it survives SSR's desktop-first first paint. */}
      {/* Desktop: full gradient border on all sides */}
      {/* The panel IS the keyboard layer — it rises by K while the
          pinned shell holds still; its top tucks behind the video column (z +
          backing in globals.css' phone block).
          The snap-zone highlight is an OUTLINE, not a ring: `ring-*` is a
          box-shadow, and .bb-panel's unlayered box-shadow beats it, so a
          ring would never render (check-layering's box-shadow family). */}
      <div
        ref={chatPanelRef}
        className={`bb-panel bb-chat-panel shrink-0 flex flex-col rounded-bl-xl rounded-br-xl md:rounded-bl-none md:rounded-tr-xl overflow-hidden flex-1 min-h-0 md:flex-none ${
          panelMode === "full" ? "md:!rounded-xl" : ""
        } ${
          snapping ? "transition-[width,padding] duration-(--anim-slow) will-change-[width] anim-ease" : ""
        } ${snapZone ? "outline-2 -outline-offset-2 outline-blue-400/50" : ""}`}
        style={{
          borderStyle: "solid",
          borderColor: "var(--frame-color, rgba(255,255,255,0.10))",
          // Top width lives in globals.css (.bb-chat-panel) so the media
          // query can zero it on phones — an inline value would beat it.
          // Theatre or a folded chat: no L/R border so the collapsed panel leaves no sliver.
          borderBottomWidth: "var(--frame-width, 2px)",
          borderLeftWidth: !narrow && (panelMode === "theatre" || panelMode === "chatFolded") ? 0 : "var(--frame-width, 2px)",
          borderRightWidth: !narrow && (panelMode === "theatre" || panelMode === "chatFolded") ? 0 : "var(--frame-width, 2px)",
          width: narrow ? undefined
            : (panelMode === "theatre" || panelMode === "chatFolded") ? 0
            : "var(--chat-width, 320px)",
          overflow: !narrow && (panelMode === "theatre" || panelMode === "chatFolded") ? "hidden" : undefined,
        }}
      >
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <ErrorBoundary>
            <ChatSidebar isSignedIn={isSignedIn} userId={userId} canonicalId={canonicalId} isMod={isMod} isAdmin={isAdmin}
              initialMessages={initialMessages} initialEmotes={initialEmotes}
              onToggleFull={narrow ? toggleFold : () => applyMode(panelMode === "full" ? "normal" : "full")}
              isFull={narrow ? folded : panelMode === "full"}
              // Same button, two verbs: on a phone the handler above IS the
              // player fold, so the bar must not call it "Community mode".
              fullKind={narrow ? "fold" : "community"}
              onFoldChat={narrow ? undefined : () => applyMode("chatFolded")}
              compact={barsHidden}
              narrow={narrow}
              onToggleCompact={() => setBarsHidden((v) => !v)}
              vods={vods}
              homeInitial={homeInitial}
              selectedVodId={selectedVod?.id ?? null}
              onPickVod={pickVod}
              onWatchCommunity={() => setSource("community")} />
          </ErrorBoundary>
        </div>
      </div>

      {/* ── Edge tabs — the way back out of the snapped endpoint states. For a
           FOLDED chat the tab is always visible (a hover-only tab at opacity 0
           is too easy to miss); dim, full strength on hover. In
           theatre (video alone, the viewer's choice) it keeps the proximity
           reveal, as does the full-mode "Show stream" tab below. ── */}
      {!narrow && (panelMode === "theatre" || panelMode === "chatFolded") && (
        <div className="hidden md:block fixed right-0 top-0 bottom-0 w-6 z-40 group/chatedge">
          <button
            onClick={() => applyMode("normal")}
            title="Show chat"
            aria-label="Show chat"
            className={`absolute right-0 top-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-14 rounded-l-lg bg-surface-2 hover:bg-surface-3 border border-r-0 border-edge text-secondary hover:text-strong transition-all duration-(--anim-default) ${
              panelMode === "chatFolded" ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover/chatedge:opacity-100"
            }`}
          >
            <CaretLeft size={12} weight="bold" />
          </button>
        </div>
      )}
      {!narrow && panelMode === "full" && (
        <div className="hidden md:block fixed left-0 top-0 bottom-0 w-6 z-40 group/streamedge">
          <button
            onClick={() => applyMode("normal")}
            title="Show stream"
            className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-14 rounded-r-lg bg-surface-2 hover:bg-surface-3 border border-l-0 border-edge text-secondary hover:text-strong opacity-0 group-hover/streamedge:opacity-100 transition-all duration-(--anim-default)"
          >
            ›
          </button>
        </div>
      )}

      {/* Armed-snap hint while dragging inside a magnetic zone */}
      {snapZone && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-raised/95 border border-edge-strong text-xs font-semibold text-strong shadow-xl pointer-events-none">
          {snapZone === "chatFolded"
            ? "Release to fold chat"
            : "Release for full-screen community"}
        </div>
      )}

      {showEmbedMgr && <CommunityEmbedManager onClose={() => setShowEmbedMgr(false)} />}

      {/* Guest donation: the one support flow that works
          without an account, hosted here because the usual host (UserMenu's
          card stack) needs a matrixId. Scoped to the donation section only.
          Under Modal this dialog had NO visible header — `label` was
          aria-only, and the sole in-content close affordance was the
          terminal "done" state's button. Window's band gives it a visible
          "Donate" title and a ✕ for the first time. */}
      {guestDonate && (
        <Window presentation="dialog" name="Donate" title="Donate" onClose={() => setGuestDonate(false)} width={448}>
          <div className="p-4">
            <GuestSupportContent sections={["donation"]} onClose={() => setGuestDonate(false)} signedIn={false} />
          </div>
        </Window>
      )}
    </div>
    </PlayerFallbacksProvider>
  );
}

// Loaded on demand: SupportContent pulls the Stripe embed bundle, which the
// stream page must not pay for until a guest actually opens Donate.
const GuestSupportContent = dynamic(() => import("./SupportContent"), { ssr: false });
