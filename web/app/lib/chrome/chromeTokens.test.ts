// Run: node --test app/lib/chrome/chromeTokens.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHROME_TOP_H, CHROME_BOTTOM_H, CHROME_INITIAL_PX, parseChromePx, readChromePx, browserRegistersProperties } from "./chromeTokens.ts";

test("the token names are the globals.css custom properties", () => {
  assert.equal(CHROME_TOP_H, "--chrome-top-h");
  assert.equal(CHROME_BOTTOM_H, "--chrome-bottom-h");
});

test("a registered <length> computes to px, and that is the only thing accepted", () => {
  assert.equal(parseChromePx("36px"), 36);
  assert.equal(parseChromePx(" 47.5px "), 47.5);
  // an UNregistered property hands back its calc() text — that is a missing
  // @property in globals.css, and it must not be read as 0
  assert.throws(() => parseChromePx("calc(0.875rem + 22px)"), /not a computed px length/);
  assert.throws(() => parseChromePx(""), /not a computed px length/);
});

// readChromePx is called from BottomDock's
// bare useEffect/ResizeObserver — no ErrorBoundary sits between the dock and
// app/error.tsx. A browser with no @property support hands getComputedStyle()
// the unresolved calc() text, and parseChromePx (rightly) throws on it — but
// letting that throw escape readChromePx would take the whole stream route
// dark over a degraded dock. It must fall back instead.
test("readChromePx falls back to the token's initial value and does not throw when the browser has no @property support", () => {
  const savedGCS = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({
    getPropertyValue: () => "calc(0.875rem + 22px)",
  })) as unknown as typeof getComputedStyle;
  try {
    assert.doesNotThrow(() => readChromePx({} as Element, CHROME_TOP_H));
    assert.equal(readChromePx({} as Element, CHROME_TOP_H), CHROME_INITIAL_PX[CHROME_TOP_H]);
    assert.equal(readChromePx({} as Element, CHROME_BOTTOM_H), CHROME_INITIAL_PX[CHROME_BOTTOM_H]);
  } finally {
    globalThis.getComputedStyle = savedGCS;
  }
});

// The report is for a BROKEN registration. A browser that has no registered
// custom properties at all (Firefox 115 ESR) reads the raw calc() text every
// time by design — reporting that made the canary fire on every such visit.
test("a browser without CSS.registerProperty is not a reportable failure; one with it is", () => {
  const g = globalThis as { CSS?: unknown };
  const saved = g.CSS;
  try {
    delete g.CSS;
    assert.equal(browserRegistersProperties(), false);
    g.CSS = {};
    assert.equal(browserRegistersProperties(), false);
    g.CSS = { registerProperty() {} };
    assert.equal(browserRegistersProperties(), true);
  } finally {
    if (saved === undefined) delete g.CSS; else g.CSS = saved;
  }
});

test("readChromePx consults it before reporting", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("../testSource.ts");
  const src = stripComments(readFileSync(new URL("./chromeTokens.ts", import.meta.url), "utf8"));
  assert.match(src, /if \(!reportedTokens\.has\(token\) && browserRegistersProperties\(\)\) \{\s*reportedTokens\.add\(token\);\s*reportClientError\("chrome-token", err\);/);
});
