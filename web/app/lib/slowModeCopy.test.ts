// Slow mode says it is copied to Twitch only on an install that has a Twitch channel.
// Run: node --test app/lib/slowModeCopy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slowModeHint, slowModeMirrors, slowModeNote } from "./slowModeCopy.ts";

test("an install without Twitch never mentions Twitch", () => {
  const mirrors = slowModeMirrors({ twitchBroadcasterId: null });
  assert.deepEqual(mirrors, []);
  assert.equal(slowModeHint("Example", mirrors), "Applies to Example chat for non-mods.");
  assert.equal(slowModeNote(30, mirrors), "Slow mode set to 30s.");
  assert.equal(slowModeNote(0, mirrors), "Slow mode off.");
});

test("an install with a Twitch channel says the setting is copied there, with Twitch's bounds", () => {
  const mirrors = slowModeMirrors({ twitchBroadcasterId: "12345" });
  assert.equal(slowModeHint("Example", mirrors), "Applies to Example chat for non-mods and is copied to Twitch (3–120s there).");
  assert.equal(slowModeNote(30, mirrors), "Slow mode set to 30s (copied to Twitch).");
  assert.equal(slowModeNote(0, mirrors), "Slow mode off (copied to Twitch).");
});

test("the route reports the mirrors and the section words its lines from them", () => {
  const route = readFileSync(join(import.meta.dirname, "..", "api", "mod", "slowmode", "route.ts"), "utf8");
  assert.match(route, /mirrorsTo: slowModeMirrors\(\{ twitchBroadcasterId: twitchBroadcasterId\(\) \}\)/);
  const section = readFileSync(join(import.meta.dirname, "..", "features", "moderation", "sections", "SlowModeSection.tsx"), "utf8");
  assert.match(section, /note\(slowModeNote\(seconds, mirrors\)\);/);
  assert.match(section, /\{slowModeHint\(siteName\(\), mirrors\)\}/);
  assert.doesNotMatch(section, /mirrored to Twitch|mirrors to Twitch/);
  assert.match(section, /\n\}\n$/, "END anchor");
});
