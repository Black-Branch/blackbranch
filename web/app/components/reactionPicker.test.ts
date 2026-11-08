// The three quick reactions on a message's toolbar and long-press sheet (ticket #192: "the chat
// quick action emojis look ugly and random"). They were the last three keys used, so the row
// reshuffled after every reaction and a new viewer saw no row at all. Now: the viewer's own most
// used reactions, ties broken by the more recent, filled from the curated defaults until there
// are three — a row that stays put.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/components/reactionPicker.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dom, resetStorage } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
const { getRecentReactions, saveRecentReaction } = await import("./ReactionPicker.tsx");

const USES = "bb_reaction_uses";
const LEGACY = "bb_recent_reactions";

beforeEach(() => resetStorage());

const use = (...keys: string[]) => { for (const k of keys) saveRecentReaction(k); };

test("recents ranked by count; empty history → 👍 ❤️ 😂", () => {
  assert.deepEqual(getRecentReactions(), ["👍", "❤️", "😂"], "a new viewer gets the curated three");
  use("🔥", "🎉", "🔥", ":OMEGALUL:", "🔥", "🎉");
  assert.deepEqual(getRecentReactions(), ["🔥", "🎉", ":OMEGALUL:"], "most used first");
});

test("ties are broken by recency, and one more use does not reshuffle a settled row", () => {
  use("😮", "🔥");
  assert.deepEqual(getRecentReactions(), ["🔥", "😮", "👍"], "equal counts: the more recent first");
  use("🔥", "🔥", "😮", "😮", "😮");
  assert.deepEqual(getRecentReactions(), ["😮", "🔥", "👍"]);
  // The old last-used row would have put 🎉 first here; ranked, it waits its turn.
  use("🎉");
  assert.deepEqual(getRecentReactions(), ["😮", "🔥", "🎉"]);
  assert.equal(getRecentReactions()[0], "😮", "the most used stays first after a one-off");
});

test("the curated list fills the gaps and never shows a key twice", () => {
  use("❤️");
  assert.deepEqual(getRecentReactions(), ["❤️", "👍", "😂"]);
});

test("restart: a new session ranks from what the last one stored", () => {
  // As a previous page load left it: newest first, each with its count.
  dom.window.localStorage.setItem(USES, JSON.stringify([["😢", 1], ["🔥", 4], ["👀", 4]]));
  assert.deepEqual(getRecentReactions(), ["🔥", "👀", "😢"]);
  use("😢");
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(USES) ?? "[]")[0], ["😢", 2], "the write goes back to storage");
});

test("restart: a viewer with only the old recent list keeps it, newest first", () => {
  dom.window.localStorage.setItem(LEGACY, JSON.stringify(["🎉", "😮"]));
  assert.deepEqual(getRecentReactions(), ["🎉", "😮", "👍"]);
});

test("retry: the same reaction used again counts again, and is listed once", () => {
  use("🔥");
  use("🔥");
  const stored = JSON.parse(dom.window.localStorage.getItem(USES) ?? "[]") as [string, number][];
  assert.deepEqual(stored, [["🔥", 2]]);
});

test("damaged storage reads as no history, never a throw", () => {
  dom.window.localStorage.setItem(USES, "{not json");
  assert.deepEqual(getRecentReactions(), ["👍", "❤️", "😂"]);
  dom.window.localStorage.setItem(USES, JSON.stringify([["🔥", "x"], 7, null, ["", 2], ["😮", 3]]));
  assert.deepEqual(getRecentReactions(), ["😮", "👍", "❤️"], "only well-formed entries count");
});

test("the stored list is capped, and the least used goes first", () => {
  use("🔥", "🔥");
  for (let i = 0; i < 40; i++) use(`:e${i}:`);
  const stored = JSON.parse(dom.window.localStorage.getItem(USES) ?? "[]") as [string, number][];
  assert.equal(stored.length, 32);
  assert.ok(stored.some(([k]) => k === "🔥"), "the most used survives the cap");
  assert.equal(getRecentReactions()[0], "🔥");
});
