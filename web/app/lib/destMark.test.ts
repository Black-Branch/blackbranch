// destMark — where the chat box sends, as the terminal's typing line writes it. The site's own
// room is named after the site (its short name, else its name), so this suite builds with a
// made-up one; the module reads it at call time from the build values.
// Run: node --test app/lib/destMark.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.INSTALL_VALUES = JSON.stringify({ "site.name": "Example Stream", "site.shortName": "Example" });
const { destMark, ENCRYPTED_DEST } = await import("./sendDestination.ts");

test("destMark: the site's room is #<short name>, lower-cased; a platform reads as its label", () => {
  assert.equal(destMark(null), "#example");
  assert.equal(destMark("twitch"), "twitch", "platformLabel's wording, lower-cased");
  assert.equal(destMark("youtube"), "youtube");
  assert.equal(destMark("kick"), "kick");
  assert.equal(destMark("streamplace"), "stream.place");
  assert.equal(destMark("all"), "all");
  assert.equal(destMark(ENCRYPTED_DEST), "#example · redacted");
});
