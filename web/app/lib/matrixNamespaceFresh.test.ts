// A fresh install: no matrix.legacyNamespace in the build, so every reader and writer uses the
// product namespace alone — nothing is read from, or written under, a prefix this install never had.
// The read-both install is matrixNamespace.test.ts.
// Run: node --test app/lib/matrixNamespaceFresh.test.ts
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.INSTALL_VALUES;
const {
  ROOM_TYPE, FORUM_TITLE, FORUM_TAGS, FORUM_BODY, USERNAME_COLOR, MUTE_RULE, HIDDEN_PEOPLE, IGNORED_BOTS, readFirst,
} = await import("./matrixNamespace.ts");

const NAMES = [
  [ROOM_TYPE, "room_type"], [FORUM_TITLE, "forum.title"], [FORUM_TAGS, "forum.tags"],
  [FORUM_BODY, "forum.body"], [USERNAME_COLOR, "username_color"], [MUTE_RULE, "mute"],
  [HIDDEN_PEOPLE, "hidden_people"], [IGNORED_BOTS, "ignored_bots"],
] as const;

test("unset legacy prefix: readers accept only the product name, writers write it", () => {
  for (const [n, suffix] of NAMES) {
    assert.deepEqual(n.read, [`app.blackbranch.${suffix}`], suffix);
    assert.equal(n.write, `app.blackbranch.${suffix}`, suffix);
  }
});

test("unset legacy prefix: a value under any other prefix is not read", () => {
  const data: Record<string, unknown> = { "org.example.room_type": "old" };
  assert.equal(readFirst(ROOM_TYPE, (k) => data[k] as string | undefined), undefined);
  data["app.blackbranch.room_type"] = "new";
  assert.equal(readFirst(ROOM_TYPE, (k) => data[k] as string | undefined), "new");
});
