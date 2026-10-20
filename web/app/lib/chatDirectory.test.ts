// The chat directory: who is present, under which names, in what colour.
//
// Three features share it and each would break differently, so the tests are
// grouped by the failure they prevent rather than by function.
//
// Run: node --test app/lib/chatDirectory.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatDirectory, mentionsAnyOf, matchMention } from "./chatDirectory.ts";
import { DEFAULT_NAME_COLOR } from "./colors.ts";
import type { ChatMsg } from "./chatMsg.ts";

const msg = (o: Partial<ChatMsg>): ChatMsg =>
  ({ id: "1", platform: "native", username: "someone", message: "", ts: 1, ...o }) as ChatMsg;

// ── @ by username AND by matrix id ───────────────────────────────────────────

test("a person is findable by display name AND by matrix localpart", () => {
  // The point of the index. A site user shows as "Bobby McGee" while their id is
  // @bob:site.test — `@bob` must complete to them, which bare display names
  // with no identity attached cannot do.
  const d = buildChatDirectory([
    msg({ username: "Bobby McGee", matrixId: "@bob:site.test" }),
  ]);
  assert.equal(d.byKey.get("bob")?.name, "Bobby McGee");
  assert.equal(d.byKey.get("bobby mcgee")?.name, "Bobby McGee");
  // …and what gets WRITTEN is the display name, not the key that matched it.
  assert.deepEqual(d.list.map((p) => p.name), ["Bobby McGee"]);
});

test("the same person twice is one entry, keyed on identity not name", () => {
  // A rename mid-buffer must not produce two candidates for one human, and the
  // NEWEST name is the one to offer.
  const d = buildChatDirectory([
    msg({ id: "1", username: "OldName", matrixId: "@bob:site.test", ts: 1 }),
    msg({ id: "2", username: "NewName", matrixId: "@bob:site.test", ts: 2 }),
  ]);
  assert.equal(d.list.length, 1);
  assert.equal(d.list[0]!.name, "NewName");
});

test("two platform chatters sharing a display name stay separate people", () => {
  // No matrix id to key on, so identity falls back to the name — which is
  // correct: without an id there is nothing to tell them apart, and merging
  // them would attribute one person's colour to the other.
  const d = buildChatDirectory([
    msg({ id: "1", username: "ghost", platform: "twitch" }),
    msg({ id: "2", username: "ghost", platform: "kick" }),
  ]);
  assert.equal(d.list.length, 1, "same name, no ids: one entry is the honest answer");
});

test("candidates are recency-ordered, and nobody is capped out", () => {
  // No small cap on distinct chatters — a cap would quietly stop offering
  // people during a busy stream, which is exactly when you want to address
  // someone by name.
  const many = Array.from({ length: 50 }, (_, i) =>
    msg({ id: String(i), username: `user${i}`, matrixId: `@user${i}:site.test`, ts: i }));
  const d = buildChatDirectory(many);
  assert.equal(d.list.length, 50, "every distinct speaker must be reachable");
  assert.equal(d.list[0]!.name, "user49", "most recent speaker first");
});

// ── the mention token ────────────────────────────────────────────────────────

test("trailing punctuation is not part of the name", () => {
  // "@bob," must tag bob and leave the comma outside the coloured span.
  assert.deepEqual(matchMention("@bob,"), { name: "bob", trail: "," });
  assert.deepEqual(matchMention("@bob"), { name: "bob", trail: "" });
  assert.equal(matchMention("bob"), null, "no @, no mention");
  assert.equal(matchMention("@"), null, "a bare @ is punctuation");
  assert.equal(matchMention("a@b.example"), null, "an email is not a mention");
});

test("a mention carries the mentioned person's own colour", () => {
  const d = buildChatDirectory([msg({ username: "bob", usernameColor: "#7fd1ff" })]);
  assert.equal(d.byKey.get("bob")?.color, "#7fd1ff");
});

test("someone with no colour gets the shared default, not black", () => {
  const d = buildChatDirectory([msg({ username: "bob" })]);
  assert.equal(d.byKey.get("bob")?.color, DEFAULT_NAME_COLOR);
});

test("an unreadable colour is contrast-clamped like any other name", () => {
  // Platform colours can land too dark to read; the mention must go through the
  // same clamp the username does, or a mention is legible in one place and not
  // the other.
  const d = buildChatDirectory([msg({ username: "bob", usernameColor: "#000000" })]);
  assert.notEqual(d.byKey.get("bob")?.color, "#000000");
});

test("the viewer's own colour override reaches their mentions too", () => {
  const d = buildChatDirectory([msg({ username: "me", matrixId: "@me:site.test" })], {
    userId: "@me:site.test",
    ownColor: "#abcdef",
  });
  assert.equal(d.byKey.get("me")?.color, "#abcdef");
});

// ── the private "you were tagged" highlight ──────────────────────────────────

test("a mention of one of your names tags you", () => {
  const names = new Set(["k", "oldhandle"]);
  assert.equal(mentionsAnyOf("hey @k are you there", names), true);
  assert.equal(mentionsAnyOf("@oldhandle", names), true);
  assert.equal(mentionsAnyOf("@K", names), true, "case must not matter");
  assert.equal(mentionsAnyOf("@k, look", names), true, "punctuation must not matter");
});

test("your name in ordinary prose does NOT tag you", () => {
  // The rule that keeps the highlight meaningful. A substring/bare-name match
  // fires on every sentence that happens to contain your name, and a highlight
  // that cries wolf is one you learn to ignore — which costs you the real ones.
  const names = new Set(["k"]);
  assert.equal(mentionsAnyOf("k said that earlier", names), false, "no @, no tag");
  assert.equal(mentionsAnyOf("hey @kevin", names), false, "@kevin is not @k");
  assert.equal(mentionsAnyOf("", names), false);
  assert.equal(mentionsAnyOf(null, names), false);
  assert.equal(mentionsAnyOf("@k", new Set()), false, "nobody signed in, nobody tagged");
});

test("scanning twice in a row gives the same answer", () => {
  // The scan regex is /g and module-level. A stale `lastIndex` would make the
  // second call start mid-string, so a row would highlight on first render and
  // not on the next — the kind of bug that looks like a flicker.
  const names = new Set(["k"]);
  assert.equal(mentionsAnyOf("@k hello", names), true);
  assert.equal(mentionsAnyOf("@k hello", names), true);
});

// ── what the terminal reads (ps, top, /proc/loadavg) ───────────────────────

test("each person carries how many messages they sent and when they last spoke; the directory keeps every message time", () => {
  const d = buildChatDirectory([
    msg({ id: "1", username: "bob", matrixId: "@bob:site.test", ts: 1000 }),
    msg({ id: "2", username: "amy", platform: "twitch", ts: 2000 }),
    msg({ id: "3", username: "bob", matrixId: "@bob:site.test", ts: "1970-01-01T00:00:03.000Z" }),
  ]);
  const bob = d.list.find((p) => p.name === "bob");
  assert.equal(bob?.said, 2);
  assert.equal(bob?.lastAt, 3000);
  assert.equal(d.list.find((p) => p.name === "amy")?.platform, "twitch");
  assert.deepEqual(d.times, [1000, 2000, 3000]);
});
