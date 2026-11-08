// Run: node --test app/lib/discordSender.test.ts

import "./testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { senderLabel, isBridgedBot, isDiscordGhost, bridgeMatchers, discordGhostPattern } from "./discordSender.ts";
import { INSTANCE_KEYS, parseInstanceValue } from "./instanceSchema.generated.mjs";

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

// ── Out Of Your Element (the bundle's bridge) ──
// OOYE has no username_template setting: a ghost is its registration's `namespace_prefix`
// (`_ooye_`, install/matrix/render.sh MX_OOYE_PREFIX) followed by the Discord username, lower-cased
// and cut to a-z 0-9 . _ = - (OOYE 3.7 src/d2m/converters/user-to-mxid.js downcaseUsername; a
// taken name gets a number, a webhook "webhook_<name>", PluralKit "_pk_<id>"). Its display name is
// the server nickname, else the global name, else the username, with NO tail and no bot marker
// (src/d2m/actions/register-user.js memberToStateContent). Written in the template language the two
// keys already use, the placeholder naming what the bridge puts there:
const OOYE_USER = "_ooye_{{.Username}}";
const OOYE_DISPLAY = "{{or .Nick .GlobalName .Username}}";
// Real shapes: the bridge's bot as a real homeserver registered it (server renamed),
// and the shapes OOYE's code produces.
const OOYE_GHOSTS = ["@_ooye_bot:site.test", "@_ooye_casey:site.test", "@_ooye_casey2:site.test",
  "@_ooye_mr.x_y=z-1:site.test", "@_ooye_100000000000000001:site.test", "@_ooye_webhook_hookname:site.test",
  "@_ooye__pk_abcde:site.test", "@_ooye_casey:example.org"];
// Never a ghost: site accounts (a real one can never hold the prefix — Synapse's exclusive namespace and
// the bundle's MAS ban list reserve it), lookalikes, and the other bridge's ghosts.
const NOT_OOYE = ["@casey:site.test", "@ooye_casey:site.test", "@x_ooye_casey:site.test", "@_ooye_:site.test",
  "@_ooye_Casey:site.test", "@_ooye_ca sey:site.test", "@_ooye_casey", "@discord_100000000000000001:site.test", ""];

test("OOYE's template: its ghosts are recognised, nothing else is", () => {
  const m = bridgeMatchers(OOYE_USER, OOYE_DISPLAY);
  assert.equal(m.ghostPattern, "^@_ooye_[a-z0-9._=-]+:");
  for (const id of OOYE_GHOSTS) assert.equal(m.ghost?.test(id), true, id);
  for (const id of NOT_OOYE) assert.equal(m.ghost?.test(id), false, id);
});

test("OOYE's display names carry no tail and no bot marker: nothing is stripped, no name says bot", () => {
  const m = bridgeMatchers(OOYE_USER, OOYE_DISPLAY);
  assert.deepEqual([m.suffix, m.bot], [null, null]);
});

test("mautrix's template still recognises exactly its own ghosts — and none of OOYE's", () => {
  const m = bridgeMatchers(REAL_USER, REAL_DISPLAY);
  for (const id of OOYE_GHOSTS) assert.equal(m.ghost?.test(id), false, id);
  assert.equal(m.ghost?.test(GHOST), true);
});

test("the placeholder decides the characters: an id is digits only, a name never takes a capital or a colon", () => {
  assert.equal(bridgeMatchers("discord_{{.}}", "").ghost?.test("@discord_casey:site.test"), false);
  assert.equal(bridgeMatchers("dc_{{.Username}}", "").ghostPattern, "^@dc_[a-z0-9._=-]+:");
  assert.equal(bridgeMatchers("{{.Username}}", "").ghostPattern, null, "a bare name would claim every account");
  assert.equal(bridgeMatchers("_ooye_{{.Username}}{{.}}", "").ghostPattern, null, "two placeholders");
  assert.equal(bridgeMatchers("_ooye_{{.Name}}", "").ghostPattern, null, "a placeholder nobody defined: no guess");
  assert.equal(bridgeMatchers("_ooye_", "").ghostPattern, null, "a bare prefix");
});

