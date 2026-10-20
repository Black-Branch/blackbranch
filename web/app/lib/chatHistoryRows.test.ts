// Run: node --test app/lib/chatHistoryRows.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatOrder, weave, modLine, frameToHist, passesFilters, personFilter, type ModLogRow } from "./chatHistoryRows.ts";
import type { HistMsg } from "./modHistory.ts";

const msg = (id: number, ts: number, extra: Partial<HistMsg> = {}): HistMsg => ({
  id, platform: "twitch", username: `u${id}`, message: `hello ${id}`, canonicalId: `c${id}`, matrixId: null,
  deleted: false, ts, cts: new Date(ts).toISOString(), destPlatforms: ["twitch"], replyTo: null,
  scores: { karma: null, intelligence: null }, ...extra,
});
const mod = (id: number, ts: number, extra: Partial<ModLogRow> = {}): ModLogRow => ({
  id, action: "ban", targetId: "@casey:site.test", targetName: "casey", performedBy: "@mod:site.test", modName: "Mod",
  durationMinutes: null, reason: null, at: new Date(ts).toISOString(), ...extra,
});

test("chat order: oldest at the top, newest at the bottom (the API sends newest first)", () => {
  assert.deepEqual(chatOrder([msg(3, 300), msg(1, 100), msg(2, 200)]).map((m) => m.id), [1, 2, 3]);
});

test("mod actions are woven in by time; one older than the oldest message on screen is left out", () => {
  const rows = weave([msg(2, 200), msg(1, 100)], [mod(9, 150), mod(8, 50), mod(7, 250)]);
  assert.deepEqual(rows.map((r) => r.key), ["twitch:1", "mod:9", "twitch:2", "mod:7"]);
});

test("settings work stays in Mod history; chat moderation shows in the stream", () => {
  const rows = weave([msg(1, 100)], [mod(1, 150, { action: "memory_forget" }), mod(2, 160, { action: "delete" }), mod(3, 170, { action: "sub_only_enabled", targetId: "site" })]);
  assert.deepEqual(rows.map((r) => r.key), ["twitch:1", "mod:2", "mod:3"]);
});

test("filtered to one person, only what was done to them shows", () => {
  const rows = weave([msg(1, 100)], [mod(1, 150, { targetId: "c1", targetName: null }), mod(2, 160, { targetId: "@other:x", targetName: "other" })], "c1");
  assert.deepEqual(rows.map((r) => r.key), ["twitch:1", "mod:1"]);
  assert.equal(modLine(mod(3, 0, { action: "delete", targetId: "kick:181", targetName: null })), "Mod deleted a message (#181 on kick)");
});

test("a message loaded twice (followed, then refreshed) appears once", () => {
  assert.equal(weave([msg(1, 100), msg(1, 100)], []).length, 1);
});

test("a mod line reads as a sentence", () => {
  assert.equal(modLine(mod(1, 0, { action: "timeout", durationMinutes: 60, reason: "spam" })), "Mod timed out casey for 1h — spam");
  assert.equal(modLine(mod(1, 0, { action: "sub_only_enabled", targetId: "site", modName: null })), "mod turned sub-only chat on");
  assert.equal(modLine(mod(1, 0, { action: "odd_thing", targetId: "site", modName: null })), "mod odd thing");
});

test("a live frame becomes a row; a card or sticker does not", () => {
  const h = frameToHist({ id: "42", platform: "kick", username: "casey", message: "hi", isMod: false, isVip: false, isMember: false, ts: 1000, emotes: { Kappa: "k.png" } });
  assert.equal(h?.id, 42);
  assert.deepEqual(h?.emotes, { Kappa: "k.png" });
  assert.equal(frameToHist({ id: 1, platform: "native", username: "x", message: "", isMod: false, isVip: false, isMember: false, ts: 1, system: "donation" } as never), null);
});

test("a followed message joins only if it passes the snapshot's filters", () => {
  const m = msg(1, 1, { username: "Casey", message: "Buy now", platform: "kick" });
  const none = { q: "", user: "", platform: "", deletedOnly: false };
  assert.ok(passesFilters(m, none));
  assert.ok(passesFilters(m, { ...none, q: "buy", user: "case", platform: "kick" }));
  assert.ok(!passesFilters(m, { ...none, platform: "twitch" }));
  assert.ok(!passesFilters(m, { ...none, deletedOnly: true }));
  assert.ok(passesFilters(m, { ...none, user: "c1" }), "an exact user id");
});

test("a name click filters on the Matrix id, else the user id, else the name", () => {
  assert.equal(personFilter({ matrixId: "@a:b", canonicalId: "c", username: "n" }), "@a:b");
  assert.equal(personFilter({ matrixId: null, canonicalId: "c", username: "n" }), "c");
  assert.equal(personFilter({ matrixId: null, canonicalId: null, username: "n" }), "n");
});
