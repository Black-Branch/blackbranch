// Tests for the chat font-size helpers.
//
// The helper emits the SAME strings every consumer would otherwise hand-inline —
// a byte-for-byte drop-in, so migrating a site can't change what it renders.
// These lock the exact output (incl. the inert 0.875rem fallback) and pin that
// no consumer file hardcodes the literal.
//
// Run: node --test app/lib/chatFont.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CHAT_FONT, CHAT_ROW_BASIS, chatFontCalc, chatFontVar, rowBasisCalc } from "./chatFont.ts";

test("CHAT_FONT is the exact string the sites inlined", () => {
  assert.equal(CHAT_FONT, "var(--chat-font-size, 0.875rem)");
});

test("chatFontCalc wraps in calc() with the multiplier verbatim", () => {
  // Expected values are built from CHAT_FONT (locked by the test above) rather
  // than re-typed literally — a bare `calc(var(--chat-font-size) * N)` literal
  // would (correctly) trip check-tokens.mjs's "use the named --text-chat-* scale"
  // rule, which the real call sites dodge via pfp/icon-scale or a ${} expr.
  assert.equal(chatFontCalc(2), `calc(${CHAT_FONT} * 2)`);
  assert.equal(chatFontCalc("1.10"), `calc(${CHAT_FONT} * 1.10)`);
  // Multi-factor exprs pass through. (The pfp-scale sites themselves moved to
  // rowBasisCalc when avatars stopped riding Text Size — the SHAPE is the same.)
  assert.equal(
    chatFontCalc("2.6 * var(--chat-pfp-scale, 1) + 0.75rem"),
    `calc(${CHAT_FONT} * 2.6 * var(--chat-pfp-scale, 1) + 0.75rem)`
  );
  assert.equal(
    chatFontCalc("var(--chat-pfp-scale, 1)"),
    `calc(${CHAT_FONT} * var(--chat-pfp-scale, 1))`
  );
});

test("chatFontVar nests CHAT_FONT as the fallback of another var", () => {
  assert.equal(chatFontVar("--chat-ts-size"), `var(--chat-ts-size, ${CHAT_FONT})`);
  assert.equal(chatFontVar("--example-var"), `var(--example-var, ${CHAT_FONT})`);
});

// ── the frozen avatar/badge basis ─────────────────────────────────────────────

test("CHAT_ROW_BASIS fallback matches the --chat-row-basis value in globals.css", () => {
  // The basis is a deliberate constant (NOT coupled to --chat-font-size's
  // default — see globals.css), but the TS fallback and the CSS declaration are
  // two restatements of the SAME number, and those drift.
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const declared = /--chat-row-basis:\s*([^;]+);/.exec(css)?.[1]?.trim();
  assert.equal(CHAT_ROW_BASIS, `var(--chat-row-basis, ${declared})`);
});

test("rowBasisCalc wraps in calc() with the multiplier verbatim", () => {
  assert.equal(
    rowBasisCalc("var(--chat-pfp-scale, 1)"),
    `calc(${CHAT_ROW_BASIS} * var(--chat-pfp-scale, 1))`
  );
  assert.equal(
    rowBasisCalc("1.10 * var(--chat-badge-scale, 1)"),
    `calc(${CHAT_ROW_BASIS} * 1.10 * var(--chat-badge-scale, 1))`
  );
});

// ── no consumer may re-inline the literal ─────────────────────────────────────

// Only these may contain the raw `var(--chat-font-size, 0.875rem)` literal:
// the helper itself, globals.css (the named `--text-chat-*` scale) and the
// layout.tsx prepaint <script> (a pre-hydration string that can't import TS).
const ALLOWED = new Set(["chatFont.ts", "globals.css", "layout.tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

test("no TS/TSX consumer re-inlines the chat-font literal", () => {
  const offenders: string[] = [];
  for (const f of walk(join(process.cwd(), "app"))) {
    if (ALLOWED.has(f.split("/").pop()!)) continue;
    if (readFileSync(f, "utf8").includes("var(--chat-font-size, 0.875rem)")) {
      offenders.push(f.replace(process.cwd() + "/", ""));
    }
  }
  assert.deepEqual(offenders, [],
    `these files hardcode the chat-font literal instead of importing chatFont.ts:\n  ${offenders.join("\n  ")}`);
});
