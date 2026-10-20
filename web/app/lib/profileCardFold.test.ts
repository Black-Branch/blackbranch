import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsFoldLabel } from "./profileCardFold.ts";

test("a green device folds to a plain 'Settings'", () => {
  assert.equal(settingsFoldLabel({ verdict: "green", pendingVerification: false }), "Settings");
});

test("a device that still needs encryption set up says so on the folded row", () => {
  assert.equal(settingsFoldLabel({ verdict: "red", pendingVerification: false }), "Settings · encryption needs setup");
  assert.equal(settingsFoldLabel({ verdict: null, pendingVerification: false }), "Settings · encryption needs setup");
});

test("a pending verification wins over the verdict, as the row itself does", () => {
  assert.equal(settingsFoldLabel({ verdict: "yellow", pendingVerification: true }), "Settings · verification pending");
});
