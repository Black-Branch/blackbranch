// A malformed site.legacyId is ignored: it names browser storage (legacyStorage.ts), so anything
// but one lower-case word is treated as unset.
// Run: node --test app/lib/nativePlatformBadLegacy.test.ts
import test from "node:test";
import assert from "node:assert/strict";

process.env.INSTALL_VALUES = JSON.stringify({ "site.legacyId": "x'); DROP TABLE site.users; --" });
const np = await import("./nativePlatform.ts");

test("an id that is not one lower-case word is ignored", () => {
  assert.equal(np.legacyNativePlatform(), null);
  assert.equal(np.normalizePlatform("x'); DROP TABLE site.users; --"), "x'); DROP TABLE site.users; --", "passed through as an unknown platform, never mapped");
  assert.equal(np.NATIVE_SQL, "('native')");
});
