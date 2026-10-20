// captureVolume() must not run on an adapter event that arrives before the
// player has said "ready". A pre-ready getVolume() can legally return
// NaN/undefined; clampVolume(NaN) is 0 — a perfectly legal persisted volume —
// so one bad read would permanently write silence into the volume key, and
// every future session would restore muted with no visible cause.
//
// A source scan can't see this: playerAdapterWiring.test.ts asserts
// captureVolume() has at least 2 call sites and that it reads the adapter
// back, but nothing about ORDER relative to "ready" is checkable from text —
// this needs the hook actually RUNNING against a fake adapter, hence
// testDom.ts's render harness (see its own header for why it exists).
import test from "node:test";
import assert from "node:assert/strict";
import { mountHook, resetStorage } from "./testDom.ts";
import "./testTsx.ts";
import { CAPABILITIES, type PlayerAdapter, type PlayerEvent } from "./playerAdapter.ts";
import { volumeKeyFor, LEGACY_VOLUME_KEY } from "./playerVolume.ts";
const VOLUME_KEY = volumeKeyFor("youtube");
import { lsGet, lsSet } from "./safeLocalStorage.ts";
const { usePlayerAdapter } = await import("../features/player/usePlayerAdapter.ts");

/** A fake PlayerAdapter whose readVolume() and event stream a test drives directly. */
function fakeAdapter(opts: { volume?: { volume: number; muted: boolean } | null } = {}) {
  const listeners = new Set<(e: PlayerEvent) => void>();
  let volume = opts.volume ?? null;
  const calls: string[] = [];
  const adapter: PlayerAdapter = {
    source: "youtube",
    capabilities: CAPABILITIES.youtube,
    setVolume: (v) => calls.push(`setVolume:${v}`),
    setMuted: (m) => calls.push(`setMuted:${m}`),
    readVolume: () => volume,
    drift: () => null,
    goLive: () => {},
    play: () => calls.push("play"),
    on: (l) => { listeners.add(l); return () => listeners.delete(l); },
    destroy: () => calls.push("destroy"),
  };
  return {
    adapter,
    calls,
    emit: (e: PlayerEvent) => { for (const l of listeners) l(e); },
    setVolumeRead: (v: { volume: number; muted: boolean } | null) => { volume = v; },
  };
}

test("a pre-ready junk volume read is never persisted", async () => {
  resetStorage();
  // A legal-looking object — this is the trap: it is not null, so the old
  // unconditional `if (v) lsSet(...)` would write it.
  const f = fakeAdapter({ volume: { volume: NaN, muted: false } });
  const h = await mountHook(() =>
    usePlayerAdapter({ source: "youtube", create: () => f.adapter, key: "pre-ready" })
  );
  await h.act(async () => { f.emit({ kind: "online" }); }); // arrives BEFORE ready
  assert.equal(lsGet(VOLUME_KEY), null,
    "a volume read taken before 'ready' must not overwrite the persisted volume key");
  await h.unmount();
});

test("teardown capture is ALSO gated on readySeen — a never-ready player must not persist on unmount", async () => {
  resetStorage();
  const f = fakeAdapter({ volume: { volume: NaN, muted: false } });
  const h = await mountHook(() =>
    usePlayerAdapter({ source: "youtube", create: () => f.adapter, key: "never-ready" })
  );
  await h.unmount(); // the adapter never emitted "ready" before teardown
  assert.equal(lsGet(VOLUME_KEY), null,
    "teardown's own capture must not persist from a player that never became ready");
});

test("a read AFTER ready persists once the viewer moves the level — the gate is not a permanent block", async () => {
  resetStorage();
  const f = fakeAdapter({ volume: { volume: 1, muted: false } });
  const h = await mountHook(() =>
    usePlayerAdapter({ source: "youtube", create: () => f.adapter, key: "post-ready" })
  );
  await h.act(async () => { f.emit({ kind: "ready" }); });
  assert.equal(lsGet(VOLUME_KEY), null, "an unchanged level is not the viewer's — nothing written at ready");
  f.setVolumeRead({ volume: 0.4, muted: false });
  await h.act(async () => { f.emit({ kind: "online" }); });
  assert.equal(lsGet(VOLUME_KEY), "0.4", "the viewer's own change is kept, under this source's key");
  assert.equal(lsGet(volumeKeyFor("twitch")), null, "never another player's key");
  await h.unmount();
});

// ── one volume per player ───────────────────────────────────────────────────

test("a phone-like embed (no slider: full volume, muted) writes NO key across ready, events and teardown", async () => {
  resetStorage();
  const f = fakeAdapter({ volume: { volume: 1, muted: true } });
  const h = await mountHook(() => usePlayerAdapter({ source: "youtube", create: () => f.adapter, key: "phone" }));
  await h.act(async () => {
    f.emit({ kind: "ready" }); f.emit({ kind: "online" }); f.emit({ kind: "blocked" }); f.emit({ kind: "seekedBack" });
  });
  await h.unmount();
  assert.deepEqual(Object.keys(localStorage), [], "nothing persisted from a player the viewer never touched");
});

test("a legacy 0.03 and an embed stuck at 0.03 → repaired to the default at ready, never unmuted, legacy key gone", async () => {
  resetStorage();
  lsSet(LEGACY_VOLUME_KEY, "0.03");
  const f = fakeAdapter({ volume: { volume: 0.03, muted: true } });
  const h = await mountHook(() => usePlayerAdapter({ source: "youtube", create: () => f.adapter, key: "poisoned" }));
  await h.act(async () => { f.emit({ kind: "ready" }); });
  assert.deepEqual(f.calls.filter((c) => c.startsWith("set")), ["setVolume:1"], "set the default level — and no setMuted at all");
  assert.equal(lsGet(LEGACY_VOLUME_KEY), null);
  assert.equal(lsGet(VOLUME_KEY), null, "the poison is not carried into the youtube key");
  await h.unmount();
});

test("a saved level for THIS source is applied at ready; an embed at its own sane level with none saved is left alone", async () => {
  resetStorage();
  lsSet(VOLUME_KEY, "0.6");
  const a = fakeAdapter({ volume: { volume: 0.2, muted: false } });
  const h1 = await mountHook(() => usePlayerAdapter({ source: "youtube", create: () => a.adapter, key: "saved" }));
  await h1.act(async () => { a.emit({ kind: "ready" }); });
  assert.deepEqual(a.calls.filter((c) => c.startsWith("set")), ["setVolume:0.6"]);
  await h1.unmount();

  resetStorage();
  const b = fakeAdapter({ volume: { volume: 0.4, muted: false } });
  const h2 = await mountHook(() => usePlayerAdapter({ source: "youtube", create: () => b.adapter, key: "sane" }));
  await h2.act(async () => { b.emit({ kind: "ready" }); });
  assert.deepEqual(b.calls.filter((c) => c.startsWith("set")), [], "the embed's own sane level is the viewer's");
  await h2.unmount();
});
