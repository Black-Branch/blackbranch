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
import { HLS_CONFIG } from "./hlsConfig.ts";
import { escalationFor, escalationAfterGrace, playbackIsAdvancing, reconnectDelayMs, DISCONNECT_GRACE_MS, MAX_RECONNECTS } from "./whepEscalation.ts";

const base = { everConnected: true, retryCount: 0, maxReconnects: 4, aborted: false };

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

test("retry budget is honoured: the last retry falls back instead of looping", () => {
  assert.deepEqual(escalationFor({ ...base, state: "failed", retryCount: 3 }), { kind: "reconnect" });
  assert.deepEqual(escalationFor({ ...base, state: "failed", retryCount: 4 }), { kind: "fallback" });
  assert.deepEqual(escalationFor({ ...base, state: "failed", retryCount: 9 }), { kind: "fallback" });
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

test("after grace expires, a still-disconnected link is treated as failed", () => {
  assert.deepEqual(escalationAfterGrace(base), { kind: "reconnect" });
  assert.deepEqual(escalationAfterGrace({ ...base, retryCount: 4 }), { kind: "fallback" });
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
  assert.deepEqual(escalationFor({ ...base, state: "failed", retryCount: 0 }), { kind: "reconnect" });
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
  // There are exactly two declarations: the WebRTC failIfStalled (which the
  // relay's 429 branch now calls into as failIfStalled("relay:429") rather
  // than repeating the guard inline — one writer of "failed", not two), and
  // the HLS giveUp's declareStop; any other is a path that can paint an error
  // over working video.
  const failed = src.match(/setStatus\("failed"\)/g) ?? [];
  const declareStopCalls = src.match(/void declareStop\(\)/g) ?? [];
  assert.equal(failed.length + declareStopCalls.length, 2,
    `expected 2 guarded failure declarations (setStatus("failed") or declareStop()), found ${failed.length + declareStopCalls.length} — a new ` +
    'failure path was added; route it through failIfStalled()/giveUp()');
  const guardedFailed = src.match(/if \(!playbackHealthy\(\)\) \{[^}]*(?:setStatus\("failed"\)|void declareStop\(\))/g) ?? [];
  assert.equal(guardedFailed.length, 2,
    'a failure declaration (setStatus("failed") or declareStop()) is no longer behind !playbackHealthy()');
  // The 429 branch is a CALLER of failIfStalled, not a second inline guard.
  assert.match(src, /if \(!playbackHealthy\(\)\) \{ clearTimeout\(watchdog\); failIfStalled\("relay:429"\); \}/,
    "the 429 branch must delegate to failIfStalled rather than declaring \"failed\" itself");

  // "ended" is a stop too. A remote track ending is confirmed against the
  // picture the same way — frames can advance for a few seconds after the
  // event — so it has exactly one writer, and that writer is guarded.
  const ended = src.match(/setStatus\("ended"\)/g) ?? [];
  assert.equal(ended.length, 1, `expected 1 guarded setStatus("ended"), found ${ended.length}`);
  assert.match(src, /if \(!playbackHealthy\(\)\) \{[^}]*setStatus\("ended"\)/,
    'setStatus("ended") is not behind !playbackHealthy() — an end can be declared over advancing frames');

  // And the removed rungs must stay removed.
  assert.doesNotMatch(src, /setMode\("hls"\)[^;]*;\s*return;\s*\}\s*retryCountRef/,
    "the automatic WebRTC→HLS demotion is back");
  assert.doesNotMatch(src, /onFallbackRef/,
    "the HLS→embed auto-demotion is back — it rewrites a PERSISTED preference");
});

test("an ended broadcast is sticky — the reconnect machinery stands down", () => {
  // The peer connection follows the ended tracks into `failed`. Without these
  // gates that would overwrite "Stream has ended" with four reconnects and a
  // panel blaming the viewer's network.
  const src = readPlayer();
  assert.match(src, /const scheduleReconnect = \(reason: string\) => \{\s*if \(aborted \|\| retryRef\.current \|\| endedRef\.current \|\| endTimer\) return;/);
  assert.match(src, /const failIfStalled = \(reason: string\) => \{\s*if \(aborted \|\| endedRef\.current \|\| endTimer\) return;/);
  assert.match(src, /if \(endedRef\.current \|\| endTimer\) return;/,
    "the connection-state handler must stand down while an end is declared or pending");
  assert.match(src, /endedRef\.current = false;/, "a fresh negotiation clears the ended state");
  assert.match(src, /if \(st === "connected"\) \{[\s\S]*?return;\s*\}\s*if \(endedRef\.current \|\| endTimer\) return;/,
    "the end gate must follow the connected branch — a connect must still win");

  // The wire from the event to the guarded hold, the bound on that hold, and the
  // cancellation of an armed reconnect. Without the bound, one track of two
  // ending over a still-moving picture re-arms the hold forever and gates every
  // escalation path for the life of the negotiation.
  assert.match(src, /e\.track\.addEventListener\("ended", \(\) => \{ if \(!aborted\) endIfStalled\(\); \}\)/,
    "a track ending must go through endIfStalled, or 'ended' is unreachable");
  assert.match(src, /MAX_END_RECHECKS = 5/);
  assert.match(src, /if \(endRechecks >= MAX_END_RECHECKS\) \{\s*endRechecks = 0;[\s\S]*?applyEscalation\(escalationFor\(\{[\s\S]*?state: pc\.connectionState,?\s*\}\), `state:\$\{pc\.connectionState\}`\);\s*return;\s*\}/,
    "the stand-down must re-judge the connection");
  assert.match(src, /if \(!playbackHealthy\(\)\) \{[^}]*clearRetry\(\);[^}]*setStatus\("ended"\)/,
    "declaring an end must cancel an armed reconnect");
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
  assert.match(src, /new Hls\(HLS_CONFIG\)/, "the component must use the one exported literal");
});

test("the stats poll is WebRTC-only, like the panel and its toggle", () => {
  const src = readPlayer();
  assert.match(src, /if \(status !== "playing" \|\| !showStats \|\| mode !== "webrtc"\) return;/);
  assert.match(src, /\}, \[status, showStats, mode\]\);/);
  const toHls = src.match(/const switchToHls = \(\) => \{[^}]*\}/)?.[0] ?? "";
  assert.match(toHls, /setShowStats\(false\)/, "switching back must not show a panel nobody asked for");
});

