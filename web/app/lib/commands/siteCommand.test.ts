// The site's own destination command is named after the site (spec.ts SITE_WORD): its short name as
// one lower-case word, with the word's first letter as its alias when no other command answers to
// it. commands.test.ts runs with no build values (→ /site, no alias); this suite builds a site.
// Run: node --test app/lib/commands/siteCommand.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import "../testTsx.ts";

process.env.INSTALL_VALUES = JSON.stringify({ "site.name": "Example Stream", "site.shortName": "Example" });
const { COMMANDS } = await import("./spec.ts");

test("the site command is /<short name>, aliased by its free first letter, and routes to the site itself", () => {
  const site = COMMANDS.find((c) => c.name === "example");
  assert.ok(site, "no /example command");
  assert.deepEqual(site.route, { destination: null }, "it sends to the site itself, unredacted");
  assert.deepEqual(site.aliases, ["e"]);
  assert.ok(!COMMANDS.some((c) => c.name === "site"), "the fallback word is not used when the site has one");
  const others = COMMANDS.filter((c) => c !== site).flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  assert.ok(!others.includes("example") && !others.includes("e"), "the word and its letter shadow nothing");
});
