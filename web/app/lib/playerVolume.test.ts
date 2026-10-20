// Tests for the thin player's volume policy.
//
// Run: node --test app/lib/playerVolume.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clampVolume, parseSavedVolume, isSilent, sliderPercent, unmuteVolume, LEGACY_VOLUME_KEY,
  volumeKeyFor, restorableVolume, shouldPersistAdapterRead, levelToApplyAtReady, migrateLegacyVolume,
  MIN_RESTORE_VOLUME, DEFAULT_VOLUME,
} from "./playerVolume.ts";

test("clamp keeps the element's range and survives garbage", () => {
  assert.equal(clampVolume(0.5), 0.5);
  assert.equal(clampVolume(-1), 0);
  assert.equal(clampVolume(2), 1);
  assert.equal(clampVolume(NaN), 0);
});

test("a corrupt saved value returns null, NOT 0", () => {
  // Returning 0 would silently mute a viewer because of a bad localStorage read.
  for (const raw of [null, "", "loud", "-0.5", "1.5", "Infinity"]) {
    assert.equal(parseSavedVolume(raw), null, `${JSON.stringify(raw)} should not parse`);
  }
});

test("a valid saved value round-trips, including the edges", () => {
  assert.equal(parseSavedVolume("0"), 0);
  assert.equal(parseSavedVolume("1"), 1);
  assert.equal(parseSavedVolume("0.35"), 0.35);
});

test("THE AUTOPLAY TRAP: nothing in this module can unmute", () => {
  // Restoring a level must never clear `muted` — startMuted is what makes
  // autoplay legal on mobile. If a restore unmuted, play() would be blocked and
  // the viewer would get a tap-to-play overlay instead of the stream.
  const src = readFileSync(join(process.cwd(), "app", "lib", "playerVolume.ts"), "utf8");
  assert.doesNotMatch(src, /muted\s*=/, "this module assigns `muted` — it must stay orthogonal");
  // And the restore effect in the player must not touch setMuted either.
  const player = readFileSync(
    join(process.cwd(), "app", "features", "player", "StreamplaceThinPlayer.tsx"), "utf8"
  );
  const restore = /Restore the saved volume[\s\S]*?\}, \[\]\);/.exec(player)?.[0] ?? "";
  assert.ok(restore, "the volume-restore effect was not found");
  assert.doesNotMatch(restore, /setMuted/,
    "the volume restore now unmutes — this breaks mobile autoplay");
});

test("both sources of silence read as silent", () => {
  assert.equal(isSilent(true, 0.8), true, "muted with volume up");
  assert.equal(isSilent(false, 0), true, "slider dragged to zero");
  assert.equal(isSilent(false, 0.8), false);
});

test("the slider shows 0 whenever silent, so it never contradicts the audio", () => {
  assert.equal(sliderPercent(true, 0.8), 0, "muted must not show 80%");
  assert.equal(sliderPercent(false, 0), 0);
  assert.equal(sliderPercent(false, 0.8), 80);
  assert.equal(sliderPercent(false, 0.005), 1, "rounds, never negative");
});

test("unmuting always lands somewhere audible", () => {
  assert.equal(unmuteVolume(0.4, 0.9), 0.4, "a non-zero level is kept as-is");
  assert.equal(unmuteVolume(0, 0.6), 0.6, "zeroed slider restores the last audible level");
  assert.equal(unmuteVolume(0, 0), 1, "no history → full, never 0 (that's a no-op button)");
});

