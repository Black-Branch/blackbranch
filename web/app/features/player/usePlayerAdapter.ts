"use client";
// Joins an adapter to the app: audio continuity, drift correction, and the two
// failure signals. It owns no policy — liveEdge.ts decides when to correct, and
// playerVolume.ts owns what a volume means.
//
// INERT WITHOUT AN ADAPTER. `create` is null whenever the platform's API
// script did not load, and then this hook does nothing at all. That is the
// additive rule: an ad blocker costs a viewer drift correction, never playback.
//
// IT PERSISTS EXACTLY ONE THING: this source's own volume (volumeKeyFor(source) — one key
// per player), and only a level the viewer evidently set. No error path here moves the
// viewer to another source or writes a source preference — an auto-demotion that
// writes a PERSISTED preference strands viewers for a whole session.
import { useCallback, useEffect, useRef, useState } from "react";
import { liveEdgeAction } from "@/app/lib/liveEdge";
import {
  clampVolume, levelToApplyAtReady, migrateLegacyVolume, restorableVolume, shouldPersistAdapterRead, volumeKeyFor,
} from "@/app/lib/playerVolume";
import { lsGet, lsRemove, lsSet } from "@/app/lib/safeLocalStorage";
import { registerAudioProbe } from "@/app/lib/playerHealth";
import type { AdapterSource, PlayerAdapter, PlayerEvent } from "@/app/lib/playerAdapter";

export type UsePlayerAdapterOpts = {
  source: AdapterSource;
  /** Builds the adapter. NULL when the platform API is unavailable. */
  create: (() => PlayerAdapter | null) | null;
  /** Re-create when this changes — a new channel, a new video id. */
  key: string;
};

export type UsePlayerAdapterResult = {
  blocked: boolean;
  failure: { code: number; reason: string } | null;
  /** THIS SOURCE's own liveness, or null when it has not said. Never app-wide. */
  playerLiveHint: boolean | null;
  dismissFailure: () => void;
  play: () => void;
};

export function usePlayerAdapter({ source, create, key }: UsePlayerAdapterOpts): UsePlayerAdapterResult {
  const adapterRef = useRef<PlayerAdapter | null>(null);
  const mountedAtRef = useRef(0);
  const hiddenAtRef = useRef<number | null>(null);
  const driftAtHideRef = useRef<number | null>(null);
  const viewerSeekedRef = useRef(false);

  const [blocked, setBlocked] = useState(false);
  const [failure, setFailure] = useState<{ code: number; reason: string } | null>(null);
  const [playerLiveHint, setPlayerLiveHint] = useState<boolean | null>(null);

  useEffect(() => {
    if (!create) return;
    const adapter = create();
    if (!adapter) return;
    adapterRef.current = adapter;
    mountedAtRef.current = Date.now();
    viewerSeekedRef.current = false;
    // Gates captureVolume below. A pre-ready getVolume() can legally return
    // NaN/undefined — clampVolume(NaN) is 0, a perfectly legal persisted
    // value — so a read taken before the player's handshake could write
    // silence. Only a player that has actually said "ready" may persist.
    let readySeen = false;
    // The level applied (or found) at ready — the baseline a later read must
    // differ from before it counts as the VIEWER's change.
    let appliedAtReady: number | null = null;
    const volumeKey = volumeKeyFor(source);

    // Persists the iframe's level ONLY when the viewer evidently set it:
    // post-ready, unmuted, above the floor, and moved since ready
    // (shouldPersistAdapterRead). Writing whatever the iframe reports on every
    // event would let one embed's 3% reach every player. Called on every
    // event below AND at teardown: teardown's own capture does not run on a
    // tab close, so a level set and then closed would otherwise be lost.
    const captureVolume = () => {
      if (!readySeen) return;
      const v = adapter.readVolume();
      if (shouldPersistAdapterRead(v, appliedAtReady) && v) lsSet(volumeKey, String(clampVolume(v.volume)));
    };

    const off = adapter.on((e: PlayerEvent) => {
      if (e.kind === "ready") {
        readySeen = true;
        // The one honest moment to apply our persisted level: before this,
        // the player has not finished its handshake and a setVolume() call
        // is silently lost. Level only. Restoring a level must
        // NEVER unmute: muted is how the player satisfies autoplay policy,
        // and clearing it here would turn a working stream into a refused
        // one (playerVolume.ts, rule 1).
        // Each embed keeps its OWN stored volume, so with nothing of
        // ours to restore, an embed found at a poisoned level is set back to
        // the default here — stopping our bad writes alone would not bring a
        // phone's sound back (levelToApplyAtReady).
        migrateLegacyVolume(lsGet, lsSet, lsRemove);
        const embed = adapter.readVolume();
        const level = levelToApplyAtReady(restorableVolume(lsGet(volumeKey)), embed);
        if (level !== null) adapter.setVolume(clampVolume(level));
        appliedAtReady = level ?? (embed ? clampVolume(embed.volume) : null);
      }
      else if (e.kind === "blocked") setBlocked(true);
      else if (e.kind === "error") setFailure({ code: e.code, reason: e.reason });
      else if (e.kind === "online") setPlayerLiveHint(true);
      else if (e.kind === "offline") setPlayerLiveHint(false);
      else if (e.kind === "seekedBack") viewerSeekedRef.current = true;
      captureVolume();
    });

    // Drift is sampled at the two visibility EDGES and nowhere else. Polling it
    // would be both waste and a temptation to correct mid-watch, which is ruled
    // out: the trigger is returning from a hidden tab.
    const onVisibility = () => {
      const a = adapterRef.current;
      if (!a) return;
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        driftAtHideRef.current = a.drift();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (hiddenAt === null) return;
      const action = liveEdgeAction({
        driftAtHide: driftAtHideRef.current,
        driftOnReturn: a.drift(),
        hiddenMs: Date.now() - hiddenAt,
        sinceLoadMs: Date.now() - mountedAtRef.current,
        viewerSeeked: viewerSeekedRef.current,
        lever: a.capabilities.liveEdge,
      });
      if (action.kind !== "none") a.goLive();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Device-health telemetry: the reporter asks what this player sounds like on its
    // own timer. Unreadable stays unknown (null) — never guessed. Measurement only.
    const offProbe = registerAudioProbe(() => {
      if (!readySeen) return null;
      const v = adapter.readVolume();
      return v ? { silent: v.muted || v.volume === 0, vol: clampVolume(v.volume) } : null;
    });

    return () => {
      offProbe();
      document.removeEventListener("visibilitychange", onVisibility);
      // Belt-and-suspenders: every event above already captures the level,
      // but a viewer's LAST change before navigating away may never produce
      // another player event, so cleanup captures once more here too.
      captureVolume();
      off();
      adapter.destroy();
      adapterRef.current = null;
    };
  }, [create, key, source]);

  return {
    blocked,
    failure,
    playerLiveHint,
    dismissFailure: useCallback(() => setFailure(null), []),
    play: useCallback(() => {
      setBlocked(false);
      adapterRef.current?.play();
    }, []),
  };
}
