// Run: node --test app/lib/personalEmotes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOutgoingEmotes, mergeForInput, groupPersonalEntries } from "./personalEmotes.ts";
import type { EmoteMap } from "./emoteMap.ts";

const P: EmoteMap = {
  subEmote: { url: "https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/3.0", zeroWidth: false, ar: 1, ch: "somechannel" },
  KEKW: { url: "https://static-cdn.jtvnw.net/emoticons/v2/2/static/dark/3.0", zeroWidth: false, ar: 1, ch: "otherchannel" },
};
const G: EmoteMap = { KEKW: { url: "https://cdn.7tv.app/emote/x/2x.webp", zeroWidth: false } };
const GNAMES = new Set(Object.keys(G));

test("resolves only sender-personal words that are NOT catalog names (site catalog wins)", () => {
  const out = resolveOutgoingEmotes("hi subEmote KEKW subEmote", P, GNAMES);
  assert.deepEqual(out, { subEmote: P.subEmote!.url }); // KEKW excluded, dupes collapse
});

test("no personal words → null (field omitted upstream)", () => {
  assert.equal(resolveOutgoingEmotes("plain text KEKW", P, GNAMES), null);
  assert.equal(resolveOutgoingEmotes("", P, GNAMES), null);
});

test("splits on any whitespace run", () => {
  const out = resolveOutgoingEmotes("a\n subEmote\t b", P, GNAMES);
  assert.deepEqual(Object.keys(out ?? {}), ["subEmote"]);
});

test("mergeForInput: global wins name collisions", () => {
  const merged = mergeForInput(G, P);
  assert.equal(merged.KEKW!.url, G.KEKW!.url);
  assert.equal(merged.subEmote!.url, P.subEmote!.url);
});

test("groupPersonalEntries: per-channel groups (alpha), globals split off, collisions excluded", () => {
  const personal: EmoteMap = {
    zSub: { url: "uZ", zeroWidth: false, ch: "zebra" },
    aSub: { url: "uA", zeroWidth: false, ch: "aardvark" },
    aSub2: { url: "uA2", zeroWidth: false, ch: "aardvark" },
    Kappa: { url: "uK", zeroWidth: false, ch: null },
    ghost: { url: "uG", zeroWidth: false, ch: "" },
    KEKW: { url: "uC", zeroWidth: false, ch: "aardvark" }, // collides with catalog → excluded
  };
  const g = groupPersonalEntries(G, personal);
  assert.deepEqual(g.channels.map(([c]) => c), ["aardvark", "zebra"]);
  assert.deepEqual(g.channels[0]![1].map(([n]) => n), ["aSub", "aSub2"]);
  assert.deepEqual(g.other.map(([n]) => n), ["ghost"]);
  assert.deepEqual(g.globals.map(([n]) => n), ["Kappa"]);
  assert.equal(g.count, 5);
});

test("groupPersonalEntries: v1 cache entries without ch read as globals (transient until the server refresh)", () => {
  const g = groupPersonalEntries({}, { old: { url: "u", zeroWidth: false } });
  assert.deepEqual(g.globals.map(([n]) => n), ["old"]);
  assert.equal(g.channels.length, 0);
});
