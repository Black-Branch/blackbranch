// Source scan (the route's aliased imports keep it out of node --test). ADR 0098: mods do not get
// the bot's impressions. The Identity links tool's search and preview read stream.bot_impressions
// and returned `impression` + `interactions` for the twelve most active matches of every search,
// and the section printed the first 120 characters (A3-02). The merge engine still combines
// impressions server-side (stream-api mergeCanonicals); nothing of them reaches a mod's screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../../lib/testSource.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);
const sectionRaw = readFileSync(join(import.meta.dirname, "../../../../features/moderation/IdentitySection.tsx"), "utf8");
const section = stripComments(sectionRaw);

test("no impression field in a mod payload", () => {
  assert.doesNotMatch(src, /bot_impressions/, "the route reads the bot's impressions");
  assert.doesNotMatch(src, /\bimpression\b|\binteractions\b/, "the payload carries the bot's read of a person");
  assert.doesNotMatch(section, /\bimpression\b|\binteractions\b/, "the Identity links section shows the bot's read");
  // What the tool does show is still there.
  assert.match(src, /userId: r\.id, name: r\.name, nickname: r\.nickname,/);
});

test("vacuity anchor: both files were read to their ends", () => {
  assert.match(raw.trimEnd(), /\}$/);
  assert.ok(src.lastIndexOf("export async function POST") > src.indexOf("export async function GET"), "the route was not read whole");
  assert.match(sectionRaw.trimEnd(), /\}$/);
  assert.ok(section.length > 2000, "the section was not read whole");
});
