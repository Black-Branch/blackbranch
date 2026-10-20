// The YouTube adapter against a fake YT.Player. The API is a plain object of
// methods, so the whole contract is testable without a browser: what we call,
// what we DON'T call, and what we translate.
// Run: node --test app/lib/youtubeAdapter.test.ts

// The adapter imports CAPABILITIES from "@/app/lib/playerAdapter" — a VALUE,
// so strip-types cannot erase it and node cannot resolve the "@/" specifier by
// itself. "./testTsx.ts" registers that resolver and MUST be a static import,
// so its hooks are armed before the adapter resolves — hence the dynamic
// import below. Same shape as streamModeMenu.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./testTsx.ts";
import type { PlayerEvent } from "./playerAdapter.ts";
const { createYouTubeAdapter, YT_ERROR_REASON, SEEK_BACK_S } =
  await import("../features/player/adapters/youtube.ts");

/** A stand-in for YT.Player that records calls and can fire handlers. */
function fakeYT(opts: { duration?: number; current?: number; deferSeek?: boolean } = {}) {
  const calls: string[] = [];
  let handlers: Record<string, (e: unknown) => void> = {};
  let volume = 50, muted = false;
  let duration = opts.duration ?? 100, current = opts.current ?? 100;
  const deferSeek = opts.deferSeek ?? false;
  let deferredTarget: number | null = null;
  const player = {
    getDuration: () => duration,
    getCurrentTime: () => current,
    seekTo: (t: number) => {
      calls.push(`seekTo:${t}`);
      if (deferSeek) {
        deferredTarget = t;
      } else {
        current = t;
      }
    },
    getVolume: () => volume,
    setVolume: (v: number) => { calls.push(`setVolume:${v}`); volume = v; },
    mute: () => { calls.push("mute"); muted = true; },
    unMute: () => { calls.push("unMute"); muted = false; },
    isMuted: () => muted,
    playVideo: () => calls.push("playVideo"),
    destroy: () => calls.push("destroy"),
  };
  const YT = {
    Player: function (_el: unknown, cfg: { events: Record<string, (e: unknown) => void> }) {
      handlers = cfg.events;
      return player;
    },
  };
  return {
    YT, calls, player,
    fire: (name: string, data?: unknown) => handlers[name]?.({ data } as never),
    setTimes: (d: number, c: number) => { duration = d; current = c; },
    completeDefer: () => { if (deferredTarget !== null) { current = deferredTarget; deferredTarget = null; } },
  };
}

function build(f: ReturnType<typeof fakeYT>) {
  const events: PlayerEvent[] = [];
  const adapter = createYouTubeAdapter({ YT: f.YT as never, element: {} });
  adapter.on((e) => events.push(e));
  return { adapter, events };
}

test("drift is the distance from the live edge, in seconds", () => {
  const f = fakeYT({ duration: 300, current: 260 });
  const { adapter } = build(f);
  assert.equal(adapter.drift(), 40);
});

test("VOLUME SCALE: ours is 0-1, YouTube's is 0-100", () => {
  const f = fakeYT();
  const { adapter } = build(f);
  adapter.setVolume(0.25);
  assert.ok(f.calls.includes("setVolume:25"), `expected setVolume:25, got ${f.calls.join(",")}`);
});

test("reading volume back converts the other way", () => {
  const f = fakeYT();
  const { adapter } = build(f);
  adapter.setVolume(0.4);
  assert.deepEqual(adapter.readVolume(), { volume: 0.4, muted: false });
});

test("mute and unmute are separate calls, not a volume of zero", () => {
  // Restoring a level must never unmute and muting must never destroy the
  // level — the rule playerVolume.ts was written for.
  const f = fakeYT();
  const { adapter } = build(f);
  adapter.setMuted(true);
  assert.ok(f.calls.includes("mute"));
  adapter.setMuted(false);
  assert.ok(f.calls.includes("unMute"));
  assert.equal(f.calls.filter((c) => c.startsWith("setVolume")).length, 0);
});

test("goLive seeks to the live edge", () => {
  const f = fakeYT({ duration: 500, current: 400 });
  const { adapter } = build(f);
  adapter.goLive();
  assert.ok(f.calls.some((c) => c === "seekTo:500"), `expected seekTo:500, got ${f.calls.join(",")}`);
});

test("an error is reported with a cause, not just a failure", () => {
  const f = fakeYT();
  const { adapter, events } = build(f);
  f.fire("onError", 101);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "error");
  assert.equal((events[0] as { code: number }).code, 101);
  assert.equal((events[0] as { reason: string }).reason, YT_ERROR_REASON[101]);
  void adapter;
});

test("an unknown error code still produces a usable reason", () => {
  const f = fakeYT();
  const { events } = build(f);
  f.fire("onError", 999);
  assert.equal((events[0] as { reason: string }).reason.length > 0, true);
});

test("FINDING 3: onReady is reported, so the caller knows when volume commands are safe", () => {
  const f = fakeYT();
  const { events } = build(f);
  f.fire("onReady");
  assert.deepEqual(events, [{ kind: "ready" }]);
});

