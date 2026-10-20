// Source scans over StreamplaceThinPlayer's retry wiring and transport
// persistence. These live here because the invariants are in a .tsx the test
// runner cannot execute.
//
// THE DEFECT THEY PIN. Both overlay buttons called retryLowLatency, which does
// setMode("webrtc") unconditionally — so a viewer in compatibility mode who
// pressed "Try again" was moved back onto the transport that had just failed.
// On a UDP-hostile network that loop had no exit but "Use the embed".
//
// Run: node --test app/lib/playerTransportWiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const playerPath = join(here, "..", "features", "player", "StreamplaceThinPlayer.tsx");
const src = stripComments(readFileSync(playerPath, "utf8"));

test("Try again retries the transport the viewer is ON", () => {
  assert.match(src, /onClick=\{mode === "hls" \? reconnect : retryLowLatency\}/,
    "the failed panel's Try again must be mode-aware");
});

test("the ended panel never changes transport", () => {
  // Anchored on the ended block itself, not on a bare `reconnect` anywhere in
  // the file — the control bar has its own reconnect button.
  const ended = src.match(/status === "ended" &&[\s\S]{0,900}?<\/div>\s*\)\}/)?.[0];
  assert.ok(ended, "could not locate the ended panel");
  assert.match(ended, /onClick=\{reconnect\}/, "Check again must re-run the CURRENT mode");
  assert.doesNotMatch(ended, /retryLowLatency/,
    "the ended panel must not move a compatibility-mode viewer onto WebRTC");
});

test("the remembered transport is written by exactly the two deliberate clicks", () => {
  // A bare count passes with the wrong instances, so each site is pinned by
  // POSITION as well.
  const writes = [...src.matchAll(/lsSet\(TRANSPORT_KEY/g)].length;
  assert.equal(writes, 2, "only switchToHls and retryLowLatency may persist the transport");
  assert.match(src, /const switchToHls[\s\S]{0,400}?lsSet\(TRANSPORT_KEY, "hls"\)/);
  assert.match(src, /const retryLowLatency[\s\S]{0,400}?lsSet\(TRANSPORT_KEY, "webrtc"\)/);
});

test("both transport effects wait for the restore before opening a connection", () => {
  assert.match(src, /mode !== "webrtc" \|\| !transportRestored/);
  assert.match(src, /mode !== "hls" \|\| !transportRestored/);
});

test("both transport effects re-run when the restore flag flips", () => {
  // The guard above is only HALF the wiring, and pinning it alone is the exact
  // shape this suite exists to stop: delete transportRestored from either
  // effect's dependency array and the guard still reads perfectly while the
  // effect never re-runs when the flag turns true — a permanently dead player,
  // with the whole suite green. Both watchdogs live INSIDE these effects, so
  // there is nothing left to escalate "Connecting…" either.
  // react-hooks/exhaustive-deps would see it, but it is a WARNING under this
  // project's eslint config and warnings do not fail the build.
  const deps = [...src.matchAll(/\},\s*\[([^\]]*)\]\);/g)].map((m) => m[1] ?? "");
  // Each array is anchored by a dependency UNIQUE to it — the two lists differ,
  // so neither assertion can be satisfied by the other effect's array.
  const webrtc = deps.filter((d) => /\brevealControls\b/.test(d));
  assert.equal(webrtc.length, 1,
    "could not uniquely locate the WebRTC negotiate effect's dependency array by its revealControls dep");
  assert.match(webrtc[0] ?? "", /\btransportRestored\b/,
    "the WebRTC negotiate effect must depend on transportRestored, or it never re-runs when the restore completes");
  const hls = deps.filter((d) => /\bchannel\b/.test(d));
  assert.equal(hls.length, 1,
    "could not uniquely locate the HLS effect's dependency array by its channel dep");
  assert.match(hls[0] ?? "", /\btransportRestored\b/,
    "the HLS effect must depend on transportRestored, or it never re-runs when the restore completes");
});

test("the HLS failure path asks WHY before it declares a stop", () => {
  assert.match(src, /void declareStop\(\)/,
    "giveUp must route its declaration through the manifest probe");
  assert.doesNotMatch(src, /if \(!playbackHealthy\(\)\) \{ setStatus\("failed"\); return; \}/,
    "the unconditional failed-declaration is what reported an ended stream as a dead network");
});

test("VACUITY ANCHOR: the scanned file was read to the END", () => {
  const raw = readFileSync(playerPath, "utf8");
  assert.match(raw.trimEnd().slice(-40), /\}\s*$/,
    "StreamplaceThinPlayer.tsx did not end in a closing brace — the read was truncated");
});
