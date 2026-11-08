// The in-house stream.place player's reconnect machine — RUN, not source-scanned.
//
// The transport cannot handshake offline, so this mounts the real component
// against a fake RTCPeerConnection and a fake fetch, on mocked timers, and drives
// the same events the browser fires. The rows it posts to /api/client-error are
// read exactly as prod's site.client_errors reads them.
//
// What prod showed (site.client_errors, 10-18 → 10-31, all node prod-sea0):
//  · `player ended: track-ended — pc=closed/closed attempt=0` ×10 on one Windows
//    Chrome viewer while stream.place stayed live (ingest's poller said
//    streamplace=live through 02:25 PT on 10-31): the player painted "Stream has
//    ended" over a live stream and waited for a tap.
//  · an Android phone's rows arrived in one 30 ms burst, newest first
//    (`watchdog attempt=2`, `attempt=1`, `grace-expired attempt=0` at 20:11:02):
//    its own HTTP was held, not the node's. The watchdog then gave a first
//    connect "Can't connect … Compatibility mode usually works" for a request
//    our own site never answered.
//
// Run: systemd-run --user --scope -p MemoryMax=8G env -u DATABASE_URL node --test app/features/player/streamplaceReconnect.render.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { React, act, dom } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

const { default: StreamplaceThinPlayer } = await import("@/app/features/player/StreamplaceThinPlayer");
const { _resetClientErrorThrottle } = await import("@/app/lib/clientError");
const { reconnectDelayMs, MAX_RECONNECTS, CONNECT_TIMEOUT_MS, SIGNAL_DEADLINE_MS } = await import("@/app/lib/whepEscalation");
const { SMOOTH_JITTER_BUFFER_MS } = await import("@/app/lib/hlsConfig");
const { createRoot } = await import("react-dom/client");

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeTrack extends EventTarget {}

