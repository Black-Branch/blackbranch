// The one rule that turns "a beat 40 s ago + Matrix says unavailable" into a
// dot and a sentence. Every row of the precedence table, pinned against a
// fixed clock so the windows are numbers, not vibes.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/presenceState.test.ts

import { test } from "node:test";
import { siteName } from "./siteName.ts";
import assert from "node:assert/strict";
import {
  HERE_MS, AWAY_AFTER_MS,
  deriveState, presenceLine, pageFromPath, statusToMatrix, beatIntervalMs, isSelfStatus,
  type SitePresenceRow,
} from "./presenceState.ts";

const NOW = Date.parse("2026-09-14T20:00:00Z");
// The fold window is private to the module (check-orphans); the tests carry the spec's number.
const FOLD_MS = 14 * 24 * 3600 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (over: Partial<SitePresenceRow> = {}): SitePresenceRow => ({
  lastBeat: null, lastVisible: null, lastCommunity: null, lastLogin: null,
  status: "online", statusText: "", supporter: false, ...over,
});

test("the presence windows are fixed numbers", () => {
  assert.equal(HERE_MS, 150_000);
  assert.equal(AWAY_AFTER_MS, 300_000);
  assert.equal(beatIntervalMs(true), 30_000);
  assert.equal(beatIntervalMs(false), 60_000);
});

test("in the community: a recent beat, a recent visible beat and a recent community beat", () => {
  const r = row({ lastBeat: ago(40_000), lastVisible: ago(40_000), lastCommunity: ago(40_000) });
  assert.equal(deriveState(r, null, NOW).state, "community");
});

test("on the site: recent + visible but no community beat (or a stale one)", () => {
  assert.equal(deriveState(row({ lastBeat: ago(40_000), lastVisible: ago(40_000) }), null, NOW).state, "site");
  assert.equal(deriveState(row({ lastBeat: ago(40_000), lastVisible: ago(40_000), lastCommunity: ago(HERE_MS + 1) }), null, NOW).state, "site");
});

test("the HERE window edge: 149 s is here, 151 s is gone", () => {
  assert.equal(deriveState(row({ lastBeat: ago(149_000), lastVisible: ago(149_000) }), null, NOW).state, "site");
  assert.equal(deriveState(row({ lastBeat: ago(151_000), lastVisible: ago(151_000) }), null, NOW).state, "offline");
});

test("away: still beating but the tab has been hidden for 5 minutes (edge 299 s vs 301 s)", () => {
  assert.equal(deriveState(row({ lastBeat: ago(30_000), lastVisible: ago(299_000) }), null, NOW).state, "site");
  assert.equal(deriveState(row({ lastBeat: ago(30_000), lastVisible: ago(301_000) }), null, NOW).state, "away");
});

test("online elsewhere: no beat here, Matrix says online", () => {
  assert.equal(deriveState(null, { presence: "online", lastActiveTs: NOW - 5_000 }, NOW).state, "elsewhere");
  assert.equal(deriveState(row({ lastBeat: ago(HERE_MS + 1) }), { presence: "online", lastActiveTs: null }, NOW).state, "elsewhere");
});

test("Matrix unavailable with nothing here reads as away; Matrix offline as offline", () => {
  assert.equal(deriveState(null, { presence: "unavailable", lastActiveTs: null }, NOW).state, "away");
  assert.equal(deriveState(null, { presence: "offline", lastActiveTs: null }, NOW).state, "offline");
  assert.equal(deriveState(null, null, NOW).state, "offline");
});

test("a site beat outranks Matrix: here + Matrix unavailable is still here", () => {
  assert.equal(deriveState(row({ lastBeat: ago(10_000), lastVisible: ago(10_000) }), { presence: "unavailable", lastActiveTs: null }, NOW).state, "site");
});

test("Do Not Disturb paints over any live signal, never over offline", () => {
  const here = row({ lastBeat: ago(10_000), lastVisible: ago(10_000), status: "dnd" });
  assert.equal(deriveState(here, null, NOW).state, "dnd");
  assert.equal(deriveState(row({ status: "dnd" }), { presence: "online", lastActiveTs: null }, NOW).state, "dnd");
  assert.equal(deriveState(row({ status: "dnd" }), { presence: "unavailable", lastActiveTs: null }, NOW).state, "dnd");
  assert.equal(deriveState(row({ status: "dnd" }), null, NOW).state, "offline", "DND with no signal is just offline");
});

