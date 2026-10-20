// The sign-in device check. See signinDevice.ts.
//
// Run: node --test app/lib/signinDevice.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { deviceMismatch } from "./signinDevice.ts";

test("match — the normal case on our own server (MAS honours the requested id): no refusal", () => {
  assert.equal(deviceMismatch("ABCD1234ef", { device_id: "ABCD1234ef" }), null);
});

test("mismatch — the server bound the token to another device: refused", () => {
  assert.match(deviceMismatch("ABCD1234ef", { device_id: "ZZZZ9999" }) ?? "", /different device/);
  // Case matters: device ids are opaque strings, not case-folded.
  assert.notEqual(deviceMismatch("abcd1234ef", { device_id: "ABCD1234EF" }), null);
});

test("either side missing is a refusal, never a pass", () => {
  for (const whoami of [null, undefined, {}, { device_id: "" }, { device_id: 42 }]) {
    assert.notEqual(deviceMismatch("ABCD1234ef", whoami as never), null, JSON.stringify(whoami));
  }
  for (const requested of [undefined, null, ""]) {
    assert.notEqual(deviceMismatch(requested, { device_id: "ABCD1234ef" }), null, String(requested));
  }
});

// Both callbacks must check BEFORE anything is persisted. A route handler
// cannot run under node --test (next/headers, the pg pool), so this is an
// ordering scan — positive assertions throughout, anchored on the last
// statement of each file.
for (const route of ["app/api/auth/mas-callback/route.ts", "app/api/auth/matrix-callback/route.ts"]) {
  test(`${route} refuses a device mismatch before writing anything`, () => {
    const raw = readFileSync(join(process.cwd(), route), "utf8");
    assert.match(raw.slice(-300), /federated-complete\?token=\$\{pendingToken\}[\s\S]*\}\s*$/,
      `${route} did not end as expected — the read is truncated`);
    const src = stripComments(raw);
    // matrix-callback's decisions (the device check among them) live in federatedSignIn.ts, run
    // and tested there with a stub transport; here the route must act on that outcome first.
    const federated = route.includes("matrix-callback");
    const whoami = federated ? src.indexOf("completeFederatedCallback(") : src.indexOf("account/whoami");
    const check = federated ? src.indexOf("if (!outcome.ok) return fail(outcome.error)") : src.indexOf("deviceMismatch(stateData.deviceId, whoami)");
    const refuse = federated ? check : src.indexOf("error=device_mismatch");
    assert.ok(whoami > 0 && check > whoami, "the check must use the whoami answer");
    assert.ok(refuse >= check, "a refusal must redirect with device_mismatch");
    for (const write of ["checkSignupAllowed(", "INSERT INTO site.users", "INSERT INTO site.user_sessions", "createLoginHandoff(", "resolveSiteIdentity("]) {
      const at = src.indexOf(write);
      assert.ok(at > 0, `${route} no longer contains ${write} — update this scan`);
      assert.ok(check < at, `${route}: ${write} runs before the device check`);
    }
  });
}
