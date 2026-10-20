// Run: node --test app/lib/deviceHealth/report.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, routeOf, MAX_REPORT_BYTES, type HealthReport } from "./report.ts";
import { CATEGORIES } from "./resourceCategory.ts";
import { playerSnapshot, resetPlayerHealth, setPlayerSrc, setPlayerSeen, setPlayerAudio, setPlayerFolded } from "../playerHealth.ts";

function fixture(): Omit<HealthReport, "v"> {
  return {
    sid: "6f9d1c2e-1111-4222-8333-944455556666", seq: 3, route: "/", dc: "mobile", narrow: true,
    dm: 4, hc: 8, et: "4g", sd: false, dpr: 3, openMs: 60_000, visMs: 50_000,
    loaf: { n: 0, blockMs: 0, worst: [] }, inp: null, cls: 0.01, req: 10, bytes: {},
    sock: { reconnects: 0 }, player: { ...playerSnapshot(0), video: null }, decode: null, frames: { fps: 60, costMs: 0.4 },
    anim: { running: 6, idle: 38 },
    settings: { animEmotes: true, lowPower: false, reducedMotion: false, startMuted: true },
    heap: { startMb: 20, peakMb: 40 },
  };
}

test("route is the first path segment only", () => {
  assert.equal(routeOf("/"), "/");
  assert.equal(routeOf("/popout/chat"), "/popout");
  assert.equal(routeOf("/overlay/alerts"), "/overlay");
  assert.equal(routeOf("/u/%F0%9F%98%80"), "/u");
  assert.equal(routeOf("/@weird:name"), "/");
});

test("stays within the route's cap at the worst case: 10 frames × max scripts, every category", () => {
  const f = fixture();
  const longSrc = "/_next/static/chunks/" + "a".repeat(180) + ".js";
  f.loaf = { n: 999, blockMs: 99_999, worst: Array.from({ length: 10 }, (_, i) => ({ d: 999, b: 900 - i, t: 1e9,
    s: Array.from({ length: 20 }, () => ({ src: longSrc, fn: "f".repeat(60), inv: "i".repeat(60), d: 999, fsl: 999 })) })) };
  f.bytes = Object.fromEntries(CATEGORIES.map((c) => [c, { n: 999_999, b: 999_999_999, nb: 999_999 }]));
  f.inp = { ms: 999, type: "pointerdown", target: "x".repeat(100), inDelay: 9, proc: 9, pres: 9 };
  const r = buildReport(f);
  assert.ok(JSON.stringify(r).length <= MAX_REPORT_BYTES, `${JSON.stringify(r).length} bytes`);
  assert.equal(r.loaf.n, 999, "the counts survive a trim; only frame detail is shed");
  assert.equal(r.v, 1);
});

test("every playerHealth field reaches the report — no write-only counters", () => {
  resetPlayerHealth();
  setPlayerSrc("native", 0);
  setPlayerAudio({ silent: true, vol: 0.5 }, 0);
  setPlayerSeen(false, 1000);
  setPlayerFolded(true, 2000);
  const snap = playerSnapshot(5000);
  const r = buildReport({ ...fixture(), player: { ...snap, video: null } });
  const sent = JSON.parse(JSON.stringify(r)).player;
  // Derived from the object's own keys, not a hand-typed list.
  assert.deepEqual(Object.keys(sent).sort(), [...Object.keys(snap), "video"].sort());
  assert.ok(Object.keys(snap).length >= 7, "the snapshot read as empty — the check above would pass vacuously");
  assert.equal(sent.mountedMs, 5000);
  assert.equal(sent.unseenMs, 4000);
  assert.equal(sent.silentUnseenMs, 4000);
  assert.equal(sent.foldedMs, 3000);
});

test("unseen time only counts while a player is mounted", () => {
  resetPlayerHealth();
  setPlayerSeen(false, 0);
  setPlayerSrc("youtube", 10_000);
  setPlayerSrc("none", 15_000);
  const s = playerSnapshot(20_000);
  assert.equal(s.mountedMs, 5000);
  assert.equal(s.unseenMs, 5000);
  assert.equal(s.silentUnseenMs, 0, "unknown audio is never counted as silent");
});
