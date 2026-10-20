// Run: node --test app/lib/discordSender.test.ts

import "./testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { senderLabel, isBridgedBot, bridgeMatchers, discordGhostPattern } from "./discordSender.ts";

// A REAL bridge ghost from Synapse: bridge username_template is
// `discord_{{.}}`, so there is no underscore before "discord". A predicate
// testing `@_discord_` matches no real ghost.
const GHOST = "@discord_100000000000000001:site.test";

test("a mautrix-discord ghost is recognised", () => {
  assert.equal(senderLabel("x", GHOST).fromDiscord, true);
  assert.equal(senderLabel("x", "@discord_1:site.test").fromDiscord, true);
});

test("a real person is not", () => {
  for (const id of ["@casey:site.test", "@rosalind:site.test", "@neopergoss:site.test"]) {
    assert.equal(senderLabel("x", id).fromDiscord, false, id);
  }
});

test("a lookalike localpart is not — the prefix must be anchored", () => {
  // @notdiscordfan, @discordant and the OLD wrong shape must not get the glyph.
  for (const id of ["@notdiscord_1:site.test", "@discordant:site.test", "@_discord_1:site.test", "@discord_abc:site.test"]) {
    assert.equal(senderLabel("x", id).fromDiscord, false, id);
  }
});

test("a bridge ghost on another homeserver is still a bridge ghost", () => {
  assert.equal(senderLabel("x", "@discord_99:example.org").fromDiscord, true);
});

test("junk input does not throw", () => {
  for (const id of ["", "not-an-id", "@", "@discord_"]) {
    assert.equal(typeof senderLabel("", id).fromDiscord, "boolean", id);
  }
});

test("senderLabel strips the bridge's trailing marker for a ghost", () => {
  assert.equal(senderLabel("Casey (Discord)", GHOST).label, "Casey");
  assert.equal(senderLabel("Casey (discord)", GHOST).label, "Casey");
  assert.equal(senderLabel("Casey   (Discord)", GHOST).label, "Casey");
});

test("senderLabel only strips a TRAILING marker", () => {
  assert.equal(senderLabel("Discord Mod", GHOST).label, "Discord Mod");
  assert.equal(senderLabel("(Discord) Casey", GHOST).label, "(Discord) Casey");
  assert.equal(senderLabel("Casey", GHOST).label, "Casey");
});

test("senderLabel strips the suffix for a ghost and flags it", () => {
  assert.deepEqual(senderLabel("Casey (Discord)", GHOST), { label: "Casey", fromDiscord: true });
  assert.deepEqual(senderLabel("FixTweet (bot) (Discord)", "@discord_1164651057243238400:site.test"),
    { label: "FixTweet (bot)", fromDiscord: true });
});

test("senderLabel leaves a real person's name alone, marker included", () => {
  assert.deepEqual(senderLabel("Casey (Discord)", "@casey:site.test"), { label: "Casey (Discord)", fromDiscord: false });
  assert.deepEqual(senderLabel("k", "@k:site.test"), { label: "k", fromDiscord: false });
});

// A REAL bot ghost: the bridge template is
// `{{or .GlobalName .Username}}{{if .Bot}} (bot){{end}} (Discord)`.
const BOT = "@discord_1164651057243238400:site.test";

test("isBridgedBot: the bridge's (bot) marker on a ghost", () => {
  assert.equal(isBridgedBot("FixTweet (bot) (Discord)", BOT), true);
  assert.equal(isBridgedBot("Sapphire (bot)  (discord) ", "@discord_678344927997853742:site.test"), true);
});

test("isBridgedBot: a human ghost, a native user, a marker in the wrong place", () => {
  assert.equal(isBridgedBot("Casey (Discord)", GHOST), false);
  assert.equal(isBridgedBot("FixTweet (bot) (Discord)", "@casey:site.test"), false, "keyed on the ghost id, never the name alone");
  assert.equal(isBridgedBot("(bot) FixTweet (Discord)", BOT), false);
  assert.equal(isBridgedBot("FixTweet (bot)", BOT), false, "the marker sits right before the bridge suffix");
});

test("isBridgedBot: junk input does not throw", () => {
  for (const [n, id] of [["", ""], ["x", "@"], ["(bot)", "@discord_"]] as const) {
    assert.equal(isBridgedBot(n, id), false, `${n}/${id}`);
  }
});

// Vacuity anchor at the END: the predicate must discriminate, not return a
// constant, and the two branches must both be reachable.
test("the predicate genuinely discriminates", () => {
  assert.notEqual(senderLabel("a", GHOST).fromDiscord, senderLabel("a", "@casey:site.test").fromDiscord);
});

// ── Module config: everything above is DERIVED from the bridge's templates ──
const REAL_USER = "discord_{{.}}";
const REAL_DISPLAY = "{{or .GlobalName .Username}}{{if .Bot}} (bot){{end}} (Discord)";

test("the real templates derive exactly the pattern this file used to hardcode", () => {
  const m = bridgeMatchers(REAL_USER, REAL_DISPLAY);
  assert.equal(m.ghostPattern, "^@discord_[0-9]+:");
  assert.equal(discordGhostPattern(), "^@discord_[0-9]+:", "the build value (testInstallValues) is the real template");
  assert.equal(m.suffix?.source, String.raw`\s*\(Discord\)\s*$`);
  assert.equal(m.bot?.source, String.raw`\(bot\)\s*\(Discord\)\s*$`);
  assert.equal(m.suffix?.flags, "i");
});

test("module OFF (no templates): nobody is a ghost, nothing is stripped, SQL binds NULL", () => {
  const m = bridgeMatchers("", "");
  assert.deepEqual([m.ghostPattern, m.ghost, m.suffix, m.bot], [null, null, null, null]);
});

test("another bridge's templates: its own prefix, its own tail, metacharacters escaped", () => {
  const m = bridgeMatchers("dc.{{.}}+x", "{{.Username}}{{if .Bot}} [BOT]{{end}} (via dc)");
  assert.equal(m.ghostPattern, String.raw`^@dc\.[0-9]+\+x:`);
  assert.equal(m.ghost?.test("@dc.123+x:example.org"), true);
  assert.equal(m.ghost?.test("@dcX123+x:example.org"), false, "the . is literal, not any character");
  assert.equal(m.ghost?.test("@discord_1:example.org"), false);
  assert.equal("Al (via dc)".replace(m.suffix!, ""), "Al");
  assert.equal(m.bot?.test("Hook [BOT] (via dc)"), true);
  assert.equal(m.bot?.test("Hook (via dc)"), false);
});

test("a template without the expected shape yields NO matcher for that part, never a guess", () => {
  assert.equal(bridgeMatchers("discord_", REAL_DISPLAY).ghostPattern, null, "no {{.}}");
  assert.equal(bridgeMatchers("{{.}}_{{.}}", REAL_DISPLAY).ghostPattern, null, "two {{.}}");
  assert.equal(bridgeMatchers(REAL_USER, "{{.Username}}").suffix, null, "no fixed tail");
  assert.equal(bridgeMatchers(REAL_USER, "{{.Username}} (Discord)").bot, null, "no bot marker");
});