class FakePC extends EventTarget {
  static all: FakePC[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription = { type: "offer", sdp: "v=0 fake-offer" };
  closed = false;
  answered = false;
  constructor() { super(); FakePC.all.push(this); }
  addTransceiver() { /* recvonly — nothing to record */ }
  async createOffer() { return { type: "offer", sdp: "v=0 fake-offer" }; }
  async setLocalDescription() { /* nothing */ }
  async setRemoteDescription() { this.answered = true; }
  async getStats() { return new Map(); }
  receivers: { jitterBufferTarget: number | null }[] = [];
  getReceivers() { return this.receivers; }
  close() { this.closed = true; this.connectionState = "closed"; this.iceConnectionState = "closed"; }
  setState(s: RTCPeerConnectionState) {
    this.connectionState = s;
    this.iceConnectionState = (s === "connected" ? "connected" : s) as RTCIceConnectionState;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  /** A remote track arrives, then (optionally) the node ends it. */
  track(): FakeTrack {
    const t = new FakeTrack();
    const e = new Event("track") as Event & { track: unknown; streams: unknown[]; receiver: unknown };
    e.track = t;
    e.streams = [{ id: "s" }];
    const receiver = { jitterBufferTarget: null as number | null };
    this.receivers.push(receiver);
    e.receiver = receiver;
    this.dispatchEvent(e);
    return t;
  }
}
const g = globalThis as Record<string, unknown>;
g.RTCPeerConnection = FakePC;
g.MediaStream = class { addTrack() {} };
const media = dom.window.HTMLMediaElement.prototype as unknown as Record<string, unknown>;
media.play = () => Promise.resolve();
media.pause = () => {};

// "busy" = the relay's 429 with Retry-After: 7; "busy-bare" = a 429 with none.
type Whep = "answer" | "hang" | "throw" | "busy" | "busy-bare";
let whepPlan: Whep[] = [];
const rows: string[] = [];
// What stream.place's HLS playlist answers (compatibility mode's end probe).
let playlistStatus = 200;
g.fetch = (url: string, init?: RequestInit) => {
  if (String(url).startsWith("/api/client-error")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { source?: string; message?: string };
    if (body.source === "player") rows.push(body.message ?? "");
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  if (String(url).includes("place.stream.playback.getLivePlaylist")) {
    return Promise.resolve(new Response(playlistStatus === 404 ? '{"message":"StreamNotLive"}' : "#EXTM3U", { status: playlistStatus }));
  }
  if (String(url).startsWith("/api/streamplace/whep")) {
    const step = whepPlan.shift() ?? "answer";
    if (step === "throw") return Promise.reject(new TypeError("Failed to fetch"));
    if (step === "busy") return Promise.resolve(new Response("too many requests", { status: 429, headers: { "retry-after": "7" } }));
    if (step === "busy-bare") return Promise.resolve(new Response("too many requests", { status: 429 }));
    if (step === "hang") {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return Promise.resolve(new Response("v=0 fake-answer", {
      status: 201, headers: { "x-playback-server": "https://node.example" },
    }));
  }
  return Promise.reject(new Error(`unexpected fetch ${url}`));
};

// ── harness ──────────────────────────────────────────────────────────────────

async function flush() {
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
}

async function mount(t: { mock: typeof mock }, opts: { transport?: "hls"; smooth?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  FakePC.all = [];
  rows.length = 0;
  _resetClientErrorThrottle();
  dom.window.localStorage.clear();
  if (opts.transport) dom.window.localStorage.setItem("player_transport", opts.transport);
  if (opts.smooth) dom.window.localStorage.setItem("chatStyle_playerSmooth", "1");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(StreamplaceThinPlayer, { startMuted: true, channel: "casey.example", onFallback: () => {} }));
  });
  await flush();
  const tick = async (ms: number) => { await act(async () => { t.mock.timers.tick(ms); }); await flush(); };
  return {
    host,
    text: () => host.textContent ?? "",
    pc: () => FakePC.all[FakePC.all.length - 1]!,
    video: () => host.querySelector("video")!,
    tick,
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

/** Mount and bring the first attempt to "connected". */
async function playing(t: { mock: typeof mock }) {
  const p = await mount(t);
  assert.equal(FakePC.all.length, 1, "the first attempt was made");
  assert.ok(p.pc().answered, "the relay's answer was applied");
  await act(async () => { p.pc().setState("connected"); });
  await flush();
  return p;
}

// ── the kinds prod showed ────────────────────────────────────────────────────

test("track-ended on a live stream reconnects — never a dead 'Stream has ended'", async (t) => {
  const p = await playing(t);
  const pc1 = p.pc();
  const tr = pc1.track();
  await act(async () => { tr.dispatchEvent(new Event("ended")); });
  await flush();

  assert.doesNotMatch(p.text(), /Stream has ended/, "the player must not decide the stream is over; liveness does");
  assert.match(p.text(), /Reconnecting/, "the viewer sees that it is coming back, not a frozen frame");
  assert.ok(rows.some((r) => r.startsWith("player reconnect: track-ended — ")), `rows: ${rows.join(" | ")}`);
  assert.ok(!rows.some((r) => r.startsWith("player ended")), "no 'ended' row any more");

  await p.tick(reconnectDelayMs(1));
  assert.equal(FakePC.all.length, 2, "a fresh negotiation was started by itself");
  assert.ok(pc1.closed, "the old connection was torn down");
  await p.unmount();
});

test("grace-expired after a drop reconnects, and the second track of the same end adds no second row", async (t) => {
  const p = await playing(t);
  const a = p.pc().track();
  const v = p.pc().track();
  await act(async () => { p.pc().setState("disconnected"); });
  await flush();
  assert.equal(rows.length, 0, "disconnected alone is a wait");
  await p.tick(6000);
  assert.ok(rows.some((r) => r.startsWith("player reconnect: grace-expired — ")), `rows: ${rows.join(" | ")}`);
  const before = rows.length;
  await act(async () => { a.dispatchEvent(new Event("ended")); v.dispatchEvent(new Event("ended")); });
  await flush();
  assert.equal(rows.length, before, "a reconnect already armed absorbs the track ends");
  await p.unmount();
});

test("retry: a player that has played keeps trying past the old budget, offers the escapes, and never shows the dead panel", async (t) => {
  const p = await playing(t);
  await act(async () => { p.pc().setState("failed"); });
  await flush();
  // Every attempt from here fails the way a phone with no network does.
  whepPlan = Array.from({ length: MAX_RECONNECTS + 3 }, () => "throw" as const);
  for (let n = 1; n <= MAX_RECONNECTS + 2; n++) {
    await p.tick(reconnectDelayMs(n));
    assert.doesNotMatch(p.text(), /Can't connect/, `attempt ${n}: the "can't connect" panel is for a session that never played`);
    assert.match(p.text(), /Reconnecting/, `attempt ${n}`);
  }
  assert.match(p.text(), /Compatibility mode/, "after the old budget the reconnect screen also offers the escapes");
  assert.match(p.text(), /Use the embed/);
  // The network comes back: the next try answers and connects.
  whepPlan = [];
  await p.tick(reconnectDelayMs(MAX_RECONNECTS + 3));
  assert.ok(p.pc().answered);
  await act(async () => { p.pc().setState("connected"); });
  await flush();
  assert.doesNotMatch(p.text(), /Reconnecting|Compatibility mode/, "playing again: the reconnect screen is gone");
  await p.unmount();
});

test("watchdog: an unanswered first offer waits for the relay's own deadline, then retries instead of blaming the network", async (t) => {
  whepPlan = ["hang"];
  const p = await mount(t);
  await p.tick(CONNECT_TIMEOUT_MS);
  assert.equal(rows.length, 0, "at 9 s the relay may still be answering — nothing is judged yet");
  assert.doesNotMatch(p.text(), /Can't connect/);
  await p.tick(SIGNAL_DEADLINE_MS - CONNECT_TIMEOUT_MS);
  assert.ok(rows.some((r) => /^player reconnect: watchdog — pc=new\/new phase=signal attempt=0 /.test(r)), `rows: ${rows.join(" | ")}`);
  assert.doesNotMatch(p.text(), /Can't connect/, "our own site not answering is not a network that blocks WebRTC");
  await p.tick(reconnectDelayMs(1));
  assert.equal(FakePC.all.length, 2, "the retry ran");
  await p.unmount();
});

test("watchdog: answered but the media path never comes up on a first connect — the choice panel, as before", async (t) => {
  const p = await mount(t);
  assert.ok(p.pc().answered);
  await act(async () => { p.pc().setState("connecting"); });
  await p.tick(CONNECT_TIMEOUT_MS);
  assert.match(p.text(), /Can't connect to the low-latency stream/);
  assert.ok(rows.some((r) => /^player failed: watchdog — pc=connecting\/connecting phase=connect attempt=0 /.test(r)), `rows: ${rows.join(" | ")}`);
  await p.unmount();
});

// ── a busy relay (parked P18) ────────────────────────────────────────────────
// A 429 used to end in a panel ("Too many connection attempts … try again") that
// waited for a tap. Busy is not a broken transport: the player says so, waits as
// long as Retry-After says and tries again by itself.

test("429 → busy, retried after Retry-After", async (t) => {
  whepPlan = ["busy"];
  const p = await mount(t);
  assert.match(p.text(), /The stream is busy/);
  assert.doesNotMatch(p.text(), /Can't connect|Too many connection attempts/, "busy is not a broken transport");
  assert.ok(rows.some((r) => r.startsWith("player busy: relay:429 — ")), `rows: ${rows.join(" | ")}`);
  assert.ok(!rows.some((r) => r.startsWith("player failed")), "no 'failed' row for a busy relay");
  await p.tick(7000 - 1);
  assert.equal(FakePC.all.length, 1, "it waits the whole Retry-After");
  await p.tick(1);
  assert.equal(FakePC.all.length, 2, "then tries again by itself");
  assert.ok(p.pc().answered, "and the relay answered this time");
  await act(async () => { p.pc().setState("connected"); });
  await flush();
  assert.doesNotMatch(p.text(), /busy/i, "playing: the busy screen is gone");
  await p.unmount();
});

test("429 → busy: the connect watchdog never turns a busy wait into 'Can't connect'", async (t) => {
  whepPlan = ["busy-bare"];
  const p = await mount(t);
  await p.tick(CONNECT_TIMEOUT_MS);
  assert.doesNotMatch(p.text(), /Can't connect/);
  assert.equal(FakePC.all.length, 1, "without a header the wait is 10 s");
  await p.tick(10_000 - CONNECT_TIMEOUT_MS);
  assert.equal(FakePC.all.length, 2);
  await p.unmount();
});

test("retry: busy twice, then the relay answers — the viewer never had to tap", async (t) => {
  whepPlan = ["busy", "busy"];
  const p = await mount(t);
  await p.tick(7000);
  assert.equal(FakePC.all.length, 2);
  assert.match(p.text(), /The stream is busy/, "the second answer was busy too");
  await p.tick(7000);
  assert.equal(FakePC.all.length, 3);
  assert.ok(p.pc().answered);
  await act(async () => { p.pc().setState("connected"); });
  await flush();
  assert.doesNotMatch(p.text(), /busy|Can't connect/i);
  await p.unmount();
});

test("restart: unmounting while busy cancels the retry", async (t) => {
  whepPlan = ["busy"];
  const p = await mount(t);
  await p.unmount();
  const made = FakePC.all.length;
  await act(async () => { t.mock.timers.tick(60_000); });
  await flush();
  assert.equal(FakePC.all.length, made, "no negotiation after unmount");
});

// ── the end hold and `disconnected` (parked P18; live since 2d868fda) ────────
// A track ending while the picture still moves is held, not acted on. If the
// connection then goes `disconnected` and stays there, the disconnect's own grace
// reconnects within DISCONNECT_GRACE_MS — the hold never leaves it waiting for the
// browser's ~30 s consent timeout to say `failed`.
test("disconnected stands the hold down: a reconnect within the grace, not at the consent timeout", async (t) => {
  const p = await playing(t);
  const v = p.video();
  Object.defineProperty(v, "paused", { value: false, configurable: true });
  Object.defineProperty(v, "readyState", { value: 4, configurable: true });
  const progress = async () => { await act(async () => { v.dispatchEvent(new dom.window.Event("timeupdate")); }); };
  await progress();
  const tr = p.pc().track();
  await act(async () => { tr.dispatchEvent(new Event("ended")); });
  await flush();
  assert.equal(rows.length, 0, "a moving picture after a track end is held");
  await act(async () => { p.pc().setState("disconnected"); });
  for (let s = 0; s < 6; s++) { await p.tick(1000); await progress(); }
  assert.ok(rows.some((r) => r.startsWith("player reconnect: grace-expired — ")), `rows: ${rows.join(" | ")}`);
  assert.ok(!rows.some((r) => r.startsWith("player reconnect: track-ended")), "one decision, one row");
  await p.tick(reconnectDelayMs(1));
  assert.equal(FakePC.all.length, 2, "the reconnect ran");
  await p.unmount();
});

// ── compatibility mode's end (parked P18) ────────────────────────────────────
// The element's own `ended` was not listened to: when the playlist finished, the
// picture froze under "Paused" and nothing asked stream.place whether it was over.
test("HLS end + offline → ended", async (t) => {
  playlistStatus = 404;
  const proto = dom.window.HTMLMediaElement.prototype as unknown as { canPlayType: (s: string) => string };
  const canPlayType = proto.canPlayType;
  proto.canPlayType = () => "maybe"; // the native (Safari) path: no MediaSource in this DOM
  t.after(() => { proto.canPlayType = canPlayType; playlistStatus = 200; });
  const p = await mount(t, { transport: "hls" });
  await flush();
  const v = p.video();
  assert.match(v.getAttribute("src") ?? "", /getLivePlaylist/, "compatibility mode attached the playlist");
  await act(async () => { v.dispatchEvent(new dom.window.Event("playing")); });
  await flush();
  assert.doesNotMatch(p.text(), /Stream has ended/);
  await act(async () => { v.dispatchEvent(new dom.window.Event("ended")); });
  await flush();
  assert.match(p.text(), /Stream has ended/, "the playlist is over and stream.place says the stream is not live");
  await p.unmount();
});

// ── "Smoother playback (adds delay)" on the low-latency player (parked P19) ──
test("smooth: the receivers aim for a bigger buffer; switching it off hands the buffer back, with no renegotiation", async (t) => {
  const p = await mount(t, { smooth: true });
  await act(async () => { p.pc().setState("connected"); });
  const pc = p.pc();
  pc.track();
  pc.track();
  assert.deepEqual(pc.receivers.map((r) => r.jitterBufferTarget), [SMOOTH_JITTER_BUFFER_MS, SMOOTH_JITTER_BUFFER_MS]);
  await act(async () => {
    dom.window.localStorage.setItem("chatStyle_playerSmooth", "0");
    dom.window.dispatchEvent(new dom.window.CustomEvent("bb:setting", { detail: "chatStyle_playerSmooth" }));
  });
  await flush();
  assert.deepEqual(pc.receivers.map((r) => r.jitterBufferTarget), [null, null], "the browser's own buffer again");
  assert.equal(FakePC.all.length, 1, "flipping the switch never tears the connection down");
  await p.unmount();
});

test("smooth off (the default): the receivers are left alone", async (t) => {
  const p = await playing(t);
  p.pc().track();
  assert.deepEqual(p.pc().receivers.map((r) => r.jitterBufferTarget), [null]);
  await p.unmount();
});

// ── restart ──────────────────────────────────────────────────────────────────

test("restart: the negotiation after a reconnect starts clean — its next drop counts from attempt 0", async (t) => {
  const p = await playing(t);
  await act(async () => { p.pc().setState("failed"); });
  await p.tick(reconnectDelayMs(1));
  await act(async () => { p.pc().setState("connected"); });
  await flush();
  assert.doesNotMatch(p.text(), /Reconnecting/);
  rows.length = 0;
  _resetClientErrorThrottle();
  await act(async () => { p.pc().setState("failed"); });
  await flush();
  assert.ok(rows.some((r) => / phase=media attempt=0 /.test(r)), `rows: ${rows.join(" | ")}`);
  await p.unmount();
});

test("restart: unmounting mid-reconnect stops every timer — nothing reconnects a player that is gone", async (t) => {
  const p = await playing(t);
  await act(async () => { p.pc().setState("failed"); });
  await flush();
  await p.unmount();
  const made = FakePC.all.length;
  rows.length = 0;
  await act(async () => { t.mock.timers.tick(5 * 60_000); });
  await flush();
  assert.equal(FakePC.all.length, made, "no negotiation after unmount");
  assert.equal(rows.length, 0, "no row after unmount");
});

// ── fullscreen (site.client_errors 2026-11-02 00:33 PT, Mac Safari) ─────────────
// `e.requestFullscreen().catch is not a function`: that Safari's requestFullscreen()
// returned nothing. The button is clicked on the mounted player with that engine shape.

test("fullscreen: an engine whose requestFullscreen() returns nothing — the tap goes in and out, nothing throws", async (t) => {
  const doc = dom.window.document as unknown as { fullscreenElement: Element | null; exitFullscreen?: () => unknown };
  const proto = dom.window.HTMLElement.prototype as unknown as { requestFullscreen?: () => unknown };
  const thrown: unknown[] = [];
  const onError = (e: Event) => { thrown.push((e as ErrorEvent).error ?? e); e.preventDefault(); };
  dom.window.addEventListener("error", onError);
  const calls: string[] = [];
  Object.defineProperty(doc, "fullscreenElement", { value: null, writable: true, configurable: true });
  proto.requestFullscreen = function (this: Element) { calls.push("req"); doc.fullscreenElement = this; return undefined; };
  doc.exitFullscreen = () => { calls.push("exit"); doc.fullscreenElement = null; return undefined; };
  t.after(() => {
    delete proto.requestFullscreen;
    delete doc.exitFullscreen;
    delete (doc as { fullscreenElement?: unknown }).fullscreenElement;
    dom.window.removeEventListener("error", onError);
  });
  const p = await playing(t);
  const button = p.host.querySelector('button[title="Fullscreen"]') as HTMLButtonElement | null;
  assert.ok(button, "the Fullscreen button is on the playing player");
  await act(async () => { button.click(); });
  await flush();
  await act(async () => { button.click(); });
  await flush();
  assert.deepEqual(calls, ["req", "exit"]);
  assert.equal(thrown.length, 0, `thrown: ${thrown.map(String).join(" | ")}`);
  await p.unmount();
});
