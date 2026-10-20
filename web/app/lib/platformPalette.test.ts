// Run: node --test app/lib/platformPalette.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { BRAND_PLATFORM_COLORS, PLATFORM_COLORS, platformColorVar } from "./platformColors.ts";
const read = (...p: string[]) => { const r = readFileSync(join(process.cwd(), ...p), "utf8"); assert.ok(r.trimEnd().length > 500); return stripComments(r); };

test("platformColorVar falls back to today's colour, so the site's own palette needs no writes", () => {
  assert.equal(platformColorVar("twitch"), `var(--pc-twitch, ${PLATFORM_COLORS.twitch})`);
  assert.equal(platformColorVar("nope"), "var(--pc-nope, #71717a)");
});

test("the pre-paint brand map is the module's map, value for value", () => {
  const layout = read("app", "layout.tsx");
  for (const [p, hex] of Object.entries(BRAND_PLATFORM_COLORS))
    assert.ok(layout.includes(`'${p}':'${hex}'`), `pre-paint brand map is missing ${p}:${hex}`);
});

test("chat rows paint platform colours through the variable, never the raw map", () => {
  const row = read("app", "features", "chat", "ChatMessage.tsx");
  assert.match(row, /const platformColor = platformColorVar\(barPlatform\)/);
  assert.match(row, /\[`--pi-c\$\{i \+ 1\}`, platformColorVar\(p\)\]/);
});

test("fallback name: a colour (default today's #c3cddb) or the platform's colour", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /fallbackNameColor:\s*"#c3cddb"/);
  assert.match(reg, /fallbackNameMode:\s*"colour"/);
  const css = read("app", "globals.css");
  assert.match(css, /\.chat-fallback-platform \.chat-name-fallback \{ color: var\(--row-pc\) !important; \}/);
  // --row-pc is the platform the indicator shows (barPlatform), not the raw source.
  assert.match(readFileSync(join(process.cwd(), "app", "features", "chat", "ChatMessage.tsx"), "utf8"),
    /\["--row-pc" as string\]: platformColorVar\(barPlatform\)/);
});
