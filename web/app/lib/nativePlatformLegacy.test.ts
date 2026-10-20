// An install that stored an older word for the site's own platform before the rename (the install
// key site.legacyId, a build value — set before the module loads; "oldsite" is made up). Nothing is
// stored under it any more; it can only ARRIVE (an old page's request, an old link, old browser
// storage), so only normalizePlatform knows it — the stored-data readers name "native" alone.
// Run: node --test app/lib/nativePlatformLegacy.test.ts
import test from "node:test";
import assert from "node:assert/strict";

process.env.INSTALL_VALUES = JSON.stringify({ "site.legacyId": "oldsite" });
const np = await import("./nativePlatform.ts");

test("the old word is read as \"native\" at the door, and nowhere else", () => {
  assert.equal(np.legacyNativePlatform(), "oldsite");
  assert.equal(np.normalizePlatform("oldsite"), "native");
  assert.equal(np.normalizePlatform("native"), "native");
  assert.equal(np.normalizePlatform("youtube"), "youtube");
  assert.equal(np.isNativePlatform("oldsite"), false, "behind the door nothing compares the old word");
  assert.equal(np.NATIVE_SQL, "('native')", "stored data holds only native since migrate-v146");
});
