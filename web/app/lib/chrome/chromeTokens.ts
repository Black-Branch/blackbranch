// web/app/lib/chrome/chromeTokens.ts
// The two chrome heights, by NAME. The values live once, in globals.css :root;
// both are @property-registered <length>s, so a consumer that needs
// the number (the dock's space rules) reads the RESOLVED px back from computed
// style instead of measuring a bar's box — a bar is exactly its token tall,
// so measuring it would only re-derive what the stylesheet already says.
import { reportClientError } from "../clientError.ts";

export const CHROME_TOP_H = "--chrome-top-h";
// @test-only chromeTokens.test.ts pins both names; the bottom token has no JS reader.
export const CHROME_BOTTOM_H = "--chrome-bottom-h";
export type ChromeToken = typeof CHROME_TOP_H | typeof CHROME_BOTTOM_H;

/**
 * Mirrors globals.css's two `@property … initial-value` declarations
 * (chromeSkins.test.ts pins the two sides against each other) — the fallback
 * readChromePx hands back when getComputedStyle() cannot resolve the token to
 * a px length at all.
 *
 * @test-only exported for chromeTokens.test.ts and chromeSkins.test.ts;
 * readChromePx below is its only runtime caller, and a same-file call does
 * not count as a reference here.
 */
export const CHROME_INITIAL_PX: Record<ChromeToken, number> = {
  [CHROME_TOP_H]: 36,
  [CHROME_BOTTOM_H]: 48,
};

/**
 * "36px" → 36. Anything else is a missing @property registration, not a zero.
 *
 * @test-only exported for chromeTokens.test.ts; readChromePx below is its only
 * runtime caller, and a same-file call does not count as a reference here.
 */
export function parseChromePx(value: string): number {
  const m = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value);
  if (!m) throw new Error(`chrome token is not a computed px length: "${value}" — is its @property registration in globals.css intact?`);
  return Number(m[1]);
}

// One report per token, ever (this module instance — a fresh page load resets
// it). The sink already throttles identical messages to one per 30s, but
// BottomDock re-measures on every ResizeObserver tick, and there is no reason
// to keep re-reporting a fact that does not change mid-session.
const reportedTokens = new Set<ChromeToken>();

/**
 * Read a chrome token back as a resolved px number.
 *
 * parseChromePx above stays STRICT on purpose — it is the unit-testable core,
 * and its throw is the actual diagnosis (a missing/broken @property
 * registration in globals.css). But readChromePx is reached from BottomDock's
 * bare `useEffect`/`ResizeObserver` callback, with no ErrorBoundary between
 * the dock and app/error.tsx. In a browser with no @property support,
 * getComputedStyle() hands back the token's unresolved `calc()` text instead
 * of a px length, parseChromePx throws (correctly), and an uncaught throw
 * inside a ResizeObserver callback is not "the dock breaks" — it is an
 * uncaught exception on the stream route, i.e. a dark site. So: catch here,
 * report it once per token through the client-error sink, and fall back to
 * the token's registered initial value — a wrong row height is a degraded
 * dock, which is the worst this path may ever cost.
 */
/**
 * Does this browser implement registered custom properties at all? Firefox
 * before 128 (the 115 ESR line is still in use) does not, so there the token
 * ALWAYS reads back as its raw `calc()` text. That is the browser, not a broken
 * registration — the fallback below is the designed behaviour and there is
 * nothing to report. Reporting it anyway would make the canary fire on every
 * such visit, which is how a canary stops being read.
 *
 * @test-only exported for chromeTokens.test.ts; readChromePx below is its only
 * runtime caller, and a same-file call does not count as a reference here.
 */
export function browserRegistersProperties(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.registerProperty === "function";
}

export function readChromePx(el: Element, token: ChromeToken): number {
  try {
    return parseChromePx(getComputedStyle(el).getPropertyValue(token));
  } catch (err) {
    if (!reportedTokens.has(token) && browserRegistersProperties()) {
      reportedTokens.add(token);
      reportClientError("chrome-token", err);
    }
    return CHROME_INITIAL_PX[token];
  }
}
