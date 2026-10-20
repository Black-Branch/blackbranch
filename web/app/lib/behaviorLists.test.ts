// Behavior — the account lists (hidden people, highlighted words).
// Run: node --test app/lib/behaviorLists.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { isLegacyCanonicalId, sanitizeLists, hiddenMatcher, wordsMatcher, addHidden, removeHidden, setWords,
  MAX_HIDDEN, MAX_WORDS, MAX_WORD_LEN,
} from "./behaviorLists.ts";

test("sanitize keeps well-formed entries and drops junk, never throws", () => {
  assert.deepEqual(sanitizeLists(null), { hidden: [], words: [] });
  assert.deepEqual(sanitizeLists("x"), { hidden: [], words: [] });
  const got = sanitizeLists({
    hidden: [{ id: "abc123", name: "Bob" }, { id: "", name: "x" }, { id: 5 }, "nope",
      { id: "def", name: "Al", matrixId: "@al:site.test" }, { id: "abc123", name: "dupe" }],
    words: ["  Tacos ", "", 7, "tacos", "x".repeat(MAX_WORD_LEN + 1), "chess club"],
  });
  assert.deepEqual(got, {
    hidden: [{ id: "abc123", name: "Bob", matrixId: null }, { id: "def", name: "Al", matrixId: "@al:site.test" }],
    words: ["tacos", "chess club"],
  });
});

test("sanitize caps the list sizes", () => {
  const many = Array.from({ length: MAX_HIDDEN + 5 }, (_, i) => ({ id: `id${i}`, name: `n${i}` }));
  assert.equal(sanitizeLists({ hidden: many }).hidden.length, MAX_HIDDEN);
  const words = Array.from({ length: MAX_WORDS + 5 }, (_, i) => `w${i}`);
  assert.equal(sanitizeLists({ words }).words.length, MAX_WORDS);
});

test("a hidden person is matched by the line's public id OR Matrix id", () => {
  const is = hiddenMatcher({ hidden: [
    { id: "@bob:site.test", name: "Bob", matrixId: "@bob:site.test" },
    { id: "pTW", name: "Tw", matrixId: null },
  ], words: [] });
  assert.equal(is({ publicId: "pX", matrixId: "@bob:site.test" }), true);
  assert.equal(is({ publicId: "pTW" }), true);
  assert.equal(is({ publicId: "pZ", matrixId: "@x:site.test" }), false);
  assert.equal(is({}), false);
});

test("sanitize keeps only id, name and matrixId — a client-sent `also` is dropped", () => {
  const l = sanitizeLists({ hidden: [{ id: "pA", name: "A", also: ["p1"] }] });
  assert.deepEqual(l.hidden, [{ id: "pA", name: "A", matrixId: null }]);
});

test("a canonical id has the legacy shape; a public id and a Matrix id do not", () => {
  assert.equal(isLegacyCanonicalId("0a1b2c3d4e5f"), true);
  assert.equal(isLegacyCanonicalId("pu3gJNBXjyly4SjOA0ZD5H870"), false);
  assert.equal(isLegacyCanonicalId("@casey:site.test"), false);
});

test("add refuses yourself and duplicates; remove by id", () => {
  const me = { ownIds: ["me1"], matrixId: "@me:site.test" };
  let l = { hidden: [], words: [] } as ReturnType<typeof sanitizeLists>;
  assert.equal(addHidden(l, { id: "me1", name: "Me" }, me), null, "hid yourself by one of your public ids");
  assert.equal(addHidden(l, { id: "zz", name: "Me", matrixId: "@me:site.test" }, me), null, "hid yourself by matrix id");
  l = addHidden(l, { id: "c1", name: "Bob" }, me)!;
  assert.equal(l.hidden.length, 1);
  assert.equal(addHidden(l, { id: "c1", name: "Bob again" }, me), null);
  assert.deepEqual(removeHidden(l, "c1").hidden, []);
});

test("highlighted words: whole words and phrases, any case, special characters are literal", () => {
  const hit = wordsMatcher(["tacos", "chess club", "c++"]);
  assert.equal(hit("I love TACOS!"), true);
  assert.equal(hit("tacosalad"), false);
  assert.equal(hit("the Chess Club meets"), true);
  assert.equal(hit("I write C++ daily"), true);
  assert.equal(hit("nothing here"), false);
  assert.equal(wordsMatcher([])("tacos"), false);
});

test("setWords cleans the same way as sanitize", () => {
  const l = setWords({ hidden: [], words: [] }, ["  A ", "a", "b"]);
  assert.deepEqual(l.words, ["a", "b"]);
});

test("a long display name is cut, not replaced by the id", () => {
  const long = "A".repeat(90);
  const got = sanitizeLists({ hidden: [{ id: "c9", name: long }] });
  assert.equal(got.hidden[0]!.name, long.slice(0, 64));
});
