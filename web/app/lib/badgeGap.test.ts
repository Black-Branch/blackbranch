// web/app/lib/badgeGap.test.ts
// Two gaps, two settings: the indicator gap and the badge gap are each
// controllable. "Badge gap" starts as "Same as indicator gap" (-1), so viewers
// with a custom indicator gap keep their look; set, it spaces the badges and
// the badges→name gap on its own.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/badgeGap.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCssComments } from "./testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");
const reg = stripComments(read("lib/settingsRegistry.ts"));
const menu = stripComments(read("lib/settingsMenu.ts"));
const layout = stripComments(read("layout.tsx"));

test("badgeGap: default follows the indicator gap; a value sets its own", () => {
  assert.match(reg, /\n  badgeGap:\s+-1,/, "default = same as indicator gap");
  const m = reg.match(/\n  badgeGap: E\(\{([\s\S]*?)\}\),\n/);
  assert.ok(m, "registry entry");
  const e = m?.[1] ?? "";
  assert.match(e, /ls: "chatStyle_badgeGap", prePaint: true/);
  assert.match(e, /rmProp\("--chat-badge-gap"\)/, "-1 hands the gap back to the CSS default (the indicator gap)");
  assert.match(e, /setProp\("--chat-badge-gap", v \+ "px"\)/);
  assert.match(e, /label: "Badge gap"/);
  // A word readout is one short word in the fixed readout box;
  // its meaning moves to the tooltip, never a four-line wrapped column.
  assert.match(e, /v < 0 \? "Auto" :/);
  assert.match(e, /title: "Auto = same as the indicator gap"/);
});

test("the settings menu passes a slider's tooltip through to the Slider", () => {
  assert.match(read("components/ChatSettings.tsx"), /<Slider[\s\S]{0,400}title=\{control\.title\}/);
  assert.match(reg, /kind: "slider"; label: string;[\s\S]{0,300}title\?: string/);
});

test("the menu shows each gap where it does something", () => {
  assert.match(menu, /s\("badgeGap", \(v\) => v\.badgesOn\)/);
  assert.match(menu, /s\("piGap", \(v\) => piShown\(v\) \|\| v\.pfpOn\)/, "it also spaces avatars, so it shows with avatars on");
  assert.match(menu, /"piGap", "badgeGap"/, "the /chat window and overlay get it too");
  assert.match(menu, /\.filter\(\(sec\) => sec\.items\.length > 0\);\s*\}\s*$/, "vacuity anchor");
});

test("badges → name uses the badge gap; the pre-paint mirrors it", () => {
  for (const f of ["features/chat/ChatMessage.tsx", "components/PinnedBanner.tsx"]) {
    const src = stripComments(read(f));
    assert.match(src, /className="chat-badges" style=\{\{[^}]*gap: "var\(--chat-badge-gap\)"[^}]*marginRight: "var\(--chat-badge-gap\)"/, f);
  }
  assert.match(layout, /localStorage\.getItem\('chatStyle_badgeGap'\)/);
  assert.match(layout, /if\(_bgg>=0\) document\.documentElement\.style\.setProperty\('--chat-badge-gap', _bgg \+ 'px'\);/);
  const css = stripCssComments(read("globals.css"));
  assert.match(css, /--chat-badge-gap:\s+var\(--chat-pi-gap, 11px\);/, "the CSS default still follows the indicator gap");
  assert.ok(css.trim().endsWith("}"), "vacuity anchor");
});
