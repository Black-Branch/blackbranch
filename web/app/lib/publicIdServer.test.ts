// web makes and reads the SAME public id stream-api puts on the live chat socket: the history a
// viewer scrolls back through and the frames they receive live must name one person on one
// platform with one id, and the card / mod lookups must read an id from either source.
// Run: node --test app/lib/publicIdServer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STREAM_API_SECRET = "test-secret-for-public-ids";
const { publicIdFor, parsePublicId, _resetPublicIdKeyForTests } = await import("./publicIdServer.ts");
_resetPublicIdKeyForTests();

// Made by stream-api/pseudonym.js itself, with the same secret: the real module, not a pasted
// value that could drift from it (and that a secrets scanner reads as a leaked key).
import { createRequire } from "node:module";
const streamApiPseudonym = createRequire(import.meta.url)("../../../stream-api/pseudonym.js");
streamApiPseudonym._resetPseudonymKeyForTests(process.env);
const FROM_STREAM_API: string = streamApiPseudonym.publicIdFor("0a1b2c3d4e5f", "twitch");

test("the id web makes is the id stream-api made for the same person and platform", () => {
  assert.equal(publicIdFor("0a1b2c3d4e5f", "twitch"), FROM_STREAM_API);
  assert.deepEqual(parsePublicId(FROM_STREAM_API), { canonical: "0a1b2c3d4e5f", platform: "twitch" });
});

test("two platforms, two ids; the erased-person row and a missing canonical have none", () => {
  assert.notEqual(publicIdFor("0a1b2c3d4e5f", "twitch"), publicIdFor("0a1b2c3d4e5f", "youtube"));
  assert.equal(publicIdFor("(erased)", "twitch"), null);
  assert.equal(publicIdFor(null, "twitch"), null);
});

test("a canonical, a Matrix id or a forged id never reads back", () => {
  assert.equal(parsePublicId("0a1b2c3d4e5f"), null);
  assert.equal(parsePublicId("@casey:site.test"), null);
  const forged = FROM_STREAM_API.slice(0, 10) + (FROM_STREAM_API[10] === "A" ? "B" : "A") + FROM_STREAM_API.slice(11);
  assert.equal(parsePublicId(forged), null);
});
