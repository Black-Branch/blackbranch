// Tests for the WHEP escalation policy.
//
// This exists because the bug it fixes was reported from LIVE USE — viewers on a
// working beta player were being demoted mid-stream — and the transport itself
// cannot be tested offline (WebRTC will not handshake against a dead stream).
// Pulling the decision into a pure function makes the POLICY testable even
// though the connection is not.
//
// Run: node --test app/lib/whepEscalation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Hls from "hls.js";
import { stripComments } from "./testSource.ts";
import { hlsConfigFor } from "./hlsConfig.ts";
const HLS_CONFIG = hlsConfigFor(false); // the ordinary config — hlsConfig.test.ts covers the smooth one
import {
  escalationFor, escalationAfterGrace, playbackIsAdvancing, reconnectDelayMs, retryBudgetSpent, offerChoicesWhileReconnecting,
  watchdogVerdict, DISCONNECT_GRACE_MS, MAX_RECONNECTS, CONNECT_TIMEOUT_MS, SIGNAL_DEADLINE_MS, ICE_CHECK_MS, ICE_GATHER_CAP_MS,
  WHEP_RELAY_TIMEOUT_MS, BUSY_RETRY_S, busyRetryMs,
} from "./whepEscalation.ts";

const base = { everConnected: true, aborted: false };

test("THE REGRESSION: `disconnected` must NOT escalate — it is transient", () => {
  const a = escalationFor({ ...base, state: "disconnected" });
  assert.equal(a.kind, "wait", "a brief network blip must not tear down a working connection");
  assert.equal((a as { graceMs: number }).graceMs, DISCONNECT_GRACE_MS);
});

test("grace window outlasts an ICE consent check", () => {
  // Consent checks run on a ~5s cadence; a shorter window reports failures the
  // transport was about to recover from all by itself.
  assert.ok(DISCONNECT_GRACE_MS >= 5000, "grace shorter than the consent-check cadence is a false alarm");
});

test("`failed` after a good connection retries over WebRTC", () => {
  assert.deepEqual(escalationFor({ ...base, state: "failed" }), { kind: "reconnect" });
});

test("`failed` having NEVER connected stops and offers the choice — no retry on a transport that has never worked", () => {
  // WebRTC does not work on this network at all (blocked UDP, hostile proxy) —
  // retrying the same transport cannot help.
  assert.deepEqual(
    escalationFor({ ...base, state: "failed", everConnected: false }),
    { kind: "fallback" }
  );
});

// ── Retry: a session that has played keeps trying for as long as it is mounted ──
// Prod 10-30: an Android phone lost its network for minutes at a time; the old
// ten-try budget ended a long dead spot in "Can't connect" and a tap. The site's
// liveness unmounts the player when the stream is over, so "keep trying" ends
// when the stream does.

test("retry: `failed` after a good connection reconnects with no budget — the hundredth time too", () => {
  assert.deepEqual(escalationFor({ ...base, state: "failed" }), { kind: "reconnect" });
  for (const retryCount of [0, MAX_RECONNECTS - 1, MAX_RECONNECTS, 100]) {
    assert.equal(retryBudgetSpent({ everConnected: true, retryCount }), false, `retry ${retryCount} after playing`);
  }
});

test("retry: a session that has NEVER played still stops at the budget and offers the choice", () => {
  assert.equal(retryBudgetSpent({ everConnected: false, retryCount: MAX_RECONNECTS - 1 }), false);
  assert.equal(retryBudgetSpent({ everConnected: false, retryCount: MAX_RECONNECTS }), true);
});

test("retry: a long reconnect also offers the escapes, from the old budget on", () => {
  assert.equal(offerChoicesWhileReconnecting(MAX_RECONNECTS - 1), false);
  assert.equal(offerChoicesWhileReconnecting(MAX_RECONNECTS), true);
  assert.equal(offerChoicesWhileReconnecting(50), true);
});

// ── The watchdog: judged by how far the attempt got ─────────────────────────

test("the signal deadline is derived from the relay's own: the player never abandons a request the relay can still answer", () => {
  assert.equal(SIGNAL_DEADLINE_MS, ICE_GATHER_CAP_MS + WHEP_RELAY_TIMEOUT_MS + 2000);
  assert.ok(SIGNAL_DEADLINE_MS > ICE_GATHER_CAP_MS + WHEP_RELAY_TIMEOUT_MS, "an answer the relay sends at its deadline must still be awaited");
  assert.ok(SIGNAL_DEADLINE_MS > CONNECT_TIMEOUT_MS, "the old single 9 s deadline cut the relay off");
});