test("Idle forces away over any live signal, never over offline", () => {
  assert.equal(deriveState(row({ lastBeat: ago(10_000), lastVisible: ago(10_000), lastCommunity: ago(10_000), status: "idle" }), null, NOW).state, "away");
  assert.equal(deriveState(row({ status: "idle" }), { presence: "online", lastActiveTs: null }, NOW).state, "away");
  assert.equal(deriveState(row({ status: "idle" }), null, NOW).state, "offline");
});

test("lastActive is the newest of the beat, Matrix's last-active and the site login; nulls ignored", () => {
  const r = row({ lastBeat: ago(3_600_000), lastLogin: ago(60_000) });
  assert.equal(deriveState(r, { presence: "offline", lastActiveTs: NOW - 7_200_000 }, NOW).lastActive, NOW - 60_000);
  assert.equal(deriveState(row(), null, NOW).lastActive, null);
  assert.equal(deriveState(null, { presence: "offline", lastActiveTs: NOW - 10 }, NOW).lastActive, NOW - 10);
});

test("inactive = offline AND last active older than 14 days (or never); a live state never folds", () => {
  assert.equal(deriveState(row({ lastLogin: ago(FOLD_MS + 1) }), null, NOW).inactive, true);
  assert.equal(deriveState(row({ lastLogin: ago(FOLD_MS - 1) }), null, NOW).inactive, false);
  assert.equal(deriveState(row(), null, NOW).inactive, true, "never seen at all folds");
  assert.equal(deriveState(row({ lastBeat: ago(10_000), lastVisible: ago(10_000), lastLogin: ago(FOLD_MS * 2) }), null, NOW).inactive, false);
});

test("the relative-time buckets, read through the offline line", () => {
  const seen = (msAgo: number) => presenceLine("offline", NOW - msAgo, NOW);
  assert.equal(seen(30_000), "Offline · last seen just now");
  assert.equal(seen(5 * 60_000), "Offline · last seen 5 min ago");
  assert.equal(seen(3 * 3_600_000), "Offline · last seen 3 h ago");
  assert.equal(seen(3 * 86_400_000), "Offline · last seen 3 days ago");
  assert.equal(seen(1 * 86_400_000), "Offline · last seen 1 day ago");
  assert.equal(seen(91 * 86_400_000), "Offline · last seen a long time ago");
});

test("presenceLine wording, every state", () => {
  assert.equal(presenceLine("community", null, NOW), "In the community");
  assert.equal(presenceLine("site", null, NOW), `On ${siteName()}`);
  assert.equal(presenceLine("elsewhere", null, NOW), "Online on Matrix");
  assert.equal(presenceLine("away", null, NOW), "Away");
  assert.equal(presenceLine("dnd", null, NOW), "Do not disturb");
  assert.equal(presenceLine("offline", NOW - 3 * 86_400_000, NOW), "Offline · last seen 3 days ago");
  assert.equal(presenceLine("offline", null, NOW), "Offline");
});

test("pageFromPath is coarse: the raw path never leaves the tab", () => {
  assert.equal(pageFromPath("/"), "stream");
  assert.equal(pageFromPath("/community"), "community");
  assert.equal(pageFromPath("/community/!abc:site.test"), "community");
  assert.equal(pageFromPath("/radio"), "radio");
  assert.equal(pageFromPath("/settings/theme"), "other");
  assert.equal(pageFromPath("/mod"), "other");
});

test("statusToMatrix: the four status rows", () => {
  assert.deepEqual(statusToMatrix("online", "hi"), { presence: "online", status_msg: "hi" });
  assert.deepEqual(statusToMatrix("idle", "brb"), { presence: "unavailable", status_msg: "brb" });
  assert.deepEqual(statusToMatrix("dnd", "focus"), { presence: "online", status_msg: "focus" }, "Matrix has no DND — online + text is the honest limit");
  assert.deepEqual(statusToMatrix("invisible", "secret"), { presence: "offline", status_msg: "" }, "invisible clears any old custom text at the homeserver, not just presence");
  assert.deepEqual(statusToMatrix("online", ""), { presence: "online", status_msg: "" }, "an empty text CLEARS the message (omitting the key would keep the old one)");
});

test("isSelfStatus accepts exactly the four", () => {
  for (const s of ["online", "idle", "dnd", "invisible"]) assert.equal(isSelfStatus(s), true);
  for (const s of ["busy", "", null, 3, "Online"]) assert.equal(isSelfStatus(s), false);
});
