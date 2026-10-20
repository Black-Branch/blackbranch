// @parked the liveness probe is sound and unit-tested (livenessPolicy.ts); kept for a possible re-wiring, not by accident.
// UNWIRED. Nothing calls this hook. It was the last rung of an automatic
// stream.place fallback ladder — it switched a viewer off the legacy embed and
// onto YouTube when stream.place's output looked down — and automatic
// demotions strand viewers at the bottom with no way back (see the NO
// AUTOMATIC DEMOTION note in StreamplaceThinPlayer.tsx).
//
// If it is ever re-wired, it must NOT write a persisted preference — that is
// the actual defect such a ladder has.
import { useEffect, useRef } from "react";
import { classifyProbe, applyVerdict, type ProbeOutcome } from "./livenessPolicy";

// stream.place's HLS master playlist (CORS-open, takes the public channel handle).
// Same endpoint StreamplaceThinPlayer's HLS fallback points at — a plain GET that
// returns the m3u8 while the stream.place RTMP output is live, and fails (non-2xx
// or network error) when that output is down. So it doubles as a liveness probe.
const playlistUrl = (channel: string) =>
  `https://stream.place/xrpc/place.stream.playback.getLivePlaylist?streamer=${encodeURIComponent(channel)}`;

const POLL_MS = 6000;
const FAIL_THRESHOLD = 3; // consecutive failures before we declare stream.place down
// 4s was too tight for mobile: a slow-but-working connection timed out three
// times in 18s and switched the viewer off a healthy source. The probe is not
// latency-sensitive — only its verdict matters — so give it room.
const PROBE_TIMEOUT_MS = 9000;

// Watch stream.place's own playlist endpoint and fire `onDown` once it has failed
// FAIL_THRESHOLD times in a row. Used to swap a viewer off the legacy stream.place
// embed and onto YouTube when stream.place's output drops: stream.place and YouTube
// are two independent RTMP outputs from OBS, so if stream.place goes down YouTube is
// typically unaffected — and the opaque cross-origin embed can't report its own
// failure, so we probe the source directly instead.
//
// Only enable this while the legacy sp embed is the active live player (not the
// in-house thin player, which does its own WHEP→HLS detection). `onDown` should be
// idempotent/terminal (e.g. switch the source to YouTube once).
export function useStreamplaceLiveness(
  enabled: boolean,
  channel: string,
  onDown: () => void,
) {
  // Keep onDown current without making it a poll dep (it's recreated each render).
  const onDownRef = useRef(onDown);
  useEffect(() => { onDownRef.current = onDown; }, [onDown]);

  useEffect(() => {
    if (!enabled || !channel) return;
    let cancelled = false;
    let fails = 0;
    let fired = false;

    const probe = async () => {
      if (cancelled) return;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      let outcome: ProbeOutcome;
      try {
        const r = await fetch(playlistUrl(channel), { cache: "no-store", signal: ctrl.signal });
        outcome = { kind: "http", ok: r.ok };
      } catch {
        // No response at all — could be stream.place OR could be us. The policy
        // decides; see lib/livenessPolicy.ts.
        outcome = { kind: "error" };
      } finally {
        clearTimeout(t);
      }
      if (cancelled) return;

      // A failure we cannot attribute to the remote side is DISCARDED, not
      // counted: switching a viewer off a healthy source has no recovery path
      // (`fired` is terminal), whereas a genuinely dead output keeps failing and
      // still trips the threshold a beat later.
      const verdict = classifyProbe(outcome, {
        online: typeof navigator === "undefined" ? true : navigator.onLine,
        hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
      });
      if (fired) return;
      const next = applyVerdict(verdict, fails, FAIL_THRESHOLD);
      fails = next.fails;
      if (next.declareDown) {
        fired = true; // fire once; the caller switches source and unmounts us
        onDownRef.current();
      }
    };

    probe();
    const id = setInterval(probe, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, channel]);
}