test("watchdog: while the offer is unanswered it waits out the signal deadline, then retries — even a first connect", () => {
  for (const phase of ["ice", "signal"] as const) {
    assert.deepEqual(watchdogVerdict({ phase, elapsedMs: CONNECT_TIMEOUT_MS, answeredAtMs: null, everConnected: false }),
      { kind: "wait", ms: SIGNAL_DEADLINE_MS - CONNECT_TIMEOUT_MS }, `${phase} at 9 s`);
    // Our own site did not answer: that is the viewer's HTTP, not a network
    // that blocks WebRTC — never "Compatibility mode usually works".
    assert.deepEqual(watchdogVerdict({ phase, elapsedMs: SIGNAL_DEADLINE_MS, answeredAtMs: null, everConnected: false }), { kind: "reconnect" });
    assert.deepEqual(watchdogVerdict({ phase, elapsedMs: SIGNAL_DEADLINE_MS, answeredAtMs: null, everConnected: true }), { kind: "reconnect" });
  }
});

test("watchdog: answered but never connected — the media path is judged, and only a never-played session gets the choice", () => {
  const early = { phase: "connect" as const, answeredAtMs: 400 };
  assert.deepEqual(watchdogVerdict({ ...early, elapsedMs: 5000, everConnected: false }), { kind: "wait", ms: CONNECT_TIMEOUT_MS - 5000 });
  assert.deepEqual(watchdogVerdict({ ...early, elapsedMs: CONNECT_TIMEOUT_MS, everConnected: false }), { kind: "fallback" });
  assert.deepEqual(watchdogVerdict({ ...early, elapsedMs: CONNECT_TIMEOUT_MS, everConnected: true }), { kind: "reconnect" });
});

test("watchdog: a late answer still gets its full ICE window", () => {
  const late = { phase: "connect" as const, answeredAtMs: 11_000, everConnected: false };
  assert.deepEqual(watchdogVerdict({ ...late, elapsedMs: 11_000 }), { kind: "wait", ms: ICE_CHECK_MS });
  assert.deepEqual(watchdogVerdict({ ...late, elapsedMs: 11_000 + ICE_CHECK_MS }), { kind: "fallback" });
});

test("watchdog: a playing attempt is left alone", () => {
  assert.deepEqual(watchdogVerdict({ phase: "media", elapsedMs: 60_000, answeredAtMs: 500, everConnected: true }), { kind: "none" });
});

test("a teardown WE initiated is never read as a failure", () => {
  // Unmount/mode-switch drives the connection to "closed". Without this guard it
  // looks identical to the far side dropping us, and would trigger a spurious
  // fallback on the way out.
  for (const state of ["closed", "failed", "disconnected"] as const) {
    assert.deepEqual(escalationFor({ ...base, state, aborted: true }), { kind: "none" });
  }
});

test("healthy states do nothing", () => {
  for (const state of ["new", "connecting", "connected"] as const) {
    assert.deepEqual(escalationFor({ ...base, state }), { kind: "none" });
  }
});

test("`closed` from the far side IS terminal (only `aborted` excuses it)", () => {
  assert.deepEqual(escalationFor({ ...base, state: "closed" }), { kind: "reconnect" });
  assert.deepEqual(
    escalationFor({ ...base, state: "closed", everConnected: false }),
    { kind: "fallback" }
  );
});

test("after grace expires, a still-disconnected link is treated as failed — and keeps being retried", () => {
  // Prod: `grace-expired — pc=disconnected/disconnected` is the commonest row
  // (Android, Windows Firefox). It reconnects; it never ends in the panel.
  assert.deepEqual(escalationAfterGrace(base), { kind: "reconnect" });
  assert.deepEqual(escalationAfterGrace({ ...base, everConnected: false }), { kind: "fallback" });
});

test("a blip that heals costs the viewer nothing", () => {
  // The sequence that was breaking people: connected -> disconnected -> connected.
  // Nothing in that path may escalate, and the retry budget must be untouched,
  // so a later genuine failure still gets its full allowance.
  const blip = escalationFor({ ...base, state: "disconnected" });
  assert.equal(blip.kind, "wait");
  const healed = escalationFor({ ...base, state: "connected" });
  assert.equal(healed.kind, "none");
  assert.deepEqual(escalationFor({ ...base, state: "failed" }), { kind: "reconnect" });
});