test("the player uses this module's policy rather than its own copy", () => {
  // The point of extracting it. If the component re-inlines the parse/clamp/
  // slider maths, these tests keep passing while pinning nothing that ships —
  // which is the duplication trap the audit spent this whole sweep closing.
  assert.equal(LEGACY_VOLUME_KEY, "player_volume", "the one-time migration's source");
  const player = readFileSync(
    join(process.cwd(), "app", "features", "player", "StreamplaceThinPlayer.tsx"), "utf8"
  );
  for (const fn of ["restorableVolume", "isSilent", "sliderPercent", "unmuteVolume", "clampVolume", "volumeKeyFor", "migrateLegacyVolume"]) {
    assert.match(player, new RegExp(`\\b${fn}\\b`), `the player no longer uses ${fn}`);
  }
  assert.doesNotMatch(player, /"player_volume"/,
    "the storage key is hardcoded again — it must come from volumeKeyFor");
  assert.doesNotMatch(player, /Math\.max\(0, Math\.min\(1,/,
    "the clamp was re-inlined");
});

// ── one volume per player ───────────────────────────────────────────────────

test("one key per player, spelled in one place", () => {
  assert.equal(volumeKeyFor("native"), "player_volume_native");
  assert.equal(volumeKeyFor("youtube"), "player_volume_youtube");
  assert.equal(volumeKeyFor("twitch"), "player_volume_twitch");
});

test("a level below the floor restores as ABSENT — never clamped up to the floor", () => {
  assert.equal(MIN_RESTORE_VOLUME, 0.05);
  assert.equal(restorableVolume("0.03"), null);
  assert.equal(restorableVolume("0"), null);
  assert.equal(restorableVolume("0.05"), 0.05);
  assert.equal(restorableVolume("1"), 1);
  assert.equal(restorableVolume("garbage"), null);
  assert.equal(restorableVolume(null), null);
});

test("an adapter read is persisted only when the viewer changed it, unmuted, above the floor", () => {
  assert.equal(shouldPersistAdapterRead({ volume: 1, muted: true }, 1), false, "muted");
  assert.equal(shouldPersistAdapterRead({ volume: 0.4, muted: true }, 1), false, "muted, even if changed");
  assert.equal(shouldPersistAdapterRead({ volume: 0.02, muted: false }, 1), false, "below the floor");
  assert.equal(shouldPersistAdapterRead({ volume: 1, muted: false }, 1), false, "unchanged since ready");
  assert.equal(shouldPersistAdapterRead({ volume: 0.995, muted: false }, 1), false, "within rounding of what we applied");
  assert.equal(shouldPersistAdapterRead({ volume: 0.4, muted: false }, 1), true, "the viewer moved it");
  assert.equal(shouldPersistAdapterRead(null, 1), false, "unreadable");
  assert.equal(shouldPersistAdapterRead({ volume: NaN, muted: false }, 1), false, "junk");
  assert.equal(shouldPersistAdapterRead({ volume: 0.4, muted: false }, null), false, "no ready baseline, no write");
});

test("at ready: a saved level wins; with none, a poisoned or unreadable embed level is repaired to the default; a sane one is left alone", () => {
  assert.equal(DEFAULT_VOLUME, 1);
  assert.equal(levelToApplyAtReady(0.6, { volume: 0.03, muted: true }), 0.6);
  assert.equal(levelToApplyAtReady(null, { volume: 0.03, muted: true }), 1, "the embed kept a poisoned level of its own");
  assert.equal(levelToApplyAtReady(null, { volume: 0, muted: false }), 1);
  assert.equal(levelToApplyAtReady(null, null), 1, "unreadable → set a sane level");
  assert.equal(levelToApplyAtReady(null, { volume: NaN, muted: false }), 1);
  assert.equal(levelToApplyAtReady(null, { volume: 0.4, muted: false }), null, "the embed's own sane level is the viewer's");
});

const store = (init: Record<string, string>) => {
  const s = new Map(Object.entries(init));
  return { s, get: (k: string) => s.get(k) ?? null, set: (k: string, v: string) => { s.set(k, v); }, remove: (k: string) => { s.delete(k); } };
};

test("a near-zero legacy level is carried nowhere, and the legacy key is gone", () => {
  const st = store({ player_volume: "0.03" });
  migrateLegacyVolume(st.get, st.set, st.remove);
  assert.deepEqual([...st.s.keys()], []);
});

test("an audible legacy level goes to the in-house key only, never over a newer one", () => {
  const a = store({ player_volume: "0.6" });
  migrateLegacyVolume(a.get, a.set, a.remove);
  assert.deepEqual(Object.fromEntries(a.s), { player_volume_native: "0.6" }, "never copied to youtube/twitch");
  const b = store({ player_volume: "0.6", player_volume_native: "0.3" });
  migrateLegacyVolume(b.get, b.set, b.remove);
  assert.deepEqual(Object.fromEntries(b.s), { player_volume_native: "0.3" });
});

test("migration removes the legacy key in every branch and a second run is a no-op", () => {
  for (const v of ["0.6", "0.01", "junk", ""]) {
    const st = store({ player_volume: v, player_volume_youtube: "0.7" });
    migrateLegacyVolume(st.get, st.set, st.remove);
    assert.equal(st.s.has("player_volume"), false, v);
    const once = JSON.stringify([...st.s]);
    migrateLegacyVolume(st.get, st.set, st.remove);
    assert.equal(JSON.stringify([...st.s]), once, "idempotent");
    assert.equal(st.s.get("player_volume_youtube"), "0.7", "another player's key is never touched");
  }
});
