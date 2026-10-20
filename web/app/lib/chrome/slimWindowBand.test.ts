// web/app/lib/chrome/slimWindowBand.test.ts
// Slim window headers. Source-scan: window bands get their OWN height token
// through the Bar's data-bar hook, and the shared --chrome-top-h is untouched
// — the chat tab bar and the video top bar must not move.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/chrome/slimWindowBand.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCssComments } from "../testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", "..", rel), "utf8");
const chromeCss = stripCssComments(read("components/chrome/chrome.css"));
const globals = stripCssComments(read("globals.css"));
const windowTsx = stripComments(read("components/chrome/Window.tsx"));

test("the window band names itself for the CSS hook", () => {
  assert.match(windowTsx, /<Bar\s+slot="top"\s+name="window"\s+band=\{hasTabs\}/);
  assert.match(windowTsx, /\}\s*$/, "vacuity anchor: Window.tsx read to its end");
});

test("the band's height is a window-only token, fixed — not the tab-size slider", () => {
  assert.match(globals, /--chrome-window-h:\s*28px;/, "computer: 28px");
  assert.doesNotMatch(globals, /--chrome-window-h:\s*calc\(/, "a bumped Tab size must not grow window headers");
  const panelAt = chromeCss.indexOf(".chrome-window-panel {");
  assert.notEqual(panelAt, -1);
  assert.match(chromeCss.slice(panelAt, chromeCss.indexOf("}", panelAt)), /--chrome-window-h:\s*30px;/, "phone panel: 30px, pill inside");
  // The override sits ON the band, so .chrome-sections (height: var(--chrome-top-h))
  // inside a tabbed window inherits it too.
  assert.match(chromeCss, /\.chrome-bar-top\[data-bar="window"\]\s*\{\s*--chrome-top-h:\s*var\(--chrome-window-h\);\s*\}/);
  assert.match(globals, /--chrome-top-h:\s+calc\(var\(--tab-size\) \+ 22px\);/, "the shared token is unchanged");
});

test("the title is plain case, 12px / 600 (④ text scale: 12.5 → the 12px step)", () => {
  const m = chromeCss.match(/\.chrome-window-title\s*\{([^}]*)\}/);
  assert.ok(m, "title rule exists");
  assert.match((m?.[1] ?? ""), /font-size:\s*\.75rem/);
  assert.match((m?.[1] ?? ""), /font-weight:\s*600/);
  assert.doesNotMatch((m?.[1] ?? ""), /text-transform|letter-spacing/, "plain case, normal tracking");
});

test("band buttons: 24px visible; on touch a hit area 44px wide and exactly the band tall, never overlapping", () => {
  assert.match(chromeCss, /\[data-bar="window"\] \.chrome-bar-btn\s*\{\s*height:\s*1\.5rem;\s*min-width:\s*1\.5rem;\s*\}/);
  assert.match(chromeCss, /\.chrome-bar-btn\s*\{[^}]*height:\s*1\.625rem;/, "the base button is still 26px");
  const coarse = chromeCss.match(/@media \(pointer: coarse\)\s*\{\s*\[data-bar="window"\] \.chrome-bar-lead, \[data-bar="window"\] \.chrome-bar-trail\s*\{\s*gap:\s*1\.25rem;\s*\}\s*\[data-bar="window"\] \.chrome-bar-btn\s*\{\s*position:\s*relative;\s*\}\s*\[data-bar="window"\] \.chrome-bar-btn::after\s*\{([^}]*)\}\s*\}/);
  assert.ok(coarse, "touch only; 24px buttons + a 20px gap = a 44px pitch, so two hit areas never overlap (the ✕'s area would eat the popout's right edge)");
  assert.match(coarse?.[1] ?? "", /width:\s*44px;/);
  assert.match(coarse?.[1] ?? "", /height:\s*var\(--chrome-top-h\);/, "the band's own height: a 44px area spilled 7px into the window body");
});

test("tabs in a window band stop growing with Tab size (the band is fixed)", () => {
  assert.match(chromeCss, /\[data-bar="window"\] \.chrome-tab\s*\{\s*font-size:\s*min\(var\(--tab-size, \.875rem\), 1rem\);\s*\}/);
});

test("the pill sits inside the band, above the bar's paint, and never takes the press", () => {
  assert.match(chromeCss, /\.chrome-window-panel > \.chrome-window-grab\s*\{\s*position:\s*relative;\s*isolation:\s*isolate;\s*\}/);
  const m = chromeCss.match(/\.chrome-window-grabber\s*\{([^}]*)\}/);
  assert.ok(m);
  assert.match((m?.[1] ?? ""), /position:\s*absolute;/);
  assert.match((m?.[1] ?? ""), /z-index:\s*20;/, "above .chrome-bar's z-index 10");
  assert.match((m?.[1] ?? ""), /pointer-events:\s*none;/, "the grab wrapper takes the drag, not the pill");
  assert.doesNotMatch((m?.[1] ?? ""), /margin:/, "no row of its own any more");
  assert.ok(chromeCss.trim().endsWith("}"), "vacuity anchor: chrome.css read to its end");
});