// ── playbackIsAdvancing: never contradict the picture on screen ──────────────
//
// k, on reviewing the auto-fallback removal: "The demotions were happening on
// working playback, this makes me nervous that it will pass on warnings for
// working playback instead of the demotions now."
//
// Exactly right, and this predicate is the answer. The old ladder demoted
// viewers whose video was playing fine; if the replacement painted a
// full-screen "Can't connect" over that same working video it would be a worse
// regression, not a fix. Every failure path in StreamplaceThinPlayer is gated
// on this returning false.

test("PLAYING video is never treated as failed, whatever the connection says", () => {
  // The exact case that caused the original bug: pc says disconnected/failed,
  // media is still flowing. The player must stay out of the way.
  assert.equal(playbackIsAdvancing({
    paused: false, readyState: 4, lastProgressAt: 1_000_000, now: 1_000_500,
  }), true);
});

test("progress that has gone stale IS a stall", () => {
  assert.equal(playbackIsAdvancing({
    paused: false, readyState: 4, lastProgressAt: 1_000_000, now: 1_004_000,
  }), false);
});

test("the stale boundary is exclusive and tunable", () => {
  const at = (now: number, staleMs?: number) =>
    playbackIsAdvancing({ paused: false, readyState: 4, lastProgressAt: 0, now, staleMs });
  assert.equal(at(2999), true);
  assert.equal(at(3000), false, "exactly staleMs old counts as stalled");
  assert.equal(at(5000, 6000), true, "a longer window keeps it healthy");
});

test("a paused video is not 'advancing' — the viewer stopped it deliberately", () => {
  // It must not read as healthy (nothing is advancing). The player never arms a
  // stall loop on a pause — only a real transport failure arms one, and
  // recovery (`connected` / `playing`) cancels it — so a pause reaches no
  // failure path; it is handled by `paused` state alone.
  assert.equal(playbackIsAdvancing({
    paused: true, readyState: 4, lastProgressAt: 1_000_000, now: 1_000_100,
  }), false);
});

test("a decoder with nothing to show is not advancing, even with a fresh timestamp", () => {
  // readyState < HAVE_CURRENT_DATA: a timeupdate could have landed just before
  // the buffer ran dry. There is no picture, so this must not block the panel.
  for (const readyState of [0, 1]) {
    assert.equal(playbackIsAdvancing({
      paused: false, readyState, lastProgressAt: 1_000_000, now: 1_000_100,
    }), false, `readyState ${readyState} should not count as playing`);
  }
  assert.equal(playbackIsAdvancing({
    paused: false, readyState: 2, lastProgressAt: 1_000_000, now: 1_000_100,
  }), true, "HAVE_CURRENT_DATA is the threshold");
});

// ── the player must actually route every stop through the guard ─────────────
// Source scans: the transport cannot run offline, so the invariants that live in
// the component are pinned by reading it — comments stripped, and the read
// proven complete first (a truncated read makes every doesNotMatch vacuous).

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PLAYER = "app/features/player/StreamplaceThinPlayer.tsx";

