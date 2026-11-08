"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { siteName } from "@/app/lib/siteName";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import {
  escalationFor, escalationAfterGrace, playbackIsAdvancing, reconnectDelayMs, retryBudgetSpent, offerChoicesWhileReconnecting,
  watchdogVerdict, busyRetryMs, CONNECT_TIMEOUT_MS, ICE_GATHER_CAP_MS, type NegotiationPhase,
} from "@/app/lib/whepEscalation";
import { derivePlayerStats, type PlayerStats, type StatsSample } from "@/app/lib/playerStats";
import { reportClientError } from "@/app/lib/clientError";
import { readInboundVideoCounters, buildPlayerEvent, type PlayerEventKind } from "@/app/lib/playerTelemetry";
import { hlsConfigFor, SMOOTH_JITTER_BUFFER_MS } from "@/app/lib/hlsConfig";
import { useSetting } from "@/app/lib/useSetting";
import { registerVideoProbe, setPlayerAudio } from "@/app/lib/playerHealth";
import { readInboundVideo, readVideoElement } from "@/app/lib/deviceHealth/videoQuality";
import { chooseHlsImpl, hlsFailureKind, hlsPlaylistUrl } from "@/app/lib/hlsPath";
import { lsGet, lsRemove, lsSet } from "@/app/lib/safeLocalStorage";
import { parseTransport, TRANSPORT_KEY, type Transport } from "@/app/lib/playerTransport";
import { siteIcon } from "@/app/lib/siteIcons";
import { toggleFullscreen } from "./fullscreen";
import {
  clampVolume, restorableVolume, isSilent, sliderPercent, unmuteVolume, volumeKeyFor, migrateLegacyVolume,
} from "@/app/lib/playerVolume";
import {
  SpeakerHigh,
  SpeakerSlash,
  CornersOut,
  PictureInPicture,
  ArrowClockwise,
  CaretDown,
  MonitorPlay,
  WaveSine,
  Play,
  Pause,
  Pulse,
} from "@phosphor-icons/react/dist/ssr";

// The in-house player's own volume key (playerVolume.ts rule 3).
const OWN_VOLUME_KEY = volumeKeyFor("native");

// In-house stream.place player — a native WebRTC (WHEP) client that plays the streamer's
// stream.place stream directly, offered as a toggle beside the stream.place/embed
// iframe (which stays the default + fallback). Value over the iframe: an
// audio-only rendition (data saver) + quality select + our own controls, at the
// same sub-second latency (same WebRTC transport).
//
// Signaling is proxied through /api/streamplace/whep (the browser can't POST SDP
// to stream.place cross-origin, and the DID lives server-side). Media then flows
// browser↔playback-node directly over DTLS/UDP — no CORS, no iframe.
//
// The component only mounts while stream.place is the ACTIVE source on the Live
// tab, so switching to another embed / tab / radio unmounts it and the cleanup
// tears the peer connection down — nothing keeps pulling in the background.
//
// Ported/simplified from @streamplace/components use-webrtc.tsx: two recvonly
// transceivers, offer → proxy → answer, reconnect on connection loss.
//
// ── NO AUTOMATIC DEMOTION ─────────────────────────────────────────────────────
// A fallback ladder that only goes DOWN (WHEP → HLS → embed → another
// platform) strands viewers: dropping to the embed calls onFallback(), which
// is wired to the viewer's PERSISTED live-source choice, so a single transient
// error would not just demote the session but rewrite the viewer's setting
// across reloads, and viewers would accumulate at the bottom one blip at a time.
//
// So: we RETRY (a transport we know works), or STOP and show the viewer the
// choice. We never switch transports or rewrite their preference for them. Every
// escape is one click — compatibility mode, retry low-latency, or the
// embed — they are just all manual. whepEscalation.ts decides WHEN to stop.
//
// The known cost, accepted deliberately: on a WebRTC-hostile network (GrapheneOS
// Vanadium's "disable non-proxied UDP", some corporate/VPN egress) nothing
// auto-rescues the viewer — after CONNECT_TIMEOUT_MS they get the
// "can't connect" panel and must pick compatibility mode themselves.

type RenditionOpt = { name: string; label: string; audioOnly?: boolean };
const RENDITIONS: RenditionOpt[] = [
  { name: "source", label: "Source" },
  { name: "audio", label: "Audio only", audioOnly: true },
];

// "failed" = we stopped trying and are waiting for the viewer to choose. It is
// deliberately distinct from "ended": a stream that finished and a transport we
// could not establish are different facts, and showing "Stream has ended" for
// the second one is a lie the viewer can't act on. "busy" = the relay answered
// 429: waiting out its Retry-After, then trying again by itself.
type Status = "connecting" | "playing" | "reconnecting" | "busy" | "ended" | "failed";


const CONTROLS_HIDE_MS = 2800;
// The reconnect budget, its wait ladder and the connect watchdog's deadlines
// (CONNECT_TIMEOUT_MS, judged by phase) live in whepEscalation.ts, tested
// there. A session that has played keeps reconnecting while it is mounted; one
// that never connected stops at the budget and shows the "failed" overlay
// (viewer picks: retry / HLS / embed). The HLS path bounds its own start with
// CONNECT_TIMEOUT_MS too.
const STATS_POLL_MS = 3000;

// STUN is required for connectivity on restrictive networks (mobile / cellular
// CGNAT). stream.place's playback node puts reachable candidates in its SDP
// answer, so a desktop on a friendly NAT connects with host candidates alone —
// but a mobile client needs a server-reflexive candidate of its own or the ICE
// check never completes (symptom: stuck on "connecting…" on phones, fine on
// desktop). stream.place advertises no TURN via WHEP Link headers, so we bring
// our own public STUN. (If a network blocks UDP outright, only TURN would fix
// it — escalate to a TURN server then.)
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

