// web/app/lib/tsIndent.test.ts
// "Indent to time" measures the REAL timestamp. A fixed `ch` table resolved in
// the MESSAGE font, never re-run when the time font or size changes, puts
// wrapped lines in the wrong place; grouped rows must not add the indent on
// top of a still-visible time.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/tsIndent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCssComments } from "./testSource.ts";
import { tsWidestSamples, measureTsWidth } from "./tsMeasure.ts";
import { TS_FORMATS } from "./chatTime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");
const reg = stripComments(read("lib/settingsRegistry.ts"));
const row = stripComments(read("features/chat/ChatMessage.tsx"));
const css = stripCssComments(read("globals.css"));

test("every format has samples covering its widest output", () => {
  for (const f of TS_FORMATS) assert.ok(tsWidestSamples(f).length > 0, f);
  assert.ok(tsWidestSamples("24s").includes("00:00:00"));
  assert.ok(tsWidestSamples("standard").includes("00:00:00"), "live 'standard' is 24h with seconds");
  assert.ok(tsWidestSamples("12s").includes("12:00:00 PM"));
  assert.ok(tsWidestSamples("rel").includes("99d ago"));
});

test("no DOM (server, tests) → no measurement, so the caller falls back", () => {
  assert.equal(measureTsWidth("24s"), null);
});

test("applyWrap measures the time and sets the width vars — once per frame", () => {
  const now = reg.match(/function applyWrapNow\(ctx: ApplyCtx\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(now, "applyWrapNow exists");
  const body = now?.[1] ?? "";
  assert.match(body, /measureTsWidth\(fmt\)/);
  assert.match(body, /"--chat-ts-w"/);
  assert.match(body, /"--chat-ts-shown-w"/);
  assert.match(body, /tsIndentWidth\(fmt\)/, "the ch table stays as the fallback (and the pre-paint's first frame)");
  // A full settings apply calls applyWrap from ~8 effects; each measurement
  // forces a whole-page layout. They coalesce into ONE per frame.
  const sched = reg.match(/function applyWrap\(ctx: ApplyCtx\)\s*\{([\s\S]*?)\n\}/);
  assert.match(sched?.[1] ?? "", /if \(!wrapRaf\) wrapRaf = requestAnimationFrame\(/);
  assert.doesNotMatch(sched?.[1] ?? "", /measureTsWidth/, "no measurement inside the per-effect call");
});

test("applyWrap re-runs when anything that changes the time's width changes", () => {
  for (const key of ["sliderVal", "fontFamily", "tsFont", "tsSize"]) {
    const m = reg.match(new RegExp(`\\n  ${key}: E\\(\\{[\\s\\S]*?\\n  [a-zA-Z0-9]+: E\\(`));
    assert.ok(m, key);
    assert.match(m?.[0] ?? "", /applyWrap\(ctx\)/, `${key} must re-run applyWrap`);
  }
  assert.match(reg, /document\.fonts\.addEventListener\("loadingdone"/, "a late web font re-measures");
});

test("the time is one fixed-width column; grouped rows subtract it from the spacer", () => {
  assert.match(row, /display: "inline-block", minWidth: "var\(--chat-ts-w, auto\)", textIndent: 0/,
    "an inline-block INHERITS the body's hanging text-indent (-W) on its own first line — the digits drew ~W px left of their box, off the row (.chat-pfp resets it for the same reason)");
  assert.match(css, /\.chat-group-on \.chat-compact \.chat-continuation \{[^}]*width: max\(0px, calc\(var\(--chat-wrap-padding, 0px\) - var\(--chat-ts-shown-w, 0px\)\)\);/);
  assert.match(reg, /export const REGISTRY|export const DEFAULTS/, "registry read");
  assert.ok(css.trim().endsWith("}"), "vacuity anchor: globals.css to its end");
});
