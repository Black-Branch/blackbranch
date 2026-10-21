// Guards for the --glass-blur single source of truth.
//
// glassBlur is a user setting (Appearance → Blur, 0-40px). A <style> element
// overriding the `.glass` class would reach only elements carrying `.glass`,
// while components that compose the same look INLINE (`background:
// var(--glass-bg)` plus a hardcoded blur) would stay frozen at the default —
// a visibly half-applied setting. A custom property has no cascade problem to
// work around and reaches both kinds of consumer.
//
// Only pop-ups use glass: non-pop-up surfaces keep `var(--glass-bg)` — the
// translucent FILL — and have no blur. The blur has exactly one spelling,
// `--glass-filter`, read by `.glass` and the row hover bar and nothing else;
// glassSurface.test.ts owns that invariant.
//
// What is pinned here: --glass-blur is the one radius, restated in exactly
// three places that must agree, and globals.css must never hand-write the
// -webkit- pair.
//
// Run: node --test app/lib/glassBlur.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

// The five files that once composed glass inline. They carry the
// FILL only — glassSurface.test.ts is what bans a blur from coming back.
const EX_GLASS_SURFACES = [
  ["app", "components", "StreamEmbedBar.tsx"],
  ["app", "components", "StreamMetaBar.tsx"],
  ["app", "features", "chat", "ChatTabBar.tsx"],
  ["app", "features", "chat", "ChatSidebar.tsx"],
  ["app", "components", "PinnedBanner.tsx"],
];

test("nothing hardcodes the blur radius", () => {
  for (const p of [...EX_GLASS_SURFACES, ["app", "globals.css"], ["app", "layout.tsx"]]) {
    const s = read(...p);
    assert.doesNotMatch(s, /blur\(14px\)/,
      `${p.join("/")} hardcodes blur(14px) again — it would stop tracking the Blur slider`);
  }
});

test("the one blur reads the radius property, with the cold-profile fallback", () => {
  const css = read("app", "globals.css");
  // The radius is composed once, into --glass-filter, and `.glass` reads
  // THAT — so the Blur slider and the Glass switch land on the same declaration.
  assert.match(css, /--glass-filter: blur\(var\(--glass-blur, 14px\)\)/);
  // No hand-written -webkit-backdrop-filter here. Lightning CSS (Tailwind 4's
  // compiler) treats a hand-written standard+`-webkit-` pair in a .css source
  // as duplicate declarations and keeps only the LAST one — commit 391a8ba
  // found `.glass` had been shipping with just the -webkit- form, which
  // Firefox ignores, silently killing the blur on every glass overlay. The
  // compiler emits the vendor prefix itself from the standard property, so
  // re-adding a hand-written -webkit- pair here would reintroduce the trap.
  // (Inline React style objects are unaffected by Lightning CSS and still
  // need both forms — see PinnedBanner.tsx et al. below.)
  assert.doesNotMatch(css, /-webkit-backdrop-filter\s*:/,
    "hand-written -webkit-backdrop-filter is back in globals.css — Lightning CSS " +
    "collapses the standard+webkit pair to the last declaration (391a8ba), which " +
    "would silently kill the blur in Firefox again");
});

test("the registry sets the property instead of injecting a <style>", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /setProp\("--glass-blur", `\$\{v as number\}px`\)/,
    "glassBlur no longer writes the custom property");
  assert.doesNotMatch(reg, /getElementById\("glass-blur-init"\)/,
    "the <style> injection is back — inline glass surfaces would stop following the setting");
});

test("the pre-paint script sets the SAME property (no first-paint flash)", () => {
  // If prepaint and the registry disagree, the blur snaps on hydration.
  const layout = read("app", "layout.tsx");
  assert.match(layout, /setProperty\('--glass-blur',_gb\+'px'\)/,
    "prepaint no longer seeds --glass-blur — glass would paint at the fallback then jump");
  assert.doesNotMatch(layout, /glass-blur-init/,
    "the prepaint <style> injection is back");
});

test("the default is 14 wherever it still has to be restated", () => {
  // DEFAULTS is the single source of truth, but the pre-paint script
  // runs before any module loads and CSS needs a cold-profile fallback, so those
  // two must restate it. They must agree with DEFAULTS or a cold profile flashes.
  assert.match(read("app", "lib", "settingsRegistry.ts"), /glassBlur:\s*14,/);
  assert.match(read("app", "layout.tsx"), /localStorage\.getItem\('theme_glassBlur'\)\|\|'14'/);
  assert.match(read("app", "globals.css"), /--glass-blur, 14px/);
});
