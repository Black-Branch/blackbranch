import { test } from "node:test";
import assert from "node:assert/strict";
import { readInboundVideoCounters, buildPlayerEvent } from "./playerTelemetry.ts";

test("reads the video inbound-rtp report and nothing else; absent fields are null, never 0", () => {
  const reports = [
    { type: "inbound-rtp", kind: "audio", packetsLost: 9, jitter: 0.02 },
    { type: "inbound-rtp", kind: "video", packetsLost: 3, freezeCount: 2, totalFreezesDuration: 1.25, nackCount: 7, jitter: 0.011, framesDecoded: 1200 },
    { type: "candidate-pair", state: "succeeded" },
  ];
  const c = readInboundVideoCounters(reports);
  assert.equal(c.packetsLost, 3);
  assert.equal(c.freezeCount, 2);
  assert.equal(c.totalFreezesDuration, 1.25);
  assert.equal(c.nackCount, 7);
  assert.equal(c.jitter, 0.011);
  assert.equal(c.framesDecoded, 1200);
  assert.equal(c.pliCount, null);
  assert.equal(c.totalPausesDuration, null);
  assert.equal(c.framesDropped, null);
});

test("no video report at all → every counter null", () => {
  const c = readInboundVideoCounters([{ type: "inbound-rtp", kind: "audio" }]);
  assert.ok(Object.values(c).every((v) => v === null));
});

test("the message names kind, reason, states, attempt and node, and the stack is the JSON payload", () => {
  const ev = buildPlayerEvent({
    kind: "reconnect", reason: "grace-expired", connectionState: "disconnected", iceConnectionState: "disconnected",
    attempt: 2, node: "https://prod-sea0.stream.place", mode: "webrtc",
    counters: { freezeCount: 1, totalFreezesDuration: 0.5, totalPausesDuration: null, packetsLost: 4, nackCount: 0, pliCount: null, jitter: 0.01, framesDecoded: 10, framesDropped: null },
  });
  assert.equal(ev.message, "player reconnect: grace-expired — pc=disconnected/disconnected attempt=2 node=https://prod-sea0.stream.place");
  const parsed = JSON.parse(ev.stack);
  assert.equal(parsed.kind, "reconnect");
  assert.equal(parsed.counters.packetsLost, 4);
  assert.equal(parsed.counters.pliCount, null);
});

test("an unknown node prints as ? and a null counters block survives", () => {
  const ev = buildPlayerEvent({ kind: "failed", reason: "not-advancing", connectionState: "failed", iceConnectionState: "failed", attempt: 4, node: null, mode: "webrtc", counters: null });
  assert.match(ev.message, / node=\?$/);
  assert.equal(JSON.parse(ev.stack).counters, null);
});