test("a 429 from the relay is terminal with its own words, and never a reconnect", () => {
  const src = readPlayer();
  assert.match(src, /if \(res\.status === 429\) \{\s*setFailReason\("throttled"\);\s*if \(!playbackHealthy\(\)\) \{ clearTimeout\(watchdog\); failIfStalled\("relay:429"\); \}\s*return;\s*\}\s*if \(!res\.ok\) \{ scheduleReconnect\(`relay:\$\{res\.status\}`\); return; \}/,
    "the 429 branch must sit BEFORE the generic !ok reconnect, cancel the watchdog (its reconnect would retry into the budget) and return without scheduling one");
  assert.match(src, /failReason === "throttled"\s*\? "Too many connection attempts from this network"/);
  assert.match(src, /mode === "webrtc" && failReason !== "throttled" && \(/, "Compatibility mode spends the same budget — hidden while throttled");
  // Every negotiation starts clean — the WebRTC IIFE and the HLS start(), and
  // nowhere else (a clear on the manual restarts would be a second, partial
  // mechanism: the watchdog's automatic reconnect is not a manual restart).
  assert.equal((src.match(/setFailReason\(null\)/g) ?? []).length, 2, "the two negotiation tops");
  assert.match(src, /setStatus\("connecting"\);\s*setFailReason\(null\);[\s\S]*?const offer = await pc\.createOffer\(\)/, "WebRTC: cleared before the offer");
  assert.match(src, /const start = async \(\) => \{\s*setStatus\("connecting"\);\s*setFailReason\(null\);/, "HLS: cleared at the top of start()");
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

test("the retry budget outlasts a short node blip: the waits alone span more than three minutes", () => {
  assert.equal(MAX_RECONNECTS, 10);
  const waits = Array.from({ length: MAX_RECONNECTS }, (_, i) => reconnectDelayMs(i + 1)).reduce((a, b) => a + b, 0);
  // Each attempt also sits behind the player's 9 s connect timeout, so the
  // wall time to "Can't connect" is longer still — about five minutes.
  assert.ok(waits >= 180_000, `waits total ${waits} ms — the old ladder's 20 s is what stranded chido`);
});

test("the player schedules from the ladder and takes its budget from this module", () => {
  const src = readPlayer();
  assert.match(src, /const delay = reconnectDelayMs\(retryCountRef\.current\);/, "the delay must come from reconnectDelayMs");
  assert.doesNotMatch(src, /Math\.min\(2000 \*/, "the inline 2s→8s formula is back");
  assert.doesNotMatch(src, /const MAX_RECONNECTS =/, "the budget must not be redefined in the player");
  assert.match(src, /import \{[^}]*\bMAX_RECONNECTS\b[^}]*\} from "@\/app\/lib\/whepEscalation";/, "the budget is imported from the policy module");
  assert.match(src, /if \(retryCountRef\.current >= MAX_RECONNECTS\) \{ failIfStalled\("max-reconnects"\); return; \}/, "the cap check itself is unchanged");
});
