// Sign-out teardown guard.
//
// signOutEverything() composes four side-effects, so a behavioural unit test
// would only re-state its own mocks. What actually matters — and what this
// static check pins — is that the four calls stay TOGETHER and in ORDER:
// server logout + crypto-store wipe + device-ID clear must all happen before
// the signOut() navigation, and the device ID must never outlive its
// OlmMachine (the OTK-conflict invariant). Losing any one call, or reordering
// signOut() first, silently re-introduces the orphaned-device class of bug.
//
// Run: node --test app/lib/signOutEverything.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "signOutEverything.ts"),
  "utf8"
);

test("the session unit tears down together, navigation last", () => {
  const order = [
    'postJson("/api/matrix/logout")',
    "clearAllMatrixDatabases()",
    "clearDeviceId()",
    'signOut({ callbackUrl: "/" })',
  ];
  let at = -1;
  for (const call of order) {
    const i = src.indexOf(call);
    assert.ok(i >= 0, `missing teardown call: ${call}`);
    assert.ok(i > at, `${call} is out of order — navigation must come last`);
    at = i;
  }
});

test("the OTK-conflict invariant comment travels with the code", () => {
  assert.match(src, /never reuse a device ID/i);
  assert.match(src, /OTK-conflict invariant/);
});
