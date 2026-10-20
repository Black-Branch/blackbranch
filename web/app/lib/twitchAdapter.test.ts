// The Twitch adapter against a fake Twitch.Player.
// Run: node --test app/lib/twitchAdapter.test.ts

// Static "./testTsx.ts" first — it registers the "@/" resolver the adapter's
// CAPABILITIES import needs, and it only works if armed before that resolve.

import { test } from "node:test";
import assert from "node:assert/strict";
import "./testTsx.ts";
import type { PlayerEvent } from "./playerAdapter.ts";
const { createTwitchAdapter } = await import("../features/player/adapters/twitch.ts");

function fakeTwitch(opts: { latency?: number } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, (() => void)[]>();
  let volume = 0.5, muted = false;
  const player = {
    addEventListener: (evt: string, cb: () => void) => {
      handlers.set(evt, [...(handlers.get(evt) ?? []), cb]);
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- callback is part of the Twitch API signature but not used in the fake
    removeEventListener: (evt: string, _cb: () => void) => { calls.push(`off:${evt}`); },
    getPlaybackStats: () => ({ hlsLatencyBroadcaster: opts.latency ?? 3.5 }),
    setChannel: (c: string) => calls.push(`setChannel:${c}`),
    getVolume: () => volume,
    setVolume: (v: number) => { calls.push(`setVolume:${v}`); volume = v; },
    getMuted: () => muted,
    setMuted: (m: boolean) => { calls.push(`setMuted:${m}`); muted = m; },
    play: () => calls.push("play"),
  };
  const Twitch = {
    Player: Object.assign(
      function (_id: string, opts: Record<string, unknown>) { calls.push(`ctor:${JSON.stringify(opts.channel)}`); return player; },
      { ONLINE: "online", OFFLINE: "offline", PLAYBACK_BLOCKED: "blocked", READY: "ready", PLAYING: "playing" },
    ),
  };
  return { Twitch, calls, fire: (evt: string) => (handlers.get(evt) ?? []).forEach((cb) => cb()) };
}

function build(f: ReturnType<typeof fakeTwitch>) {
  const events: PlayerEvent[] = [];
  const adapter = createTwitchAdapter({
    Twitch: f.Twitch as never, containerId: "tw-1", channel: "examplechan", parent: "site.test", muted: true,
  });
  adapter.on((e) => events.push(e));
  return { adapter, events };
}

test("drift comes from the broadcaster latency stat, in seconds", () => {
  const f = fakeTwitch({ latency: 6.25 });
  const { adapter } = build(f);
  assert.equal(adapter.drift(), 6.25);
});

test("VOLUME SCALE: Twitch is already 0-1 — no conversion", () => {
  const f = fakeTwitch();
  const { adapter } = build(f);
  adapter.setVolume(0.25);
  assert.ok(f.calls.includes("setVolume:0.25"), `expected setVolume:0.25, got ${f.calls.join(",")}`);
});

test("reading volume back returns our own scale unchanged", () => {
  const f = fakeTwitch();
  const { adapter } = build(f);
  adapter.setVolume(0.75);
  adapter.setMuted(true);
  assert.deepEqual(adapter.readVolume(), { volume: 0.75, muted: true });
});

test("THE LEVER IS A RELOAD, NOT A SEEK — Twitch cannot seek live", () => {
  const f = fakeTwitch();
  const { adapter } = build(f);
  adapter.goLive();
  assert.ok(f.calls.includes("setChannel:examplechan"), `expected a reload, got ${f.calls.join(",")}`);
});

test("online and offline are reported", () => {
  const f = fakeTwitch();
  const { events } = build(f);
  f.fire("online");
  f.fire("offline");
  assert.deepEqual(events, [{ kind: "online" }, { kind: "offline" }]);
});

test("FINDING 3: READY is reported, so the caller knows when volume commands are safe", () => {
  const f = fakeTwitch();
  const { events } = build(f);
  f.fire("ready");
  assert.deepEqual(events, [{ kind: "ready" }]);
});

test("a refused autoplay is reported as blocked", () => {
  const f = fakeTwitch();
  const { events } = build(f);
  f.fire("blocked");
  assert.deepEqual(events, [{ kind: "blocked" }]);
});

test("destroy removes the listeners it added — Twitch has no destroy()", () => {
  const f = fakeTwitch();
  const { adapter } = build(f);
  adapter.destroy();
  assert.ok(f.calls.some((c) => c === "off:online"), `listeners were not removed: ${f.calls.join(",")}`);
  assert.ok(f.calls.some((c) => c === "off:offline"));
  assert.ok(f.calls.some((c) => c === "off:blocked"));
});

test("the adapter reports Twitch's capabilities, not a guess", () => {
  const f = fakeTwitch();
  const { adapter } = build(f);
  assert.equal(adapter.source, "twitch");
  assert.equal(adapter.capabilities.liveEdge, "reload");
  assert.equal(adapter.capabilities.latency, true);
  assert.equal(adapter.capabilities.errorDetail, false);
});

test("the player is constructed for the channel it was asked for", () => {
  const f = fakeTwitch();
  build(f);
  assert.ok(f.calls.includes('ctor:"examplechan"'), `constructed wrong: ${f.calls.join(",")}`);
});
