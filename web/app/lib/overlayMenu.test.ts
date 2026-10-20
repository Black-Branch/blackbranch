// The /chat window and the OBS overlay get their own trimmed menu: no bars, no panel body (their canvas is transparent
// — chatWindow.test.ts "its canvas is transparent"), no composer, no site
// chrome. Source-text, for the same reason every other settingsMenu guard is:
// settingsRegistry.ts imports `./chatFont` extensionless, and node --test
// cannot resolve an extensionless TS import.
//
// Run: node --test app/lib/overlayMenu.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
const read = (...p: string[]) => { const r = readFileSync(join(process.cwd(), ...p), "utf8"); assert.ok(r.trimEnd().length > 300); return stripComments(r); };
const MENU = read("app", "lib", "settingsMenu.ts");

const list = (name: string) => (MENU.match(new RegExp(`export const ${name} = new Set<SettingKey>\\(\\[([^\\]]*)\\]`))?.[1] ?? "")
  .split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);

test("the overlay list leaves out everything that paints nothing there", () => {
  const keys = list("OVERLAY_KEYS");
  assert.ok(keys.length > 30, `parsed only ${keys.length}`);
  for (const k of ["panelTint", "barStrength", "bodyStrength", "bgStart", "shellFont", "tabSize", "sendToBtnOn", "toolsBtnOn", "emoteBtnOn", "donateColor", "giftColor", "frameColor", "hideTabBar", "lowPower", "transparencyOn", "glassOn"])
    assert.ok(!keys.includes(k), `${k} does nothing on /chat or the overlay`);
  assert.deepEqual(list("WINDOW_ONLY_KEYS"), ["chatFade", "voteColor", "histLength"]);
});

test("both pages use the one shared panel, and the gear is hover/tap only", () => {
  for (const f of ["ChatOverlay.tsx", "ChatWindow.tsx"]) {
    const s = read("app", "features", "chat", f);
    assert.match(s, /<OverlaySettingsPanel page="(obs|window)"/, `${f} does not use the shared panel`);
    assert.doesNotMatch(s, /window\.addEventListener\("mousemove"/, `${f} still has its own mouse drag`);
  }
  const p = read("app", "features", "chat", "OverlaySettingsPanel.tsx");
  assert.match(p, /onPointerDown/);
  assert.match(p, /setPointerCapture/);
  assert.match(p, /pointerType === "touch"/);
  const css = read("app", "globals.css");
  assert.match(css, /\.overlay-gear \{[^}]*opacity: 0/);
  assert.match(css, /:hover > \.overlay-gear|\.overlay-host:hover \.overlay-gear/);
});