function readPlayer(): string {
  const src = readFileSync(join(webRoot, PLAYER), "utf8");
  assert.match(
    src.slice(-400), /iceGatheringState === "complete"[\s\S]*}\s*$/,
    `${PLAYER} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

test("no stop in StreamplaceThinPlayer bypasses the playback guard", () => {
  const src = readPlayer();

  // Every failure declaration sits behind a !playbackHealthy() check. A
  // declaration is either a literal setStatus("failed") or a call to
  // declareStop() — declareStop probes the playlist and resolves to
  // setStatus(hlsFailureKind(...)) ("ended" or "failed"), so that inner call
  // is the RESOLUTION of an already-guarded path, not a second, unguarded one.
  // There are exactly two declarations: the WebRTC failIfStalled and the HLS
  // giveUp's declareStop; any other is a path that can paint an error over
  // working video. (A relay 429 is "busy" and declares nothing.)
  const failed = src.match(/setStatus\("failed"\)/g) ?? [];
  const declareStopCalls = src.match(/void declareStop\(\)/g) ?? [];
  assert.equal(failed.length + declareStopCalls.length, 2,
    `expected 2 guarded failure declarations (setStatus("failed") or declareStop()), found ${failed.length + declareStopCalls.length} — a new ` +
    'failure path was added; route it through failIfStalled()/giveUp()');
  const guardedFailed = src.match(/if \(!playbackHealthy\(\)\) \{[^}]*(?:setStatus\("failed"\)|void declareStop\(\))/g) ?? [];
  assert.equal(guardedFailed.length, 2,
    'a failure declaration (setStatus("failed") or declareStop()) is no longer behind !playbackHealthy()');

  // "ended" has no WebRTC writer at all: a track the node ends is a reconnect
  // (prod 10-18 → 10-31: ten "Stream has ended" panels over a live stream).
  // The one way to "ended" is compatibility mode's 404 probe, hlsFailureKind,
  // which already sits behind the guard above (declareStop).
  assert.equal((src.match(/setStatus\("ended"\)/g) ?? []).length, 0, 'a literal setStatus("ended") is back');
  assert.equal((src.match(/setStatus\(hlsFailureKind\(status\)\)/g) ?? []).length, 1, "the HLS probe is the one writer of ended");

  // And the removed rungs must stay removed.
  assert.doesNotMatch(src, /setMode\("hls"\)[^;]*;\s*return;\s*\}\s*retryCountRef/,
    "the automatic WebRTC→HLS demotion is back");
  assert.doesNotMatch(src, /onFallbackRef/,
    "the HLS→embed auto-demotion is back — it rewrites a PERSISTED preference");
});

test("a track the node ends reconnects once the picture has stopped — the end is liveness's call, not the player's", () => {
  // Was "an ended broadcast is sticky": the player declared "Stream has ended"
  // on a track's `ended` and cancelled the armed reconnect. On prod that panel
  // sat over a live stream until a tap (track-ended attempt=0, ten times on one
  // viewer). The player is mounted only while liveness says stream.place is
  // live, so a track end is the node dropping us. Run in
  // features/player/streamplaceReconnect.render.test.ts; pinned here too.
  const src = readPlayer();
  assert.match(src, /e\.track\.addEventListener\("ended", \(\) => \{ if \(!aborted\) reconnectIfTrackStalled\(\); \}\)/,
    "a track ending must go through the guarded hold");
  assert.match(src, /if \(!playbackHealthy\(\)\) \{ endRechecks = 0; scheduleReconnect\("track-ended"\); return; \}/,
    "a stopped picture after a track end reconnects, with its own reason");
  assert.match(src, /MAX_END_RECHECKS = 5/);
  assert.match(src, /if \(endRechecks >= MAX_END_RECHECKS\) \{ endRechecks = 0; return; \}/,
    "fifteen seconds of moving picture after a track end is not a stop: the hold stands down");
  assert.doesNotMatch(src, /endedRef/, "the sticky end gate is back — it cancelled the reconnect a live stream needed");
  assert.match(src, /const scheduleReconnect = \(reason: string\) => \{\s*if \(aborted \|\| retryRef\.current\) return;/,
    "an armed reconnect absorbs a second track's end (one row per drop)");
});

test("recovery cancels the stall loops", () => {
  // An armed loop must not outlive recovery: a paused video counts as stalled,
  // so an armed loop would paint "Can't reach the stream" when the viewer
  // pressed Pause.
  const src = readPlayer();
  const connected = src.match(/if \(st === "connected"\) \{[\s\S]*?return;\s*\}/)?.[0] ?? "";
  assert.match(connected, /clearStall\(\);/, "the WebRTC `connected` branch must cancel failIfStalled's re-check loop");
  const playing = src.match(/const onPlaying = \(\) => \{[^}]*\}/)?.[0] ?? "";
  assert.match(playing, /clearStall\(\)/, "the HLS `playing` handler must cancel giveUp's re-check loop");
});

test("a manual retry keeps what the session learned about the transport", () => {
  const src = readPlayer();
  // Scoped to the function's own closing `};` (column 2, matching the two-space
  // body indent) rather than the first `}`: an inner block added ahead of a
  // re-added reset would silently truncate the capture and go vacuous.
  const retry = src.match(/const retryLowLatency = \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.ok(retry, "retryLowLatency not found");
  assert.doesNotMatch(retry, /everConnectedRef\.current = false/,
    "resetting everConnected made any early failure after 'Try again' skip all four retries");
});

test("three hardenings: MediaSession play goes through tryPlay, the dead needsTap branch is gone, a track without msid still plays", () => {
  const src = readPlayer();
  assert.match(src, /ms\.setActionHandler\("play", tryPlay\)/);
  assert.doesNotMatch(src, /if \(needsTap\) \{ tryPlay\(\); return; \}/, "the tap-to-play button covers the video; this branch was unreachable");
  assert.match(src, /synthetic\.addTrack\(e\.track\)/);
});

test("compatibility mode cannot hang on Connecting…", () => {
  // A rejected import("hls.js") — a stale tab across a deploy — must not leave
  // "Connecting…" up forever; the watchdog covers HLS as well as WebRTC.
  const src = readPlayer();
  assert.match(src, /start\(\)\.catch\(\(\) => \{ if \(!cancelled\) giveUp\(\); \}\);/);
  assert.match(src, /if \(!cancelled && !playedOnce\) giveUp\(\);\s*\}, CONNECT_TIMEOUT_MS\);/);
  assert.match(src, /playedOnce = true; clearStall\(\)/, "a real `playing` must disarm the watchdog");
  assert.match(src, /cancelled = true;\s*clearTimeout\(watchdog\);/, "the cleanup must clear the watchdog first");
});

test("compatibility mode catches up to live — and its config actually constructs", () => {
  // hls.js validates the USER config and throws when liveMaxLatencyDurationCount
  // arrives without liveSyncDurationCount. A source scan cannot see a runtime
  // validator; the first version of this config was green here and threw for
  // every non-Safari viewer. So: construct it.
  assert.doesNotThrow(() => new Hls(HLS_CONFIG), "hls.js rejected HLS_CONFIG at construction");
  assert.equal(HLS_CONFIG.lowLatencyMode, true, "the catch-up is gated on it; stated on purpose");
  assert.equal(HLS_CONFIG.liveSyncDurationCount, 3, "hls.js's default, restated for the validator");
  assert.equal(HLS_CONFIG.maxLiveSyncPlaybackRate, 1.5, "hls.js returns early at exactly 1");
  assert.equal(HLS_CONFIG.liveMaxLatencyDurationCount, 10, "must be finite, and greater than liveSyncDurationCount");
  assert.ok(!("enableWorker" in HLS_CONFIG), "a restated default");
  // Constructed above with these in it, so hls.js accepted them.
  assert.equal(HLS_CONFIG.backBufferLength, 30, "the default Infinity keeps every played second of a live stream");
  assert.equal(HLS_CONFIG.capLevelToPlayerSize, true, "never decode a level larger than the box");
  const made = new Hls(HLS_CONFIG);
  assert.equal(made.config.backBufferLength, 30, "hls.js did not take the back-buffer cap");
  assert.equal(made.config.capLevelToPlayerSize, true);
  made.destroy();
  const src = readPlayer();
  assert.match(src, /new Hls\(hlsConfigFor\(smooth\)\)/, "the component must build from the exported configs (hlsConfig.test.ts constructs both)");
});

test("the stats poll is WebRTC-only, like the panel and its toggle", () => {
  const src = readPlayer();
  assert.match(src, /if \(status !== "playing" \|\| !showStats \|\| mode !== "webrtc"\) return;/);
  assert.match(src, /\}, \[status, showStats, mode\]\);/);
  const toHls = src.match(/const switchToHls = \(\) => \{[^}]*\}/)?.[0] ?? "";
  assert.match(toHls, /setShowStats\(false\)/, "switching back must not show a panel nobody asked for");
});

// A relay 429 is "busy": wait as long as Retry-After says (10 s without one) and
// try again by itself. The wait is bounded both ways — a 0 must not become a
// tight loop, and a huge value must not leave a viewer waiting minutes.
test("busy: the wait comes from Retry-After, bounded, 10 s by default", () => {
  assert.equal(BUSY_RETRY_S, 10);
  assert.equal(busyRetryMs(null), 10_000, "no header");
  assert.equal(busyRetryMs("7"), 7_000);
  assert.equal(busyRetryMs(" 12 "), 12_000);
  assert.equal(busyRetryMs("soon"), 10_000, "junk is the default, never NaN");
  assert.equal(busyRetryMs("0"), 2_000, "never a tight loop");
  assert.equal(busyRetryMs("-5"), 10_000, "a negative is junk");
  assert.equal(busyRetryMs("3600"), 60_000, "never a wait of minutes");
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  assert.equal(busyRetryMs(new Date(now + 20_000).toUTCString(), now), 20_000, "an HTTP date counts from now");
  assert.equal(busyRetryMs(new Date(now - 20_000).toUTCString(), now), 2_000, "a date already past is the floor");
});

test("the relay's 429 sits before the generic reconnect and never reads as a broken transport", () => {
  const src = readPlayer();
  assert.match(src, /if \(res\.status === 429\) \{ waitWhileBusy\(res\.headers\.get\("retry-after"\)\); return; \}\s*if \(!res\.ok\) \{ scheduleReconnect\(`relay:\$\{res\.status\}`\); return; \}/,
    "the 429 branch must come first and return: the generic branch would count it as a transport failure");
  assert.doesNotMatch(src, /failReason|"throttled"/, "the terminal 'too many attempts' panel is gone; busy retries by itself");
});

test("the HLS giveUp loop is bounded like the WebRTC end hold", () => {
  const src = readPlayer();
  assert.match(src, /MAX_GIVE_UP_RECHECKS = 5/);
  assert.match(src, /if \(giveUpRechecks >= MAX_GIVE_UP_RECHECKS\) \{\s*giveUpRechecks = 0;\s*v\.addEventListener\("waiting", onWaiting, \{ once: true \}\);\s*return;\s*\}\s*giveUpRechecks \+= 1;\s*stallTimer = setTimeout/,
    "stand down after the cap, but arm the element's `waiting` so a buffer that outlasts the window is still judged when it runs dry; the counter must advance on every scheduled re-check");
  assert.match(src, /const onWaiting = \(\) => \{ giveUp\(\); \};/);
  assert.match(src, /v\.removeEventListener\("waiting", onWaiting\);/, "the one-shot listener is removed on teardown");
  assert.match(src, /const onPlaying = \(\) => \{ if \(!cancelled\) \{ playedOnce = true; clearStall\(\); giveUpRechecks = 0;/,
    "a real `playing` resets the budget");
});

// ── The reconnect ladder ─────────────────────────────────────────────────────
//
// One node-side blip of ~8 minutes can hit many viewers at once, and a short
// ladder — 4 tries at 2/4/6/8 s, each behind a 9 s connect timeout — burns out
// in about a minute and leaves "Can't connect" on screen for the rest of the
// blip. A one-minute relay outage must not end in "reload the page". The
// ladder grows and then holds, long enough to outlast a short node blip, and
// it lives HERE so the schedule is a tested value, not an inline formula.

test("the reconnect ladder grows and then holds: 2, 4, 8, 15, then 30 s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(reconnectDelayMs), [2000, 4000, 8000, 15000, 30000, 30000, 30000]);
  // A count that was never incremented (defensive: the player increments
  // before scheduling) still waits the first rung, never zero.
  assert.equal(reconnectDelayMs(0), 2000);
  assert.equal(reconnectDelayMs(-1), 2000);
});

test("the escapes appear after more than three minutes of trying, never sooner", () => {
  assert.equal(MAX_RECONNECTS, 10);
  const waits = Array.from({ length: MAX_RECONNECTS }, (_, i) => reconnectDelayMs(i + 1)).reduce((a, b) => a + b, 0);
  // A short node blip ends before the screen asks the viewer to do anything.
  assert.ok(waits >= 180_000, `waits total ${waits} ms — the old ladder's 20 s stranded a viewer`);
});