test("every template the settings layer accepts yields a ghost pattern (and what it refuses, none)", () => {
  const entry = INSTANCE_KEYS.find((k) => k.key === "discordBridge.usernameTemplate")!;
  for (const t of [REAL_USER, OOYE_USER, "dc.{{.}}+x", "dc_{{.Username}}"]) {
    assert.equal(parseInstanceValue(entry, t).ok, true, t);
    assert.notEqual(bridgeMatchers(t, "").ghostPattern, null, t);
  }
  for (const t of ["_ooye_", "{{.Username}}", "_ooye_{{.Name}}", "a{{.}}b{{.Username}}"]) {
    assert.equal(parseInstanceValue(entry, t).ok, false, t);
    assert.equal(bridgeMatchers(t, "").ghostPattern, null, t);
  }
});

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";

test("against real Postgres: each template's pattern, bound as SQL binds it, agrees with the JS match",
  { skip: DB_URL ? false : "SQL_PARSE_DATABASE_URL not set (CI sets it)" }, async () => {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const ids = [...OOYE_GHOSTS, ...NOT_OOYE, GHOST, BOT, "@discord_abc:site.test"];
    for (const t of [REAL_USER, OOYE_USER]) {
      const m = bridgeMatchers(t, "");
      const { rows } = await db.query<{ id: string; ghost: boolean }>(
        "SELECT id, id ~ $1 AS ghost FROM unnest($2::text[]) id", [m.ghostPattern, ids]);
      assert.equal(rows.length, ids.length);
      for (const r of rows) assert.equal(r.ghost, m.ghost!.test(r.id), `${t}: ${r.id}`);
      assert.ok(rows.some((r) => r.ghost) && rows.some((r) => !r.ghost), `${t}: both answers occur`);
    }
  } finally {
    await db.end();
  }
});

// The cutover changes two values in the site's environment; they are read once, at start.
/** One fresh web process (a "start") with these install values: is each id a ghost? */
function startWith(user: string, display: string, ids: string[]): boolean[] {
  const mod = JSON.stringify(new URL("./discordSender.ts", import.meta.url).href);
  const code = `const m = await import(${mod}); console.log(JSON.stringify(${JSON.stringify(ids)}.map((id) => m.isDiscordGhost(id))));`;
  const values = { "discordBridge.usernameTemplate": user, "discordBridge.displaynameTemplate": display };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code],
    { env: { ...process.env, INSTALL_VALUES: JSON.stringify(values) }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as boolean[];
}

test("restart: a site started on mautrix's values, restarted on OOYE's, marks the new bridge's people", () => {
  const ids = ["@_ooye_casey:site.test", GHOST, "@casey:site.test"];
  assert.deepEqual(startWith(REAL_USER, REAL_DISPLAY, ids), [false, true, false], "before: only mautrix's ghosts");
  assert.deepEqual(startWith(OOYE_USER, OOYE_DISPLAY, ids), [true, false, false], "after the restart: OOYE's");
  assert.deepEqual(startWith("", "", ids), [false, false, false], "module off: nobody");
});

test("retry: asking again in the same process gives the same answer (the matchers are built once)", () => {
  const first = OOYE_GHOSTS.map((id) => isDiscordGhost(id));
  for (let i = 0; i < 3; i++) assert.deepEqual(OOYE_GHOSTS.map((id) => isDiscordGhost(id)), first);
  assert.deepEqual([isDiscordGhost(GHOST), isDiscordGhost(GHOST)], [true, true]);
});

// Vacuity anchor at the END: the OOYE template discriminates — one ghost in, one person out.
test("the OOYE pattern genuinely discriminates", () => {
  const m = bridgeMatchers(OOYE_USER, OOYE_DISPLAY);
  assert.notEqual(m.ghost?.test("@_ooye_casey:site.test"), m.ghost?.test("@casey:site.test"));
});