// The smoother-playback switch on this transport: the receive buffer the browser
// aims for (RTCRtpReceiver.jitterBufferTarget, ms; null = the browser's own
// choice). A browser without the property is left alone.
function setJitterBuffer(r: RTCRtpReceiver, smooth: boolean): void {
  if (!("jitterBufferTarget" in r)) return;
  try {
    (r as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget = smooth ? SMOOTH_JITTER_BUFFER_MS : null;
  } catch { /* a value this engine refuses — its own buffer stands */ }
}

export default function StreamplaceThinPlayer({
  startMuted,
  onFallback,
  channel,
}: {
  startMuted: boolean;
  onFallback: () => void;
  channel: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Consecutive failed-connect count — a ref so it survives the nonce-driven
  // effect re-runs that each reconnect triggers; reset to 0 on a good connect.
  const retryCountRef = useRef(0);
  // Did this session ever reach a live WebRTC connection? Distinguishes a
  // transient mid-stream drop (retry WebRTC) from an initial can't-connect
  // (stop and surface the failed overlay — e.g. a hardened browser blocking
  // WebRTC; the viewer picks HLS/embed themselves, never automatically).
  const everConnectedRef = useRef(false);
  // The playback node the relay's WHEP answer named (x-playback-server), for
  // player-telemetry rows — see playerTelemetry.ts. Null until the first
  // negotiation's response has been read. Declared at component level, so it
  // survives ACROSS negotiate-effect runs — a reconnect bumps `nonce`, which
  // re-runs the whole effect, so there is no "within one run" to speak of;
  // only a component-level ref outlives that. Not reset per-attempt: our own
  // 429 (no header) must not blank out the last node a real answer named.
  const nodeRef = useRef<string | null>(null);
  // Previous getStats sample, for computing deltas (loss %, bitrate).
  const statsPrevRef = useRef<StatsSample | null>(null);

  const [rendition, setRendition] = useState("source");
  const [status, setStatus] = useState<Status>("connecting");
  // "Smoother playback (adds delay)" (settingsRegistry playerSmooth). A ref for
  // the WebRTC receivers, so flipping it never renegotiates; the HLS effect
  // takes the value as a dep, because hls.js reads its config at construction.
  const smooth = useSetting("chatStyle_playerSmooth") === "1";
  const smoothRef = useRef(smooth);
  // A reconnect that has run past the old budget (offerChoicesWhileReconnecting)
  // also offers Compatibility mode and the embed while it keeps trying: the
  // viewer is never stuck, and never made to act when the network will return.
  const [offerEscapes, setOfferEscapes] = useState(false);
  const [muted, setMuted] = useState(startMuted);
  // 0–1, applied to video.volume. Deliberately ORTHOGONAL to `muted`: startMuted
  // exists to satisfy autoplay policy, so restoring a saved volume must never
  // unmute on its own or mobile autoplay breaks. Default 1 = the element default,
  // so a viewer who has never touched the slider is unaffected.
  const [volume, setVolume] = useState(1);
  const [paused, setPaused] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Wraps the Quality toggle AND its popup — one "inside" for useOutsideClick.
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  // Feature-detect PiP once, client-side (this component only mounts on the
  // client). Lazy initializer keeps `document` out of the render path + SSR.
  const [pipOk] = useState(
    () => typeof document !== "undefined" && !!document.pictureInPictureEnabled,
  );
  // Bumped to force a fresh negotiation (reconnect / jump-to-live). Also the
  // effect dep, so a rendition change re-negotiates too.
  const [nonce, setNonce] = useState(0);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  // "webrtc" = low-latency primary; "hls" = compatibility fallback (plain HTTPS,
  // works where WebRTC is blocked — hardened browsers, UDP-hostile networks).
  // Mode changes are ALWAYS a viewer's click (control-bar toggle or the failed
  // overlay's options) — never automatic; see NO AUTOMATIC DEMOTION above.
  const [mode, setMode] = useState<Transport>("webrtc");
  // Both transport effects wait for this. What the gate actually buys, read off
  // the negotiate effect below rather than assumed: without it, a viewer whose
  // remembered transport is HLS would still construct a throwaway
  // RTCPeerConnection on mount, add two recvonly transceivers and run a round of
  // ICE gathering against the Cloudflare/Google STUN servers — all of it for a
  // transport they have already told us not to use, torn down a microtask later
  // when the restore flips `mode` to "hls".
  // It does NOT save a WHEP exchange, and must not be justified as if it did:
  // the fetch sits behind `if (aborted) return` immediately after
  // `await waitForIce(pc)`, and an abort landing on the restore microtask
  // arrives long before gathering completes — so no offer is ever sent and
  // /api/streamplace/whep's per-address budget is never touched.
  const [transportRestored, setTransportRestored] = useState(false);

  // Latest muted value for callbacks (tryPlay / ontrack) without making them
  // depend on `muted` — otherwise the negotiate effect would re-run on every
  // mute toggle and needlessly renegotiate. Synced in an effect (not at render).
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // The smoother-playback switch, live: retarget the receivers this connection
  // already has (a new connection's tracks read the ref as they arrive).
  useEffect(() => {
    smoothRef.current = smooth;
    for (const r of pcRef.current?.getReceivers?.() ?? []) setJitterBuffer(r, smooth);
  }, [smooth]);

  // Same reasoning as mutedRef: tryPlay must read the current volume without
  // taking it as a dep (that would renegotiate on every slider drag).
  // Last non-zero level, so unmuting from a zeroed slider returns somewhere audible.
  const lastVolRef = useRef(1);
  const volumeRef = useRef(volume);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  // Restore the saved volume on mount (device-local, like the radio's). Microtask
  // defer keeps the setState out of the synchronous effect pass.
  useEffect(() => {
    Promise.resolve().then(() => {
      // Off the shared key first (idempotent), then this player's own level. Below the
      // floor counts as absent — the default (full) stands, never a near-silent 3%.
      migrateLegacyVolume(lsGet, lsSet, lsRemove);
      const saved = restorableVolume(lsGet(OWN_VOLUME_KEY));
      if (saved === null) return;   // absent, corrupt or below the floor — keep the default
      setVolume(saved);
      if (saved > 0) lastVolRef.current = saved;
    });
  }, []);

  // Restore the remembered transport (device-local, like the volume above).
  // Microtask defer, and deliberately NOT a lazy useState initializer: this
  // component server-renders whenever the page loads while live, so reading
  // storage during the first render would hydrate a control bar that disagrees
  // with what the server sent. Setting state from a promise continuation is
  // also what keeps react-hooks/set-state-in-effect quiet.
  // The flag is set in a `finally`, and that is load-bearing rather than
  // defensive style. BOTH transport effects are gated on it, and both watchdogs
  // live INSIDE those effects — so a throw anywhere in this continuation would leave
  // the player on "Connecting…" forever with nothing armed to escalate it. lsGet
  // and parseTransport are total, but the finally removes the whole class instead
  // of relying on that staying true.
  useEffect(() => {
    Promise.resolve().then(() => {
      try {
        const saved = parseTransport(lsGet(TRANSPORT_KEY));
        if (saved) setMode(saved);
      } finally {
        setTransportRestored(true);
      }
    });
  }, []);

  // Push volume onto the element. Separate from the negotiate effect so a drag
  // never tears down the connection; also re-applies after a mode switch, since
  // the HLS path calls v.load() and a fresh srcObject resets nothing but this is
  // cheap insurance.
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.volume = volume;
  }, [volume, mode]);

  // Wall-clock of the last `timeupdate`. See playbackHealthy().
  const lastProgressRef = useRef(0);

  // Is video ACTUALLY playing right now, regardless of what the peer connection
  // claims? This is the guard that stops the new "failed" panel from repeating
  // the old ladder's central mistake in a louder form.
  //
  // The demotions we removed fired on WORKING playback: `disconnected` is a
  // control-plane state (an ICE consent check missed its window) and media
  // frequently keeps flowing straight through it. The old code demoted anyway.
  // If the new code painted "Can't connect" over that same still-playing video,
  // it would be a worse bug than the one being fixed — a silent transport swap
  // is at least watchable; a full-screen error over live video is not.
  //
  // So no failure state may be entered while frames are advancing. timeupdate
  // fires only on real progress, so a stale timestamp means genuinely stalled,
  // and readyState >= HAVE_CURRENT_DATA rules out a decoder with nothing to show.
  // The predicate itself lives in whepEscalation.ts so it can be unit-tested —
  // the transport can't be. This wrapper only reads the DOM.
  const playbackHealthy = useCallback(() => {
    const v = videoRef.current;
    if (!v) return false;
    return playbackIsAdvancing({
      paused: v.paused,
      readyState: v.readyState,
      lastProgressAt: lastProgressRef.current,
      now: Date.now(),
    });
  }, []);

  const activeRendition = RENDITIONS.find((r) => r.name === rendition) ?? RENDITIONS[0]!;

  const tryPlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = mutedRef.current;
    v.volume = volumeRef.current;
    v.play()
      .then(() => { setNeedsTap(false); setPaused(false); })
      .catch(() => {
        // Unmuted autoplay is blocked until a gesture — fall back to muted
        // autoplay (always allowed) so video at least starts; the viewer taps to
        // unmute. If even muted play is blocked, show a tap-to-play overlay.
        if (!mutedRef.current) {
          setMuted(true);
          v.muted = true;
          v.play().then(() => { setNeedsTap(false); setPaused(false); }).catch(() => setNeedsTap(true));
        } else {
          setNeedsTap(true);
        }
      });
  }, []);

  // Show the controls and arm the auto-hide countdown. Any pointer/touch calls
  // this; the derived `showControls` below keeps them up while the menu is open,
  // a gesture is needed, or we're not yet playing.
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideRef.current) clearTimeout(hideRef.current);
    hideRef.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
  }, []);

  // Negotiate a WebRTC session (the low-latency primary). Re-runs on rendition
  // change and on `nonce` bumps; cleanup tears the peer connection down. Skipped
  // entirely in hls mode.
  useEffect(() => {
    if (mode !== "webrtc" || !transportRestored) return;
    let aborted = false;
    const ctrl = new AbortController();
    const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle", iceServers: ICE_SERVERS });
    pcRef.current = pc;
    // How far this attempt has got (whepEscalation.ts NegotiationPhase) and
    // when — the watchdog judges by it, and every telemetry row names it.
    const startedAt = Date.now();
    let phase: NegotiationPhase = "ice";
    let answeredAt: number | null = null;

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    // Enter a stop state ONLY once playback has genuinely stopped. While frames
    // are still advancing we hold and re-check — the connection may be reported
    // dead while media flows (see playbackHealthy). If it later stalls for real,
    // the loop catches it; if it recovers, `connected` cancels the loop.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
    // The same hold-and-recheck for a remote track's `ended`. Separate timer,
    // because it ends in a reconnect rather than a stop.
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    const clearEnd = () => { if (endTimer) { clearTimeout(endTimer); endTimer = null; } };
    const clearRetry = () => { if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; } };
    // A track can end while the picture keeps moving (one track of two
    // dropped). Fifteen seconds of advancing frames after a track's `ended` is
    // not a stop — stand down and let the ordinary paths judge what follows.
    const MAX_END_RECHECKS = 5;
    let endRechecks = 0;
    // One sink row per decision — see playerTelemetry.ts. Runs BEFORE the
    // teardown the decision causes, while `pc` can still answer getStats;
    // a pc that cannot (closing) gives null counters, which is still a row.
    // Declared first: every caller below is a `const` arrow in this scope.
    const reportPlayerEvent = (kind: PlayerEventKind, reason: string) => {
      const attempt = retryCountRef.current;
      const states = { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState };
      const at = { phase, elapsedMs: Date.now() - startedAt };
      void pc.getStats()
        .then((reports) => readInboundVideoCounters(reports.values()))
        .catch(() => null)
        .then((counters) => {
          const ev = buildPlayerEvent({ kind, reason, ...states, ...at, attempt, node: nodeRef.current, mode: "webrtc", counters });
          const err = new Error(ev.message);
          err.stack = ev.stack; // describe() forwards .stack verbatim — the JSON payload rides there
          reportClientError("player", err);
        })
        // reportClientError never throws (see its own note), but a
        // synchronous throw anywhere earlier in this chain must still not
        // escape as an unhandledrejection — which clientError.ts's own
        // window listener would report right back into this same sink.
        .catch(() => {});
    };

    // reason: why this attempt is being judged as failed — surfaced only in
    // the player-telemetry row (playerTelemetry.ts), never shown to the viewer.
    const failIfStalled = (reason: string) => {
      if (aborted) return;
      if (!playbackHealthy()) { clearStall(); reportPlayerEvent("failed", reason); setStatus("failed"); return; }
      if (stallTimer) return;
      stallTimer = setTimeout(() => { stallTimer = null; failIfStalled(reason); }, 3000);
    };

    // reason: why this reconnect was scheduled, threaded through to the
    // player-telemetry row before the decision's teardown. When the budget is
    // spent no reconnect is scheduled — failIfStalled("max-reconnects") is —
    // so the report sits past that check: one decision must not emit both a
    // "reconnect" row (false — there is no reconnect) and the "failed" row.
    const scheduleReconnect = (reason: string) => {
      if (aborted || retryRef.current) return;
      // Only a session that has never played stops here and hands the viewer
      // the choice; one that has played keeps trying for as long as it is
      // mounted (whepEscalation.ts, above MAX_RECONNECTS). Never a demotion —
      // see NO AUTOMATIC DEMOTION above.
      if (retryBudgetSpent({ everConnected: everConnectedRef.current, retryCount: retryCountRef.current })) { failIfStalled("max-reconnects"); return; }
      reportPlayerEvent("reconnect", reason);
      clearEnd();
      retryCountRef.current += 1;
      setStatus("reconnecting");
      setOfferEscapes(offerChoicesWhileReconnecting(retryCountRef.current));
      const delay = reconnectDelayMs(retryCountRef.current);
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        if (!aborted) setNonce((n) => n + 1);
      }, delay);
    };

    // A remote track ended. On a stream.place stream that is still live — and
    // this player is only mounted while the site's liveness says it is — that
    // is the node dropping us (a track swap, a node restart), not the end of
    // the broadcast: prod 10-18 → 10-31 had ten `track-ended` rows on one
    // viewer, stream.place live throughout, each one a "Stream has ended"
    // panel over a live stream until a tap. So it reconnects, once the
    // picture has really stopped; when the broadcast truly ends, liveness
    // unmounts the player and the page says so. (The node answers a WHEP offer
    // 200 even for an offline streamer — measured 2026-10-31 — so the
    // exchange itself cannot tell the player the stream is over.)
    const reconnectIfTrackStalled = () => {
      if (aborted || endTimer) return;
      if (!playbackHealthy()) { endRechecks = 0; scheduleReconnect("track-ended"); return; }
      if (endRechecks >= MAX_END_RECHECKS) { endRechecks = 0; return; }
      endRechecks += 1;
      endTimer = setTimeout(() => { endTimer = null; reconnectIfTrackStalled(); }, 3000);
    };

    // A track that arrives without an `msid` has no e.streams[0]; left
    // unattached, the LIVE pill would sit over permanent black. One synthetic
    // stream per negotiation collects such tracks so audio and video share it.
    const synthetic = new MediaStream();
    pc.addEventListener("track", (e) => {
      let stream = e.streams[0];
      if (!stream) { synthetic.addTrack(e.track); stream = synthetic; }
      if (smoothRef.current && e.receiver) setJitterBuffer(e.receiver, true);
      if (videoRef.current && videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
        tryPlay();
      }
      // Audio and video are two tracks, and the node stops both: the second
      // `ended` lands on a reconnect already armed and adds nothing. The
      // abort guard suppresses this when WE tear the connection down.
      e.track.addEventListener("ended", () => { if (!aborted) reconnectIfTrackStalled(); });
    });

    // Watchdog: WebRTC can hang without ever firing a failure — in the WHEP
    // exchange (a request our own site has not answered) or in the ICE checks
    // (GrapheneOS Vanadium blocking non-proxied UDP). whepEscalation.ts's
    // watchdogVerdict judges by phase: it waits out our relay's own deadline
    // on an unanswered offer, retries what is not a transport verdict, and
    // only a never-played session whose media path never came up gets the
    // choice panel.
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
    const judgeWatchdog = () => {
      watchdog = null;
      if (aborted || pc.connectionState === "connected") return;
      const v = watchdogVerdict({ phase, elapsedMs: Date.now() - startedAt, answeredAtMs: answeredAt, everConnected: everConnectedRef.current });
      if (v.kind === "wait") watchdog = setTimeout(judgeWatchdog, v.ms);
      else if (v.kind === "reconnect") scheduleReconnect("watchdog");
      else if (v.kind === "fallback") failIfStalled("watchdog");
    };
    watchdog = setTimeout(judgeWatchdog, CONNECT_TIMEOUT_MS);

    // The relay answered 429: busy, not broken. Wait out its Retry-After and try
    // again by itself. No budget is spent and the watchdog stands down — neither
    // is a verdict on the transport. Nothing is painted over a moving picture.
    const waitWhileBusy = (retryAfter: string | null) => {
      if (aborted || retryRef.current) return;
      clearWatchdog();
      reportPlayerEvent("busy", "relay:429");
      if (!playbackHealthy()) setStatus("busy");
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        if (!aborted) setNonce((n) => n + 1);
      }, busyRetryMs(retryAfter));
    };

    // `disconnected` is TRANSIENT and usually self-heals; escalating on it was
    // demoting viewers off a working player mid-stream. Policy lives in
    // lib/whepEscalation.ts so it can be unit-tested — the transport cannot.
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearGrace = () => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } };

    // The policy module decides what a state means (disconnected is transient,
    // failed is terminal). "fallback" means stop and ask, never switch
    // transports behind the viewer's back. `reason` is the player-telemetry
    // reason for whichever decision this action becomes.
    const applyEscalation = (action: ReturnType<typeof escalationFor>, reason: string) => {
      if (action.kind === "reconnect") scheduleReconnect(reason);
      else if (action.kind === "fallback") failIfStalled(reason);
    };

    pc.addEventListener("connectionstatechange", () => {
      const st = pc.connectionState;
      if (st === "connected") {
        phase = "media";
        clearWatchdog();
        clearGrace(); // recovered on its own — the viewer never needs to know
        clearStall();
        clearEnd(); // a connect means the tracks were not ending
        clearRetry();
        retryCountRef.current = 0; // clean connect — reset the failure count
        everConnectedRef.current = true;
        setStatus("playing");
        setOfferEscapes(false);
        revealControls(); // flash the controls once on connect, then auto-hide
        return;
      }
      const ctx = { everConnected: everConnectedRef.current, aborted };
      const action = escalationFor({ ...ctx, state: st });
      if (action.kind === "wait") {
        // Hold. Only escalate if it is STILL not connected when grace expires.
        if (graceTimer) return;
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (aborted || pc.connectionState === "connected") return;
          applyEscalation(escalationAfterGrace({ everConnected: everConnectedRef.current, aborted }), "grace-expired");
        }, action.graceMs);
        return;
      }
      clearGrace();
      applyEscalation(action, `state:${st}`);
    });

    (async () => {
      try {
        // A retry keeps saying "Reconnecting…" (or "busy"): the viewer was
        // watching, and "Connecting…" between tries reads as a fresh start.
        setStatus((s) => (s === "reconnecting" || s === "busy" ? s : "connecting"));
        // Transceivers already declare recvonly audio+video, so the legacy
        // offerToReceive* flags are redundant.
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const desc = await waitForIce(pc);
        if (aborted) return;
        phase = "signal";
        const res = await fetch(`/api/streamplace/whep?rendition=${encodeURIComponent(rendition)}`, {
          method: "POST",
          headers: { "content-type": "application/sdp" },
          body: desc?.sdp ?? offer.sdp ?? "",
          signal: ctrl.signal,
        });
        if (aborted) return;
        // The relay names the node it forwarded to (x-playback-server) — read
        // once here so every telemetry row from here on carries it, even one
        // fired long after this negotiation (a later stall on this same pc).
        // Fall back to whatever was already known: our own 429 (rate-limited
        // before the relay ever forwarded to a node) carries no such header,
        // and must not blank out a real node a previous answer named.
        nodeRef.current = res.headers.get("x-playback-server") ?? nodeRef.current;
        if (res.status === 429) { waitWhileBusy(res.headers.get("retry-after")); return; }
        if (!res.ok) { scheduleReconnect(`relay:${res.status}`); return; }
        const answer = await res.text();
        if (aborted || !answer) return;
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
        if (phase === "signal") { phase = "connect"; answeredAt = Date.now() - startedAt; }
      } catch {
        if (!aborted) scheduleReconnect("fetch-threw");
      }
    })();

    return () => {
      aborted = true;
      clearWatchdog();
      clearGrace(); // a pending grace timer must not fire after teardown
      clearStall(); // likewise the stall re-check
      clearEnd();   // and a pending track-end re-check
      ctrl.abort();
      clearRetry();
      pc.close();
      if (pcRef.current === pc) pcRef.current = null;
    };
  }, [mode, rendition, nonce, tryPlay, revealControls, playbackHealthy, transportRestored]);

  // HLS fallback (the embed's "regular"/compatibility mode). Runs only in hls
  // mode: plays stream.place's getLivePlaylist m3u8 over plain HTTPS, which works
  // where WebRTC is blocked. Endpoint is CORS-open + takes the public handle, so
  // no proxy. hls.js is dynamically imported → only fetched when fallback fires.
  useEffect(() => {
    if (mode !== "hls" || !transportRestored) return;
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    let hls: { destroy: () => void } | null = null;
    let recoveredOnce = false;
    let playedOnce = false;
    const url = hlsPlaylistUrl(channel);
    // A fatal HLS error does not call onFallback(), which is wired to the viewer's
    // PERSISTED player preference — one blip would not just demote the session,
    // it would rewrite their setting and they would never come back. It stops here
    // and the viewer chooses. See NO AUTOMATIC DEMOTION at the top of this file.
    // Same rule as the WebRTC path: a fatal hls.js error does not necessarily mean
    // the viewer's picture stopped (a variant can fail while the buffer plays on),
    // so never paint the error panel over advancing frames — hold and re-check.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
    // Bounded: fifteen seconds of advancing frames after a fatal error is not a
    // failure — stand down. Unbounded, it ticked every 3 s under working video
    // for as long as the tab lived. But hls.js raises a fatal error ONCE, and a
    // buffer can outlast this window and then run dry with no further event —
    // so standing down arms the element's own `waiting` (one shot, removed on
    // teardown) to re-enter the judgement when the picture finally stops.
    const MAX_GIVE_UP_RECHECKS = 5;
    let giveUpRechecks = 0;
    const onPlaying = () => { if (!cancelled) { playedOnce = true; clearStall(); giveUpRechecks = 0; retryCountRef.current = 0; setStatus("playing"); } };
    const onWaiting = () => { giveUp(); };
    // Declare the stop, having first asked WHY. stream.place answers
    // 404 {"message":"StreamNotLive"} once the broadcast is over, and reporting
    // that as "Playback isn't reachable from this network right now" blames the
    // viewer's network for the stream ending — exactly the lie the ended/failed
    // split exists to prevent, which held on WebRTC and not here. One probe, on
    // the failure path only, and it serves the native path too (which cannot see
    // a status code any other way).
    const declareStop = async () => {
      let status: number | null = null;
      try {
        const res = await fetch(url, { cache: "no-store" });
        status = res.status;
      } catch { /* stays null → "failed", the safe answer */ }
      if (cancelled) return;  // the effect may have torn down during the probe
      setStatus(hlsFailureKind(status));
    };
    const giveUp = () => {
      if (cancelled) return;
      if (!playbackHealthy()) { void declareStop(); return; }
      if (stallTimer) return;
      if (giveUpRechecks >= MAX_GIVE_UP_RECHECKS) {
        giveUpRechecks = 0;
        v.addEventListener("waiting", onWaiting, { once: true });
        return;
      }
      giveUpRechecks += 1;
      stallTimer = setTimeout(() => { stallTimer = null; giveUp(); }, 3000);
    };
    const onError = () => { giveUp(); };
    // The playlist ran out (its end tag, on either implementation): the element
    // stops with no error. Unheard, the picture froze under "Paused"; judged, the
    // probe tells an ended stream from one that is still live.
    const onEnded = () => { giveUp(); };
    const start = async () => {
      setStatus("connecting");
      v.srcObject = null; // release any WebRTC stream before attaching a src
      v.addEventListener("playing", onPlaying);
      v.addEventListener("ended", onEnded);
      // THE ORDER IS THE FIX. Chromium answers canPlayType with "maybe", so
      // asking it first would send every Chromium viewer down the native branch
      // and never import hls.js. The decision lives in
      // app/lib/hlsPath.ts so it can be tested; a source scan of this file
      // cannot see what a browser returns.
      //
      // Accepted cost: a Safari/iOS viewer fetches the hls.js chunk and is then
      // told to use the native path. That is a one-time fetch on a transport the
      // viewer opted into by clicking — never on the default path. Re-deriving
      // MSE support ourselves would duplicate hls.js's codec checks and drift.
      const Hls = (await import("hls.js")).default;
      if (cancelled) return;
      const impl = chooseHlsImpl({
        mseSupported: Hls.isSupported(),
        nativeSupported: !!v.canPlayType("application/vnd.apple.mpegurl"),
      });
      if (impl === "none") { giveUp(); return; }
      if (impl === "native") {
        // Safari / iOS — the element plays the playlist itself, no library.
        // Reachable ONLY because media-src allows stream.place (next.config.ts);
        // playerApiReach.test.ts is what keeps that true.
        v.addEventListener("error", onError);
        v.src = url;
        tryPlay();
        return;
      }
      // The configs live in app/lib/hlsConfig.ts so the tests can construct them.
      const instance = new Hls(hlsConfigFor(smooth));
      instance.on(Hls.Events.MANIFEST_PARSED, () => { if (!cancelled) tryPlay(); });
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || cancelled) return;
        // A media error is often recoverable in place (decode glitch) — try once
        // before giving up. Network / other fatal errors, or a second media
        // error, mean HLS can't play stream.place → surface the failed overlay
        // (the embed is one of its BUTTONS — never an automatic fallback).
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredOnce) {
          recoveredOnce = true;
          instance.recoverMediaError();
          return;
        }
        giveUp();
      });
      instance.loadSource(url);
      instance.attachMedia(v);
      hls = instance;
    };
    // hls.js cannot fail silently here: a rejected import (a stale tab across a
    // deploy — the chunk hash 404s) or a manifest that never yields `playing`
    // would otherwise leave "Connecting…" up forever. Same window as the WebRTC watchdog;
    // giveUp() still defers to advancing frames.
    start().catch(() => { if (!cancelled) giveUp(); });
    const watchdog = setTimeout(() => {
      if (!cancelled && !playedOnce) giveUp();
    }, CONNECT_TIMEOUT_MS);
    return () => {
      cancelled = true;
      clearTimeout(watchdog);
      clearStall();
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("error", onError);
      v.removeEventListener("ended", onEnded);
      if (hls) hls.destroy();
      try { v.removeAttribute("src"); v.load(); } catch { /* ignore */ }
    };
  }, [mode, channel, nonce, tryPlay, playbackHealthy, transportRestored, smooth]);

  // Close the rendition menu on outside press or Escape. The shared hook's
  // contains() check is what lets the toggle button live on onClick: the old
  // hand-rolled window-mousedown listener fired on the toggle itself, which is
  // why the toggle had to be onMouseDown+stopPropagation — and onMouseDown is
  // unreachable from a keyboard (playerKeyboard.test.ts).
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useOutsideClick(menuWrapRef, closeMenu, { enabled: menuOpen, escape: true });

  // MediaSession — lock-screen / notification transport + keeps audio alive in
  // the background (PWA / screen-off), which is the whole point of audio-only.
  // Play goes through tryPlay so a refusal (the browser wants a gesture)
  // surfaces the tap-to-play overlay instead of clearing `paused` over a
  // still-paused video; pause is unconditional.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({
        title: `${siteName()} — Live`,
        artist: "Streamplace",
        artwork: [{ src: siteIcon("icon.png"), sizes: "512x512", type: "image/png" }],
      });
      ms.setActionHandler("play", tryPlay);
      ms.setActionHandler("pause", () => { videoRef.current?.pause(); setPaused(true); });
    } catch {
      // Some engines throw on unsupported actions — ignore.
    }
    return () => {
      try {
        ms.setActionHandler("play", null);
        ms.setActionHandler("pause", null);
        ms.metadata = null;
        ms.playbackState = "none";
      } catch { /* ignore */ }
    };
  }, [tryPlay]);

  useEffect(() => {
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      navigator.mediaSession.playbackState = paused ? "paused" : "playing";
    }
  }, [paused]);

  // Poll getStats while the diagnostics panel is open — surfaces packet loss /
  // jitter so "is the audio crackle the network or the source?" is answerable.
  // Gated on showStats so there's zero overhead unless a viewer opens it, and on
  // WebRTC mode like the panel and its toggle (getStats needs the peer
  // connection; the poll must not outlive a switch to HLS).
  useEffect(() => {
    if (status !== "playing" || !showStats || mode !== "webrtc") return;
    let cancelled = false;
    statsPrevRef.current = null;
    const poll = async () => {
      const pc = pcRef.current;
      if (!pc || cancelled) return;
      try {
        const reports = await pc.getStats();
        if (cancelled) return;
        const audio = { lost: 0, recv: 0, jitter: 0 };
        const video = { lost: 0, recv: 0 };
        let bytes = 0;
        let resolution: string | null = null;
        reports.forEach((r) => {
          if (r.type !== "inbound-rtp") return;
          bytes += r.bytesReceived ?? 0;
          if (r.kind === "audio") {
            audio.lost = r.packetsLost ?? 0; audio.recv = r.packetsReceived ?? 0; audio.jitter = r.jitter ?? 0;
          } else if (r.kind === "video") {
            video.lost = r.packetsLost ?? 0; video.recv = r.packetsReceived ?? 0;
            if (r.frameWidth && r.frameHeight) resolution = `${r.frameWidth}×${r.frameHeight}`;
          }
        });
        const sample: StatsSample = {
          t: performance.now(),
          audioLost: audio.lost, audioRecv: audio.recv,
          videoLost: video.lost, videoRecv: video.recv,
          bytes, jitter: audio.jitter, resolution,
        };
        const prev = statsPrevRef.current;
        statsPrevRef.current = sample;
        // First sample only seeds the baseline; the panel shows "Measuring…" until
        // the second — never a sample from another peer connection.
        if (!prev) { setStats(null); return; }
        // Derivation + health policy live in lib/playerStats.ts (unit-tested).
        if (!cancelled) setStats(derivePlayerStats(prev, sample));
      } catch { /* getStats can throw on a closing pc — ignore */ }
    };
    poll();
    const id = setInterval(poll, STATS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [status, showStats, mode]);

  // Cleanup the hide timer on unmount.
  useEffect(() => () => { if (hideRef.current) clearTimeout(hideRef.current); }, []);

  // Whether the viewer can actually hear anything — muted OR the slider at zero.
  // The icon must reflect this, not just `muted`, or a zeroed slider shows a
  // speaker icon over silence.
  const silent = isSilent(muted, volume);

  // Device-health telemetry: what the viewer hears, and what video
  // actually arrived and decoded — read on the reporter's own timer, never on a hot path.
  // MEASUREMENT ONLY: nothing here changes playback.
  useEffect(() => { setPlayerAudio({ silent, vol: volume }); }, [silent, volume]);
  useEffect(() => registerVideoProbe(async () => {
    if (mode === "hls") return videoRef.current ? readVideoElement(videoRef.current) : null;
    const pc = pcRef.current;
    return pc ? readInboundVideo(await pc.getStats()) : null;
  }), [mode]);

  const toggleMute = () => {
    const v = videoRef.current;
    const next = !silent;
    setMuted(next);
    // Unmuting from a slider the viewer dragged to zero has to restore a level,
    // otherwise the button appears to do nothing. Falls back to full, matching
    // the element default.
    let vol = volume;
    if (!next) { vol = unmuteVolume(volume, lastVolRef.current); if (vol !== volume) { setVolume(vol); lsSet(OWN_VOLUME_KEY, String(vol)); } }
    if (v) { v.muted = next; v.volume = vol; if (!next) v.play().catch(() => {}); }
    setNeedsTap(false);
  };

  // Slider. Dragging up from silence is an unmute GESTURE — it's a real user
  // interaction, so play() is allowed here even though autoplay was blocked.
  // Without this, a muted-by-policy viewer drags the slider up and still hears
  // nothing, which reads as a broken control.
  const applyVolume = (next: number) => {
    const vol = clampVolume(next);
    setVolume(vol);
    if (vol > 0) lastVolRef.current = vol;
    lsSet(OWN_VOLUME_KEY, String(vol));
    const v = videoRef.current;
    if (!v) return;
    v.volume = vol;
    if (vol > 0 && muted) {
      setMuted(false);
      v.muted = false;
      v.play().catch(() => {});
      setNeedsTap(false);
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play().then(() => setPaused(false)).catch(() => setNeedsTap(true)); }
    else { v.pause(); setPaused(true); }
  };

  const enterPiP = () => {
    const v = videoRef.current;
    if (!v) return;
    if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return; }
    if (document.pictureInPictureEnabled) v.requestPictureInPicture().catch(() => {});
  };

  // Through the helper: engines return a Promise, nothing, or only have webkit names.
  const onFullscreen = () => { void toggleFullscreen(document, containerRef.current, videoRef.current); };

  // Reload the current mode (jump-to-live / reconnect button).
  const reconnect = () => {
    setNeedsTap(false);
    retryCountRef.current = 0; // manual retry — clear the bounded-reconnect count
    setOfferEscapes(false);
    setStatus("connecting");
    setNonce((n) => n + 1);
  };

  // Restart from the low-latency WebRTC path — from the failed/ended overlays or
  // the WebRTC/HLS toggle in the control bar. `everConnectedRef` is kept: it
  // records whether THIS session's network can do WebRTC at all, and a manual
  // retry does not change that answer.
  const retryLowLatency = () => {
    setNeedsTap(false);
    retryCountRef.current = 0;
    setOfferEscapes(false);
    setStatus("connecting");
    setMode("webrtc");
    lsSet(TRANSPORT_KEY, "webrtc");
    setNonce((n) => n + 1);
  };

  // Switch to the HLS (compatibility) path — the control-bar toggle or the
  // failed overlay's option. Like every mode change, a viewer's deliberate
  // choice; the control-bar toggle is the way back. Persisted for the same
  // reason: a viewer on a network that blocks WebRTC should not have to re-pick
  // this on every reload and every source switch.
  const switchToHls = () => {
    setNeedsTap(false);
    setShowStats(false); // the panel is WebRTC-only; don't bring it back unasked
    retryCountRef.current = 0;
    setOfferEscapes(false);
    setStatus("connecting");
    setMode("hls");
    lsSet(TRANSPORT_KEY, "hls");
    setNonce((n) => n + 1);
  };

  // In hls mode we always have a video surface (single stream), so the WebRTC
  // audio-only rendition placeholder / control-hiding doesn't apply.
  const audioOnly = mode === "webrtc" && activeRendition.audioOnly;
  const showControls = controlsVisible || menuOpen || needsTap || status !== "playing";

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 bg-black select-none"
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onTouchStart={revealControls}
      onPointerLeave={(e) => {
        // Mouse left the player (not a touch) — hide immediately.
        if (e.pointerType === "mouse") { if (hideRef.current) clearTimeout(hideRef.current); setControlsVisible(false); }
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        // @ts-expect-error — Safari-only hint so PiP can auto-engage on tab away.
        autoPictureInPicture="true"
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        // Ground truth for playbackHealthy(). timeupdate fires ~4x/sec ONLY while
        // frames are actually advancing, which is the one signal that can't be
        // contradicted by connection-state bookkeeping.
        onTimeUpdate={() => { lastProgressRef.current = Date.now(); }}
        onPointerUp={(e) => {
          // Click-to-pause on desktop only; on touch a tap reveals the controls
          // (handled on the container), matching how standard players behave.
          // Tap-to-play, when it is needed, is the button that covers the video.
          if (e.pointerType === "mouse" && status === "playing") togglePlay();
        }}
        className="absolute inset-0 w-full h-full object-contain bg-black"
      />

      {/* Audio-only: no video track — show a station-style placeholder. */}
      {audioOnly && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <WaveSine size={44} weight="duotone" className="text-muted" />
          <span className="text-xs font-medium text-secondary">Audio only</span>
        </div>
      )}

      {/* Tap-to-play (autoplay blocked) */}
      {needsTap && (
        <button
          type="button"
          onClick={tryPlay}
          className="absolute inset-0 flex items-center justify-center bg-scrim-strong"
        >
          <span className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-3 border border-edge-strong text-sm font-semibold text-strong">
            <MonitorPlay size={16} weight="fill" /> Tap to play
          </span>
        </button>
      )}

      {/* Reconnecting — the picture dropped and the player is getting it
          back by itself (WebRTC only: HLS recovers inside hls.js). Covers the
          frozen last frame, so the viewer can tell a dropout from a stuck
          picture. After the old budget it also offers the two escapes, and
          keeps trying underneath them. */}
      {status === "reconnecting" && mode === "webrtc" && !needsTap && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-scrim-heavy px-4 text-center">
          <span className="flex items-center gap-2 text-sm font-semibold text-body">
            <ArrowClockwise size={15} weight="bold" className="animate-spin" /> Reconnecting…
          </span>
          {offerEscapes && (
            <>
              <span className="text-xs text-secondary max-w-[36ch]">
                Still trying. If it doesn&apos;t come back, Compatibility mode often works on this network.
              </span>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={switchToHls}
                  className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-3 border border-edge-strong text-sm font-semibold text-strong hover:bg-surface-4 transition-colors"
                >
                  <Pulse size={15} weight="bold" /> Compatibility mode
                </button>
                <button
                  type="button"
                  onClick={onFallback}
                  className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-body-dim hover:text-strong transition-colors"
                >
                  <MonitorPlay size={15} weight="bold" /> Use the embed
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Busy — the relay answered 429. Not a failure: the player waits out
          its Retry-After and tries again by itself, so the viewer is told and
          asked for nothing. Compatibility mode does not use the relay, and the
          embed is the other way in, so both are one click while it waits. */}
      {status === "busy" && mode === "webrtc" && !needsTap && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-scrim-heavy px-4 text-center">
          <span className="flex items-center gap-2 text-sm font-semibold text-body">
            <ArrowClockwise size={15} weight="bold" className="animate-spin" /> The stream is busy
          </span>
          <span className="text-xs text-secondary max-w-[36ch]">Trying again in a few seconds.</span>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={switchToHls}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-3 border border-edge-strong text-sm font-semibold text-strong hover:bg-surface-4 transition-colors"
            >
              <Pulse size={15} weight="bold" /> Compatibility mode
            </button>
            <button
              type="button"
              onClick={onFallback}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-body-dim hover:text-strong transition-colors"
            >
              <MonitorPlay size={15} weight="bold" /> Use the embed
            </button>
          </div>
        </div>
      )}

      {/* Stream ended — compatibility mode only: the HLS manifest answered 404
          (hlsFailureKind). The WebRTC path never decides this: a track the
          node ends is a reconnect, and the site's liveness unmounts the player
          when the stream is really over. Sticky until the viewer asks for a
          fresh negotiation.
          `reconnect`, NOT `retryLowLatency`: forcing WebRTC would move a
          viewer watching in compatibility mode when the stream ended off the
          only transport that works for them. */}
      {status === "ended" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-scrim-heavy">
          <span className="text-sm font-semibold text-body">Stream has ended</span>
          <button
            type="button"
            onClick={reconnect}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-3 border border-edge-strong text-sm font-semibold text-strong hover:bg-surface-4 transition-colors"
          >
            <ArrowClockwise size={15} weight="bold" /> Check again
          </button>
        </div>
      )}

      {/* Couldn't establish playback. Replaces the automatic demotion: same three
          escapes an automatic ladder would take on the viewer's behalf, offered
          as a choice. Copy names the actual failure rather than claiming the stream
          ended — the viewer can see chat is still moving. */}
      {status === "failed" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-scrim-heavy px-4 text-center">
          <span className="text-sm font-semibold text-body">
            {mode === "hls" ? "Can't reach the stream" : "Can't connect to the low-latency stream"}
          </span>
          <span className="text-xs text-secondary max-w-[36ch]">
            {mode === "hls"
              ? "Playback isn't reachable from this network right now."
              : "Some networks block the low-latency transport. Compatibility mode usually works."}
          </span>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {mode === "webrtc" && (
              <button
                type="button"
                onClick={switchToHls}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-3 border border-edge-strong text-sm font-semibold text-strong hover:bg-surface-4 transition-colors"
              >
                <Pulse size={15} weight="bold" /> Compatibility mode
              </button>
            )}
            {/* Try again retries the transport the viewer is ON. Calling
                retryLowLatency in compatibility mode would silently promote the
                viewer back to WebRTC — and on a network that blocks it, close a
                loop whose only exit is "Use the embed". In webrtc mode
                retryLowLatency IS retrying the current transport. */}
            <button
              type="button"
              onClick={mode === "hls" ? reconnect : retryLowLatency}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-3 border border-edge-strong text-sm font-semibold text-strong hover:bg-surface-4 transition-colors"
            >
              <ArrowClockwise size={15} weight="bold" /> Try again
            </button>
            {/* Changing transport is still one click from here — it is just
                NAMED now, instead of hiding inside "Try again". */}
            {mode === "hls" && (
              <button
                type="button"
                onClick={retryLowLatency}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-surface-3 border border-edge-strong text-sm font-semibold text-strong hover:bg-surface-4 transition-colors"
              >
                <Pulse size={15} weight="bold" /> Low-latency
              </button>
            )}
            <button
              type="button"
              onClick={onFallback}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-body-dim hover:text-strong transition-colors"
            >
              <MonitorPlay size={15} weight="bold" /> Use the embed
            </button>
          </div>
        </div>
      )}

      {/* Connection diagnostics (toggled from the control bar; WebRTC only —
          getStats needs the peer connection) */}
      {showStats && status === "playing" && mode === "webrtc" && (
        <div className="absolute top-9 left-2 rounded-lg bg-scrim-heavy px-3 py-2 text-2xs font-medium leading-relaxed text-body-dim pointer-events-none">
          <div className="flex items-center gap-1.5 text-strong">
            <span className={`w-1.5 h-1.5 rounded-full ${
              stats?.health === "good" ? "bg-emerald-400"
                : stats?.health === "ok" ? "bg-amber-400"
                : stats ? "bg-red-500" : "bg-control-strong"
            }`} />
            {stats ? (stats.health === "good" ? "Good" : stats.health === "ok" ? "Fair" : "Poor") : "Measuring…"} connection
          </div>
          <div>audio loss {stats ? stats.audioLossPct.toFixed(1) : "—"}% · jitter {stats ? Math.round(stats.audioJitterMs) : "—"} ms</div>
          <div>video loss {stats ? stats.videoLossPct.toFixed(1) : "—"}% · {stats?.resolution ?? "—"}</div>
          <div>{stats ? Math.round(stats.bitrateKbps).toLocaleString() : "—"} kbps</div>
        </div>
      )}

      {/* Status pill — top-left */}
      <div
        className={`absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-scrim-strong text-2xs font-semibold pointer-events-none transition-opacity duration-(--anim-default) ${
          showControls ? "opacity-100" : "opacity-0"
        }`}
      >
        {status === "playing" && !paused ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-strong">LIVE</span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-body">
              {paused ? "Paused" : status === "reconnecting" ? "Reconnecting…" : status === "busy" ? "Busy" : status === "ended" ? "Ended" : "Connecting…"}
            </span>
          </>
        )}
      </div>

      {/* Control bar — fades with the auto-hide timer (pointer/touch reveal).
          The has-[:focus-visible] pair is the KEYBOARD reveal: the buttons stay
          in the tab order while hidden, so focus arriving must bring the bar
          back — and `:focus-visible`, not `focus-within`, so a mouse click on a
          control (which focuses it) doesn't pin the bar open past the auto-hide
          (playerKeyboard.test.ts). */}
      <div
        className={`absolute bottom-0 inset-x-0 flex items-center gap-1 px-2 py-1.5 bg-gradient-to-t from-scrim-heavy to-transparent transition-opacity duration-(--anim-default) has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto ${
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <button
          type="button"
          onClick={togglePlay}
          title={paused ? "Play" : "Pause"}
          className="flex items-center justify-center w-8 h-8 rounded text-strong/90 hover:bg-surface-3 transition-colors"
        >
          {paused ? <Play size={16} weight="fill" /> : <Pause size={16} weight="fill" />}
        </button>

        <button
          type="button"
          onClick={toggleMute}
          title={silent ? "Unmute" : "Mute"}
          className="flex items-center justify-center w-8 h-8 rounded text-strong/90 hover:bg-surface-3 transition-colors"
        >
          {silent ? <SpeakerSlash size={16} weight="fill" /> : <SpeakerHigh size={16} weight="fill" />}
        </button>

        {/* Volume. Shows 0 while muted so the control never contradicts what the
            viewer is hearing, but the underlying volume is preserved — unmuting
            returns to the level they set rather than to silence. */}
        <input
          type="range"
          min={0}
          max={100}
          value={sliderPercent(muted, volume)}
          onChange={(e) => applyVolume(Number(e.target.value) / 100)}
          title="Volume"
          aria-label="Volume"
          className="w-16 shrink-0 cursor-pointer"
          style={{ accentColor: "var(--accent)" }}
        />

        <button
          type="button"
          onClick={reconnect}
          title="Jump to live / reconnect"
          className="flex items-center justify-center w-8 h-8 rounded text-strong/90 hover:bg-surface-3 transition-colors"
        >
          <ArrowClockwise size={15} weight="bold" />
        </button>

        {/* Manual WebRTC ⇄ HLS toggle — the transport is always the viewer's
            pick; there is no automatic fallback (NO AUTOMATIC DEMOTION above).
            WebRTC = low latency; HLS = compatibility (WebRTC-hostile networks). */}
        <button
          type="button"
          onClick={mode === "webrtc" ? switchToHls : retryLowLatency}
          title={mode === "webrtc" ? "Switch to HLS (compatibility mode)" : "Switch to low-latency (WebRTC)"}
          className="flex items-center justify-center px-2 h-8 rounded text-2xs font-semibold text-strong/90 hover:bg-surface-3 transition-colors"
        >
          {mode === "webrtc" ? "HLS" : "Low-latency"}
        </button>

        {mode === "webrtc" && (
          <button
            type="button"
            onClick={() => setShowStats((s) => !s)}
            title="Connection stats"
            className={`flex items-center justify-center w-8 h-8 rounded transition-colors ${
              showStats ? "bg-surface-3 text-strong" : "text-strong/90 hover:bg-surface-3"
            }`}
          >
            <Pulse size={15} weight="bold" />
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* Rendition (quality / audio-only) — WebRTC only; HLS is a single stream. */}
          {mode === "webrtc" && (
          <div ref={menuWrapRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              title="Quality"
              className="flex items-center gap-1 px-2 h-8 rounded text-xs font-medium text-strong/90 hover:bg-surface-3 transition-colors"
            >
              {activeRendition.label}
              <CaretDown size={11} weight="bold" />
            </button>
            {/* Not role=menu ON PURPOSE: that role promises arrow-key traversal
                to a SR user, and these are plain tab-reachable buttons (inline,
                not portaled — Tab walks them naturally). aria-pressed carries
                the selection that was otherwise only a background color. */}
            {menuOpen && (
              <div className="absolute bottom-full right-0 mb-1 min-w-[9rem] rounded-lg glass overflow-hidden z-10">
                {RENDITIONS.map((r) => (
                  <button
                    key={r.name}
                    type="button"
                    onClick={() => { setRendition(r.name); setMenuOpen(false); }}
                    aria-pressed={r.name === rendition}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors ${
                      r.name === rendition ? "bg-surface-3 text-strong" : "text-body-dim hover:bg-surface-2"
                    }`}
                  >
                    {r.audioOnly && <WaveSine size={13} weight="bold" />}
                    {r.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          )}

          {/* No video surface in audio-only — PiP / fullscreen would pop out a
              black frame, so hide them for that rendition. */}
          {!audioOnly && pipOk && (
            <button
              type="button"
              onClick={enterPiP}
              title="Picture in picture"
              className="flex items-center justify-center w-8 h-8 rounded text-strong/90 hover:bg-surface-3 transition-colors"
            >
              <PictureInPicture size={15} weight="bold" />
            </button>
          )}

          {!audioOnly && (
            <button
              type="button"
              onClick={onFullscreen}
              title="Fullscreen"
              className="flex items-center justify-center w-8 h-8 rounded text-strong/90 hover:bg-surface-3 transition-colors"
            >
              <CornersOut size={15} weight="bold" />
            </button>
          )}

          <button
            type="button"
            onClick={onFallback}
            title="Switch back to the Streamplace embed"
            className="px-2 h-8 rounded text-2xs font-semibold text-body-dim hover:text-strong hover:bg-surface-3 transition-colors"
          >
            Embed
          </button>
        </div>
      </div>
    </div>
  );
}

// Resolve local ICE candidates before sending the offer (WHEP is non-trickle, so
// whatever candidates are gathered by now are all the server ever sees): resolve
// as soon as gathering completes, or after a cap, whichever first. The cap is
// generous enough for a STUN server-reflexive candidate to land on a slow mobile
// radio — desktop hits "complete" almost instantly and resolves early anyway.
function waitForIce(pc: RTCPeerConnection): Promise<RTCSessionDescription | null> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(pc.localDescription); return; }
    const t = setTimeout(() => resolve(pc.localDescription), ICE_GATHER_CAP_MS);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(pc.localDescription); }
    });
  });
}
