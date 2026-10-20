// The reporter's cadence, by RUNNING it: one report per 5 minutes
// while visible and none while hidden, one at the hidden edge, no duplicate at pagehide, seq
// increments, and nothing at all from an OBS overlay. jsdom + node's mock timers + a sendBeacon spy.
import test from "node:test";
import assert from "node:assert/strict";
import { dom } from "../testDom.ts";
import "../testTsx.ts";
import { normalizeReport } from "./ingest.ts";
// After testTsx: the reporter reaches settingsRegistry, whose imports are extensionless.
const { startDeviceHealth, TICK_MS, REPORT_EVERY_TICKS } = await import("./reporter.ts");

let vis: "visible" | "hidden" = "visible";
Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => vis });
const beacons: Blob[] = [];
Object.defineProperty(dom.window.navigator, "sendBeacon", {
  configurable: true, value: (url: string, b: Blob) => { assert.equal(url, "/api/device-health"); beacons.push(b); return true; },
});
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const bodies = async () => Promise.all(beacons.map(async (b) => JSON.parse(await b.text())));
const setVis = (v: "visible" | "hidden") => { vis = v; dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); };
const advance = async (t: { mock: { timers: { tick: (ms: number) => void } } }, ms: number) => {
  for (let left = ms; left > 0; left -= TICK_MS) { t.mock.timers.tick(Math.min(TICK_MS, left)); await flush(); }
};

test("visible: one report per 5 minutes, seq increments, and each one is a valid report", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  beacons.length = 0; vis = "visible";
  const stop = startDeviceHealth();
  await advance(t, TICK_MS * REPORT_EVERY_TICKS - 1);
  assert.equal(beacons.length, 0, "nothing before 5 minutes");
  await advance(t, 1);
  assert.equal(beacons.length, 1);
  await advance(t, TICK_MS * REPORT_EVERY_TICKS);
  assert.equal(beacons.length, 2);
  const [a, b] = await bodies();
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  assert.equal(a.sid, b.sid, "one session id per page load");
  assert.ok(normalizeReport(a), "what the reporter sends is what the route accepts");
  stop();
});

test("hidden: one send at the hidden edge, none while hidden, and pagehide does not duplicate it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  beacons.length = 0; vis = "visible";
  const stop = startDeviceHealth();
  await advance(t, TICK_MS * 2);
  setVis("hidden");
  assert.equal(beacons.length, 1, "the hidden edge sends");
  await advance(t, TICK_MS * REPORT_EVERY_TICKS * 3);
  assert.equal(beacons.length, 1, "nothing while hidden — the radio sleeps");
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.equal(beacons.length, 1, "pagehide right after a hidden send is not a duplicate");
  setVis("visible");
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.equal(beacons.length, 2, "pagehide after the page was visible again does send");
  stop();
});

test("a real unload (pagehide FIRST, then hidden) sends once, not twice", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  beacons.length = 0; vis = "visible";
  const stop = startDeviceHealth();
  await advance(t, TICK_MS);
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  setVis("hidden");
  assert.equal(beacons.length, 1);
  stop();
  vis = "visible";
});

test("stop() removes every listener and timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  beacons.length = 0; vis = "visible";
  startDeviceHealth()();
  await advance(t, TICK_MS * REPORT_EVERY_TICKS * 2);
  setVis("hidden");
  assert.equal(beacons.length, 0);
  vis = "visible";
});

test("an OBS overlay reports nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  beacons.length = 0; vis = "visible";
  dom.window.history.pushState({}, "", "/overlay/alerts");
  const stop = startDeviceHealth();
  await advance(t, TICK_MS * REPORT_EVERY_TICKS * 2);
  setVis("hidden");
  assert.equal(beacons.length, 0);
  stop();
  dom.window.history.pushState({}, "", "/");
  vis = "visible";
});
