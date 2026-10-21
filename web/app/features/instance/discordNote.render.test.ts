// Admin Panel → Platforms → Discord on an install with no bridge leads with "the Discord bridge is
// not part of this install"; an install that describes a bridge shows no such line.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/discordNote.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../lib/testTsx.ts";
const { default: DiscordNote } = await import("./DiscordNote.tsx");

const row = (key: string, display: unknown) => ({ key, packages: [{ package: "web", known: true, display }] });
const view = (user: unknown, name: unknown) => ({
  keys: [row("site.name", "Example Stream"), row("discordBridge.usernameTemplate", user), row("discordBridge.displaynameTemplate", name)],
}) as never;

test("no bridge values set: the page leads with the bridge not being part of this install", () => {
  for (const [u, n] of [[null, null], ["", "  "], [undefined, null]]) {
    const out = renderToStaticMarkup(createElement(DiscordNote, { view: view(u, n) }));
    assert.match(out, /data-discord-note="absent"/);
    assert.match(out, /The Discord bridge is not part of this install/);
    assert.match(out, /Nothing here connects to Discord/);
  }
});

test("a bridge described by either template: no absent line", () => {
  assert.equal(renderToStaticMarkup(createElement(DiscordNote, { view: view("discord_{{.}}", null) })), "");
  assert.equal(renderToStaticMarkup(createElement(DiscordNote, { view: view(null, "{{.Username}} (Discord)") })), "");
});
