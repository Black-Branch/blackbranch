// web/app/lib/panelColours.test.ts — panel colour model B.
// Run: node --test app/lib/panelColours.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { pageGradient, BG_DIRS } from "./panelColours.ts";

const read = (...p: string[]) => { const r = readFileSync(join(process.cwd(), ...p), "utf8"); assert.ok(r.trimEnd().length > 500); return stripComments(r); };
const REG = read("app", "lib", "settingsRegistry.ts");
const LAYOUT = read("app", "layout.tsx");

test("glow is today's page background exactly (untouched looks stay the same)", () => {
  assert.equal(pageGradient("glow"),
    "radial-gradient(ellipse 140% 65% at 50% 0%, var(--bg-body-start) 0%, var(--bg-body-end) 72%)");
  assert.deepEqual([...BG_DIRS], ["glow", "down", "right", "diag-down", "diag-up"]);
});

test("the pre-paint mirrors every direction's gradient string character for character", () => {
  for (const d of BG_DIRS) {
    const g = pageGradient(d).replace(/'/g, "\\'");
    assert.ok(LAYOUT.includes(g), `pre-paint is missing the ${d} gradient: ${g}`);
  }
});

test("bars and body paint the tint; the page paints the gradient", () => {
  // The tab strip paints the tint and gets the shared shade through its band;
  // the other three paint tint + shade as one value (all panel bars share one
  // shade).
  assert.match(read("app", "features", "chat", "ChatTabBar.tsx"), /var\(--panel-tint-bar\)/, "the chat tab strip does not paint the bar tint");
  for (const f of [["app", "components", "StreamEmbedBar.tsx"], ["app", "components", "StreamMetaBar.tsx"]] as const)
    assert.match(read(...f), /var\(--panel-bar-bg\)/, `${f.at(-1)} does not paint the shaded bar tint`);
  const sidebar = read("app", "features", "chat", "ChatSidebar.tsx");
  assert.match(sidebar, /"var\(--panel-bar-bg\)"/, "the typing bar does not paint the shaded bar tint");
  assert.match(sidebar, /background: "var\(--panel-tint-body\)"/, "chat body does not paint the body tint");
  assert.match(LAYOUT, /background: "var\(--bg-page, radial-gradient/, "body does not paint --bg-page");
});

test("no consumer is left on the retired variables", () => {
  for (const f of [["app", "components", "StreamEmbedBar.tsx"], ["app", "components", "StreamMetaBar.tsx"], ["app", "features", "chat", "ChatTabBar.tsx"], ["app", "features", "chat", "ChatSidebar.tsx"], ["app", "lib", "useChatBgContrastRef.ts"], ["app", "features", "community", "SpacesRail.tsx"]] as const)
    assert.doesNotMatch(read(...f), /--bg-(video|chat)-(start|end)|--bg-chat-bar-/, `${f.at(-1)} still reads a retired var`);
});

test("transparency off forces both strengths to solid (alphaOf), without touching stored values", () => {
  assert.match(REG, /function applyPanel\(ctx: ApplyCtx\) \{[\s\S]*?alphaOf\(ctx, ctx\.get\("barStrength"\)\)[\s\S]*?alphaOf\(ctx, ctx\.get\("bodyStrength"\)\)/);
  assert.match(REG, /transparencyOn: E\(\{[\s\S]*?applyPanel\(ctx\)/, "the transparency switch no longer re-applies the panel");
});

test("phones: transparency is ON by default now; blur (glassOn) stays OFF", () => {
  const m = REG.match(/const MOBILE_DEFAULTS: Partial<Values> = \{([^}]*)\}/)?.[1] ?? "";
  assert.ok(m.length > 0, "MOBILE_DEFAULTS not found");
  assert.doesNotMatch(m, /transparencyOn/, "transparency must no longer default off on phones");
  assert.match(m, /glassOn: false/);
  assert.match(m, /shadowOn: false/);
});

test("pre-paint: legacy panel keys are read ONLY as a fallback when the v2 key is absent", () => {
  assert.match(LAYOUT, /localStorage\.getItem\('theme_panelTint'\) \|\| localStorage\.getItem\('theme_chatStart'\)/);
  const allow = read("scripts", "check-prepaint.mjs");
  for (const k of ["theme_chatStart", "theme_chatOpacity", "theme_videoOpacity"])
    assert.ok(allow.includes(`"${k}"`), `${k} must be allowlisted with its reason`);
});

test("Reset writes THIS device's defaults (a phone reset must not turn the shadow on)", () => {
  // LOOK_KEYS: Reset resets looks only.
  assert.match(read("app", "components", "ChatSettings.tsx"), /\.\.\.Object\.fromEntries\(LOOK_KEYS\.map\(\(k\) => \[k, defaultFor\(k\)\]\)\) \} as Values;/);
});
