import { test } from "node:test";
import { siteName } from "./siteName.ts";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
// StreamModeMenu is a REAL .tsx component — node's native TypeScript support
// strips types, not JSX (iconRail.render.test.ts's header says this for the
// same reason). "./testTsx.ts" is the module's own answer: a synchronous
// module.registerHooks resolver + transpileModule loader for "@/" and .tsx
// specifiers, armed by importing it. It must be a STATIC import so its hooks
// are registered before anything else resolves, so the component import below
// is dynamic.
import "./testTsx.ts";
const { StreamModeMenu } = await import("../components/StreamModeMenu.tsx");
const { liveOptions } = await import("./playerMode.ts");

const html = renderToStaticMarkup(createElement(StreamModeMenu, {
  options: liveOptions("twitch"), onPick: () => {}, onClose: () => {}, anchorRef: { current: null },
}));

test("menu semantics: one menuitemradio per option, the current one checked", () => {
  assert.match(html, /role="menu"/);
  assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 4);
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  // `[\s\S]` instead of a dotAll `.`: this repo's tsc target (ES2017) predates
  // the `/s` flag, and `[\s\S]` matches identically (any char, newlines
  // included) without depending on it.
  assert.match(html, /aria-checked="true"[^>]*>(?:(?!<\/button>)[\s\S])*Twitch/);
});

test("plain names only — no header, no descriptions", () => {
  for (const label of [`${siteName()} player`, "Streamplace", "YouTube", "Twitch"]) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /Watch \S+ on|delay|ads|behind/i);
});

test("closes on Escape and on a press outside itself and its anchor", () => {
  const src = stripComments(readFileSync(new URL("../components/StreamModeMenu.tsx", import.meta.url), "utf8"));
  assert.match(src, /useOutsideClick\(\[ref, anchorRef\], onClose, \{ escape: true \}\)/);
  assert.match(src, /\}\s*$/); // END anchor
});

test("dismissal goes through the shared dismiss stack — a hand-rolled listener double-closes under a stacked surface", () => {
  const src = stripComments(readFileSync(new URL("../components/StreamModeMenu.tsx", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /addEventListener\("keydown"|addEventListener\("pointerdown"/);
  assert.match(src, /\}\s*$/); // END anchor
});