test("a refused autoplay is reported as blocked", () => {
  const f = fakeYT();
  const { events } = build(f);
  f.fire("onAutoplayBlocked");
  assert.deepEqual(events, [{ kind: "blocked" }]);
});

test("STAND-DOWN SIGNAL: a viewer's backward jump is reported", () => {
  // YouTube fires no seek event, so a backward discontinuity in currentTime
  // across a state change is the only signal that the viewer rewound.
  const f = fakeYT({ duration: 600, current: 590 });
  const { events } = build(f);
  f.fire("onStateChange", 1);      // playing — records 590
  f.setTimes(600, 120);            // viewer scrubbed back
  f.fire("onStateChange", 3);      // buffering, as a seek produces
  assert.ok(events.some((e) => e.kind === "seekedBack"), "a deliberate rewind was not detected");
});

test("FINDING 8: a no-op goLive (already at the edge) must not strand the next genuine rewind", () => {
  // If goLive() is called when we're already essentially at the live edge,
  // YouTube may fire no onStateChange at all — the only place selfSeeking
  // gets cleared. Left set, it silently swallows the viewer's next real
  // rewind (one missed stand-down).
  const f = fakeYT({ duration: 500, current: 498 });
  const { adapter, events } = build(f);
  f.fire("onStateChange", 1); // baseline: lastTime = 498
  adapter.goLive(); // already within SEEK_BACK_S of the edge
  assert.ok(!f.calls.some((c) => c.startsWith("seekTo")), "goLive seeked even though already at the edge");
  f.setTimes(500, 50); // the viewer's own, later, genuine rewind
  f.fire("onStateChange", 3);
  assert.ok(events.some((e) => e.kind === "seekedBack"), "the genuine rewind right after a no-op goLive was swallowed");
});

test("FINDING 8b: goLive during steady live playback must judge the LIVE playhead, not a stale lastTime", () => {
  // onStateChange is the only place lastTime gets written, and YouTube fires
  // none of it for minutes during steady live playback. If goLive judged
  // "already at the edge" by that stale lastTime instead of the live
  // getCurrentTime(), a real no-op seek would read as one worth flagging:
  // selfSeeking gets set, the no-op seek produces no onStateChange (nothing
  // to clear it), and the viewer's next genuine rewind is swallowed.
  const f = fakeYT({ duration: 500, current: 100 });
  const { adapter, events } = build(f);
  f.fire("onStateChange", 1); // records lastTime = 100 …
  f.setTimes(500, 498);       // … then minutes of steady playback with no
                              // further state change: the real playhead has
                              // moved on to the edge, but lastTime hasn't.
  adapter.goLive();           // must read the CURRENT edge distance (2s),
                              // not the stale one (400s), and skip as a no-op.
  assert.ok(!f.calls.some((c) => c.startsWith("seekTo")),
    "goLive seeked even though the live playhead was already at the edge");
  f.setTimes(500, 50);        // the viewer's own, later, genuine rewind
  f.fire("onStateChange", 3);
  assert.ok(events.some((e) => e.kind === "seekedBack"),
    "the genuine rewind was swallowed by a stale-lastTime false positive in goLive");
});

test("OUR OWN seek must not be mistaken for the viewer's", () => {
  // YouTube's seekTo() is asynchronous: we set lastTime = target synchronously,
  // but getCurrentTime() still reports the old position until the seek completes.
  // A state change arriving before completion must not read this stale position
  // as a backward discontinuity and emit seekedBack (which would disable all
  // future rewind detection). The selfSeeking guard prevents that.
  const f = fakeYT({ duration: 600, current: 300, deferSeek: true });
  const { adapter, events } = build(f);
  f.fire("onStateChange", 1);      // records lastTime = 300
  adapter.goLive();                 // sets lastTime = 600, seekTo(600) deferred
  f.fire("onStateChange", 3);       // buffering; getCurrentTime() still 300
  assert.equal(
    events.some((e) => e.kind === "seekedBack"),
    false,
    "a stale currentTime after our own seekTo must not trigger seekedBack"
  );
});

test("small backward jitter is not a rewind", () => {
  const f = fakeYT({ duration: 600, current: 500 });
  const { events } = build(f);
  f.fire("onStateChange", 1);
  f.setTimes(600, 500 - (SEEK_BACK_S - 1));
  f.fire("onStateChange", 3);
  assert.equal(events.some((e) => e.kind === "seekedBack"), false);
});

test("destroy tears the player down", () => {
  const f = fakeYT();
  const { adapter } = build(f);
  adapter.destroy();
  assert.ok(f.calls.includes("destroy"));
});

test("the adapter reports YouTube's capabilities, not a guess", () => {
  const f = fakeYT();
  const { adapter } = build(f);
  assert.equal(adapter.source, "youtube");
  assert.equal(adapter.capabilities.liveEdge, "seek");
  assert.equal(adapter.capabilities.latency, false);
  assert.equal(adapter.drift.length, 0);
});
