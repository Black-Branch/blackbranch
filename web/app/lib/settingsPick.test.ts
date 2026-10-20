// The "applied preset" marker the settings menu and the terminal share: which
// slot the current look came from, and whether something changed since.
//
// Run: node --test app/lib/settingsPick.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import "./testTsx.ts";
import { resetStorage } from "./testDom.ts";
const { lsGet, lsSetJSON } = await import("./safeLocalStorage.ts");
const { readPick, writePick, markPickEdited, PICK_KEY } = await import("./settingsPick.ts");

test("readPick: absent, malformed and out-of-range are null; edited is read as a strict boolean", () => {
  resetStorage();
  assert.equal(readPick(), null);
  lsSetJSON(PICK_KEY(), { slot: 9, edited: false });
  assert.equal(readPick(), null);
  lsSetJSON(PICK_KEY(), { slot: 2, edited: "yes" });
  assert.deepEqual(readPick(), { slot: 2, edited: false });
  lsSetJSON(PICK_KEY(), { slot: 3, edited: true });
  assert.deepEqual(readPick(), { slot: 3, edited: true });
});

test("writePick stores or removes; markPickEdited flips an applied slot to edited and leaves the rest alone", () => {
  resetStorage();
  writePick({ slot: 1, edited: false });
  assert.deepEqual(readPick(), { slot: 1, edited: false });
  markPickEdited();
  assert.deepEqual(readPick(), { slot: 1, edited: true });
  markPickEdited();
  assert.deepEqual(readPick(), { slot: 1, edited: true }, "already edited stays");
  writePick(null);
  assert.equal(lsGet(PICK_KEY()), null);
  markPickEdited();
  assert.equal(readPick(), null, "nothing applied, nothing to mark");
});
