// The fullscreen helper, against each shape a browser engine gives the call.
//
// What prod showed (site.client_errors, 2026-11-02 00:33 PT, Mac Safari 26.4):
// `e.requestFullscreen().catch is not a function` — the player called `.catch` on what
// `requestFullscreen()` returned, and that Safari returned nothing.
//
// Run: systemd-run --user --scope -p MemoryMax=8G env -u DATABASE_URL node --test app/features/player/fullscreen.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { toggleFullscreen } from "./fullscreen.ts";

type FullscreenDoc = Parameters<typeof toggleFullscreen>[0];
type FullscreenTarget = NonNullable<Parameters<typeof toggleFullscreen>[1]>;
type FullscreenVideo = { webkitEnterFullscreen?: () => unknown };

type Calls = string[];

function docOf(calls: Calls, opts: { std?: boolean; webkit?: boolean; exitReturns?: () => unknown } = {}) {
  const d: FullscreenDoc & { fullscreenElement?: Element | null; webkitFullscreenElement?: Element | null } = {};
  if (opts.std !== false) {
    d.fullscreenElement = null;
    d.exitFullscreen = () => { calls.push("exit"); d.fullscreenElement = null; return opts.exitReturns ? opts.exitReturns() : Promise.resolve(); };
  }
  if (opts.webkit) {
    d.webkitFullscreenElement = null;
    d.webkitExitFullscreen = () => { calls.push("webkitExit"); d.webkitFullscreenElement = null; return undefined; };
  }
  return d;
}

const el = {} as Element;

test("Promise engine: the request is made and resolves true", async () => {
  const calls: Calls = [];
  const doc = docOf(calls);
  const target: FullscreenTarget = { requestFullscreen: () => { calls.push("req"); doc.fullscreenElement = el; return Promise.resolve(); } };
  assert.equal(await toggleFullscreen(doc, target, null), true);
  assert.deepEqual(calls, ["req"]);
});

test("Mac Safari engine: requestFullscreen() returns undefined — no throw, resolves true", async () => {
  const calls: Calls = [];
  const doc = docOf(calls, { exitReturns: () => undefined });
  const target: FullscreenTarget = { requestFullscreen: () => { calls.push("req"); doc.fullscreenElement = el; return undefined; } };
  assert.equal(await toggleFullscreen(doc, target, null), true);
  // and the way out of fullscreen on the same engine returns undefined too
  assert.equal(await toggleFullscreen(doc, target, null), true);
  assert.deepEqual(calls, ["req", "exit"]);
});

test("webkit-only engine: webkitRequestFullscreen / webkitExitFullscreen / webkitFullscreenElement are used", async () => {
  const calls: Calls = [];
  const doc = docOf(calls, { std: false, webkit: true });
  const target: FullscreenTarget = { webkitRequestFullscreen: () => { calls.push("webkitReq"); doc.webkitFullscreenElement = el; } };
  assert.equal(await toggleFullscreen(doc, target, null), true);
  assert.equal(await toggleFullscreen(doc, target, null), true);
  assert.deepEqual(calls, ["webkitReq", "webkitExit"]);
});

test("iPhone engine: no element fullscreen — the video's webkitEnterFullscreen is used", async () => {
  const calls: Calls = [];
  const doc = docOf(calls, { std: false });
  const video: FullscreenVideo = { webkitEnterFullscreen: () => { calls.push("videoEnter"); } };
  assert.equal(await toggleFullscreen(doc, {}, video), true);
  assert.deepEqual(calls, ["videoEnter"]);
});

test("no fullscreen at all: resolves false, never throws", async () => {
  const calls: Calls = [];
  assert.equal(await toggleFullscreen(docOf(calls, { std: false }), {}, {}), false);
  assert.equal(await toggleFullscreen(docOf(calls, { std: false }), null, null), false);
  assert.deepEqual(calls, []);
});

test("refusal: a rejected request resolves false — no unhandled rejection", async () => {
  const calls: Calls = [];
  const doc = docOf(calls);
  const target: FullscreenTarget = { requestFullscreen: () => { calls.push("req"); return Promise.reject(new TypeError("Permissions check failed")); } };
  assert.equal(await toggleFullscreen(doc, target, null), false);
});

test("refusal: a request that throws synchronously resolves false", async () => {
  const doc = docOf([]);
  const target: FullscreenTarget = { requestFullscreen: () => { throw new TypeError("not allowed"); } };
  assert.equal(await toggleFullscreen(doc, target, null), false);
});

test("refusal: an exit that rejects resolves false", async () => {
  const calls: Calls = [];
  const doc = docOf(calls, { exitReturns: () => Promise.reject(new TypeError("Not in fullscreen")) });
  doc.fullscreenElement = el;
  assert.equal(await toggleFullscreen(doc, { requestFullscreen: () => Promise.resolve() }, null), false);
  assert.deepEqual(calls, ["exit"]);
});

test("retry: after a refusal the next tap asks again and can succeed", async () => {
  const calls: Calls = [];
  const doc = docOf(calls);
  let refuse = true;
  const target: FullscreenTarget = {
    requestFullscreen: () => {
      calls.push("req");
      if (refuse) return Promise.reject(new TypeError("refused"));
      doc.fullscreenElement = el;
      return undefined;
    },
  };
  assert.equal(await toggleFullscreen(doc, target, null), false);
  refuse = false;
  assert.equal(await toggleFullscreen(doc, target, null), true);
  assert.deepEqual(calls, ["req", "req"]);
});

test("restart: enter → exit → enter again — the helper keeps no state between taps", async () => {
  const calls: Calls = [];
  const doc = docOf(calls, { exitReturns: () => undefined });
  const target: FullscreenTarget = { requestFullscreen: () => { calls.push("req"); doc.fullscreenElement = el; return undefined; } };
  for (let i = 0; i < 2; i++) {
    assert.equal(await toggleFullscreen(doc, target, null), true);
    assert.equal(await toggleFullscreen(doc, target, null), true);
  }
  assert.deepEqual(calls, ["req", "exit", "req", "exit"]);
});