test("the player schedules from the ladder and takes its budget from this module", () => {
  const src = readPlayer();
  assert.match(src, /const delay = reconnectDelayMs\(retryCountRef\.current\);/, "the delay must come from reconnectDelayMs");
  assert.doesNotMatch(src, /Math\.min\(2000 \*/, "the inline 2s→8s formula is back");
  assert.doesNotMatch(src, /const MAX_RECONNECTS =/, "the budget must not be redefined in the player");
  assert.match(src, /import \{[^}]*\bretryBudgetSpent\b[^}]*\} from "@\/app\/lib\/whepEscalation";/, "the budget is the policy module's");
  assert.match(src, /if \(retryBudgetSpent\(\{ everConnected: everConnectedRef\.current, retryCount: retryCountRef\.current \}\)\) \{ failIfStalled\("max-reconnects"\); return; \}/,
    "the cap applies only through retryBudgetSpent — a session that has played is never capped");
  assert.doesNotMatch(src, /retryCountRef\.current >= MAX_RECONNECTS/, "a raw cap check is back");
  assert.doesNotMatch(src, /const CONNECT_TIMEOUT_MS =/, "the connect deadline must not be redefined in the player");
  assert.match(src, /watchdogVerdict\(\{ phase, elapsedMs: Date\.now\(\) - startedAt, answeredAtMs: answeredAt, everConnected: everConnectedRef\.current \}\)/,
    "the watchdog is judged by the policy module, by phase");
});
