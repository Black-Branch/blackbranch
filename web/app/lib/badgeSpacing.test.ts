// The chat badge gap equals the platform-indicator gap.
//
// Run: node --test app/lib/badgeSpacing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripCssComments } from "./testSource.ts";

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "globals.css");

test("the badge gap IS the indicator gap, with no multiplier", () => {
  const css = stripCssComments(readFileSync(cssPath, "utf8"));
  const decl = css.match(/--chat-badge-gap:\s*([^;]+);/);
  assert.ok(decl, "--chat-badge-gap must be declared");
  assert.ok(decl[1], "badge gap declaration must have a value");
  assert.match(decl[1], /var\(--chat-pi-gap[^)]*\)/, "it must derive from the indicator gap");
  assert.equal(/\*/.test(decl[1]), false,
    "no multiplier — identical distances, not a cluster effect");
});

// ── Vacuity anchor ───────────────────────────────────────────────────────────
test("globals.css was actually read and still declares the indicator gap", () => {
  const css = readFileSync(cssPath, "utf8");
  assert.match(css, /--chat-pi-gap:/);
});
