// The site's own platform id (nativePlatform.ts) on a FRESH install: no old word in the build, so
// "native" is the only id anything reads, writes or maps. nativePlatformLegacy.test.ts is the
// install that had an older word.
// Run: node --test app/lib/nativePlatform.test.ts
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.INSTALL_VALUES;
const np = await import("./nativePlatform.ts");

test("fresh install: one id, and the SQL list names exactly it", () => {
  assert.equal(np.NATIVE_PLATFORM, "native");
  assert.equal(np.NATIVE_SQL, "('native')");
  assert.equal(np.legacyNativePlatform(), null);
});

test("fresh install: only \"native\" is the site's own; normalizePlatform changes nothing", () => {
  assert.equal(np.isNativePlatform("native"), true);
  for (const p of ["twitch", "youtube", "", null, undefined, "NATIVE", "system"]) assert.equal(np.isNativePlatform(p), false, String(p));
  for (const p of ["native", "twitch", "", null]) assert.equal(np.normalizePlatform(p), p, String(p));
});
