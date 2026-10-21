import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "app/components/chrome/chrome.css"), "utf8");

test("with rounded corners on, the dock's strip starts past the video panel's curve and the chat bar's trailing group clears its curve", () => {
  assert.match(css, /html:not\(\.panels-square\) \[data-bar="dock"\] \.chrome-sections \{ padding-left: \.75rem; \}/);
  // Scoped to the chat's OWN top bar at desktop width: the panel holds Matrix's
  // bars too, and on a phone that corner is square.
  assert.match(css, /@media \(min-width: 768px\) \{\s*html:not\(\.panels-square\) \[data-bar="chat-top"\] \.chrome-bar-trail \{ padding-right: \.5rem; \}\s*\}/);
  assert.doesNotMatch(css, /\.bb-chat-panel \.chrome-bar-top \.chrome-bar-trail/);
});

test("the dock's open tab becomes a folder tab: a rounded outline over the band's hole, painting NO colour of its own", () => {
  // The page behind the dock is a user-set gradient (--bg-body-start/end), so a
  // painted tab can never match it; the hole stays open and shows the real
  // body through, and the tab only draws its rounded edge.
  const start = css.indexOf("Rounded corners (settings");
  const block = css.slice(start, css.indexOf("Borrowed hit area", start));
  assert.ok(start > 0 && block.length > 0, "the rounded-corners block precedes the borrowed-hit-area rules");
  assert.doesNotMatch(block, /--ind-w: 0px !important/);
  assert.doesNotMatch(block, /background:/);
  assert.match(css, /html:not\(\.panels-square\) \[data-bar="dock"\] \.chrome-sections \.chrome-tab\[aria-selected="true"\] \{ border-right-color: transparent; \}/);
  assert.match(css, /html:not\(\.panels-square\) \[data-bar="dock"\] \.chrome-sections \.chrome-tab\[aria-selected="true"\]::before \{[^}]*border: 1px solid var\(--color-edge\);[^}]*border-radius: \.5rem \.5rem 0 0;[^}]*\}/);
});

test("the rules live inside the components layer and the file ends where it did (END anchor)", () => {
  const start = css.indexOf("@layer components {");
  assert.ok(start >= 0 && css.indexOf('html:not(.panels-square) [data-bar="dock"]') > start);
  assert.ok(css.trimEnd().endsWith("}"), "END anchor");
});
