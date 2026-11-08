// Admin Panel › Site › Discord, step 1: the Discord side of the bot step is the Discord setup list
// (config/setup-core.mjs `discord`), the same words the public docs' platforms/discord page is
// generated from — never a second, hand-written copy in the page.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/discordBotStep.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../lib/testTsx.ts";
const { default: DiscordBotStep } = await import("./DiscordBotStep.tsx");
const { coreSetupPage } = await import("../../lib/setup/setupPages.ts");

const here = dirname(fileURLToPath(import.meta.url));
const addr = { origin: "https://example.test", apiOrigin: "https://api.example.test", matrixOrigin: "https://matrix.example.test", serverName: "example.test" };
const guide = coreSetupPage("discord", addr)!;
const render = (g: typeof guide | null) => renderToStaticMarkup(createElement(DiscordBotStep, { note: () => {}, onBot: () => {}, guide: g }));

test("the bot step shows the Discord setup list's own steps, with the description to copy", () => {
  const out = render(guide);
  assert.ok(guide.steps.length >= 2, "vacuity: the list has no steps");
  for (const s of guide.steps) assert.ok(out.includes(s.title.replace(/'/g, "&#x27;")), `step "${s.title}" is not shown`);
  assert.match(out, /Powered by OOYE/);
  assert.match(out, /aria-label="Copy Description \(somewhere in it\)"/);
  assert.match(out, /href="https:\/\/discord\.com\/developers\/applications"/);
  // The token field is still the page's own.
  assert.match(out, /aria-label="Discord bot token"/);
});

test("while the guide has not loaded: the field is there, the steps say they are loading", () => {
  const out = render(null);
  assert.match(out, /aria-label="Discord bot token"/);
  assert.match(out, /Loading the steps/);
});

test("ONE copy of the words: the page writes no Discord steps of its own, and the panel hands it the list's guide", () => {
  const src = readFileSync(join(here, "DiscordBotStep.tsx"), "utf8");
  assert.doesNotMatch(src, /Developer Portal|Message Content Intent|Reset Token/, "a hand-written copy of the list's steps");
  const panel = readFileSync(join(here, "AdminPanel.tsx"), "utf8");
  assert.match(panel, /<DiscordLinksPage note=\{note\} guide=\{inst\?\.guides\?\.find\(\(g\) => g\.list === "core:discord"\)\?\.page \?\? null\} \/>/);
  const links = readFileSync(join(here, "DiscordLinksPage.tsx"), "utf8");
  assert.match(links, /<DiscordBotStep key=\{botKey\} note=\{note\} onBot=\{setBot\} guide=\{guide\} \/>/);
  // Vacuity anchor: the scans above read the real files (their last lines are what this file
  // last saw as the components' ends).
  assert.match(src.trimEnd(), /\n\}$/);
  assert.match(panel, /export default function AdminPanel/);
});
