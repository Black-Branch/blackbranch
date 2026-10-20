// Run: node --test app/lib/deviceHealth/ingest.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReport, cleanScriptSrc, cleanSelector, createDeviceHealthGate, MAX_SEQ } from "./ingest.ts";

const fixture = () => ({
  v: 1, sid: "6f9d1c2e-1111-4222-8333-944455556666", seq: 2, route: "/", dc: "mobile", narrow: true,
  dm: 4, hc: 8, et: "4g", sd: false, dpr: 3, openMs: 1000, visMs: 900,
  loaf: { n: 2, blockMs: 300, worst: [{ d: 200, b: 150, t: 5, s: [{ src: "/_next/static/chunks/a.js", fn: "f", inv: "IMG#emote-1.onload", d: 9, fsl: 1 }] }] },
  inp: { ms: 220, type: "pointerdown", target: "div.chat-row>span", inDelay: 5, proc: 100, pres: 115 },
  cls: 0.02, req: 40, bytes: { js: { n: 20, b: 600000, nb: 0 }, emote_7tv: { n: 300, b: 0, nb: 300 } },
  sock: { reconnects: 1 },
  player: { src: "native", silent: true, vol: 0.5, mountedMs: 800, unseenMs: 100, silentUnseenMs: 100, foldedMs: 0,
    video: { w: 1920, h: 1080, fps: 59.9, decoded: 50000, dropped: 12, decodeMs: 2.1, freezes: 0, freezeMs: 0, bytes: 9e8, mode: "webrtc" } },
  decode: { type: "webrtc", supported: true, smooth: true, powerEfficient: true },
  frames: { fps: 60, costMs: 0.3 }, anim: { running: 6, idle: 30 },
  settings: { animEmotes: true, lowPower: false, reducedMotion: false, startMuted: true },
  heap: { startMb: 30, peakMb: 80 },
});

test("a good report normalises to a row", () => {
  const r = normalizeReport(fixture())!;
  assert.equal(r.sessionId, "6f9d1c2e-1111-4222-8333-944455556666");
  assert.equal(r.deviceClass, "mobile");
  assert.equal(r.inpMs, 220);
  assert.deepEqual(r.bytes.js, { n: 20, b: 600000, nb: 0 });
  assert.equal((r.player as { video: { decodeMs: number } }).video.decodeMs, 2.1);
  assert.deepEqual(r.frames, { fps: 60, costMs: 0.3 });
  assert.deepEqual(r.anim, { running: 6, idle: 30 });
  assert.equal((r.decode as { powerEfficient: boolean }).powerEfficient, true);
});

test("rejects a bad uuid, a seq out of range, and non-reports", () => {
  for (const bad of [null, "x", [], 5, { ...fixture(), v: 2 }, { ...fixture(), sid: "nope" },
    { ...fixture(), seq: MAX_SEQ + 1 }, { ...fixture(), seq: 0 }, { ...fixture(), seq: 1.5 }]) {
    assert.equal(normalizeReport(bad), null, JSON.stringify(bad));
  }
});

test("negatives clamp to 0 and unknown categories are dropped", () => {
  const r = normalizeReport({ ...fixture(), openMs: -5, req: -1, bytes: { js: { n: -1, b: 2, nb: 0 }, evil: { n: 1, b: 1, nb: 1 } } })!;
  assert.equal(r.openMs, 0);
  assert.equal(r.reqCount, 0);
  assert.deepEqual(Object.keys(r.bytes), ["js"]);
  assert.equal(r.bytes.js?.n, 0);
});

test("ingest refuses a selector or label carrying an id, and any URL", () => {
  const r = normalizeReport({ ...fixture(), inp: { ...fixture().inp, target: "div#msg-123>span[data-user=\"bob\"]" } })!;
  assert.equal((r.inp as { target: string }).target, "div>span");
  assert.equal(cleanSelector("a[href='https://x']"), "other");
  const frame = (r.loafWorst[0] as { s: Array<{ inv: string }> }).s[0];
  assert.equal(frame?.inv, "IMG.onload");
});

test("script sources must already be reduced", () => {
  assert.equal(cleanScriptSrc("/_next/static/chunks/a.js"), "/_next/static/chunks/a.js");
  assert.equal(cleanScriptSrc("cdn.example.com"), "cdn.example.com");
  assert.equal(cleanScriptSrc("extension"), "extension");
  assert.equal(cleanScriptSrc("/_next/a.js?token=1"), "other");
  assert.equal(cleanScriptSrc("https://cdn.example.com/a.js"), "other");
  assert.equal(cleanScriptSrc(42), "other");
});

test("unknown enum values become 'other' / null", () => {
  const r = normalizeReport({ ...fixture(), route: "/u/bob?x=1", et: "5g", player: { ...fixture().player, src: "<script>" } })!;
  assert.equal(r.route, "other");
  assert.equal(r.effectiveType, null);
  assert.equal((r.player as { src: string }).src, "other");
});

test("the gate: 60 a minute per address, 120 new session ids an hour per address", () => {
  const g = createDeviceHealthGate({ perMinute: 3, newPerHour: 2 });
  assert.equal(g.limited("ip:a"), false);
  assert.equal(g.limited("ip:a"), false);
  assert.equal(g.limited("ip:a"), false);
  assert.equal(g.limited("ip:a"), true);
  assert.equal(g.limited("ip:b"), false, "per address");
  assert.equal(g.newSessionLimited("ip:a", "s1"), false);
  assert.equal(g.newSessionLimited("ip:a", "s2"), false);
  assert.equal(g.newSessionLimited("ip:a", "s3"), true, "a third new id in the hour");
  assert.equal(g.newSessionLimited("ip:a", "s1"), false, "a known session keeps reporting");
  assert.equal(g.newSessionLimited("ip:c", "s9"), false);
  assert.equal(g.newSessionLimited("ip:c", "s10"), false);
  assert.equal(g.newSessionLimited("ip:c", "s1"), true, "another address does not inherit a's known session");
});
