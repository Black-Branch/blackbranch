import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// CharCounter is a REAL .tsx component — node's native TypeScript support
// strips types, not JSX. ../lib/testTsx.ts is this repo's answer: a
// synchronous module.registerHooks resolver + transpileModule loader for "@/"
// and .tsx specifiers, armed by importing it. STATIC import so its hooks are
// registered before anything else resolves; the component import is dynamic
// for the same reason (barButton.render.test.ts, iconRail.render.test.ts).
import "../lib/testTsx.ts";
const { CharCounter } = await import("./CharCounter.tsx");

const html = (props: Parameters<typeof CharCounter>[0]) => renderToStaticMarkup(createElement(CharCounter, props));

test("hidden while comfortably under the limit", () => {
  assert.equal(html({ length: 10, max: 200 }), "");
});

test("shows the number left once within the window", () => {
  const out = html({ length: 160, max: 200 });
  assert.match(out, />40</);
  assert.doesNotMatch(out, /text-red-400/);
});

test("red at the limit and past it, and the number goes negative rather than lying", () => {
  assert.match(html({ length: 200, max: 200 }), /text-red-400[^>]*>0</);
  assert.match(html({ length: 237, max: 200 }), /text-red-400[^>]*>-37</);
});

test("showWithin widens the window", () => {
  assert.match(html({ length: 0, max: 50, showWithin: 50 }), />50</);
});
