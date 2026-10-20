// The two failure surfaces.
//
// node's TypeScript support strips types, NOT JSX. "./testTsx.ts" is this
// repo's answer: a synchronous module.registerHooks resolver + transpileModule
// loader for "@/" and .tsx specifiers, armed by importing it. It must be a
// STATIC import so the hooks register before anything else resolves, which is
// why the component below is imported dynamically. Same shape as
// streamModeMenu.test.ts. Run: node --test app/lib/playerFailurePanel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import "./testTsx.ts";
const { PlayerFailurePanel } = await import("../features/player/PlayerFailurePanel.tsx");

const here = dirname(fileURLToPath(import.meta.url));
const panelPath = join(here, "..", "features", "player", "PlayerFailurePanel.tsx");
const noop = () => {};

test("nothing renders while playback is fine — this holds no permanent space", () => {
  const html = renderToStaticMarkup(createElement(PlayerFailurePanel, {
    blocked: false, failure: null, onPlay: noop, onDismiss: noop,
  }));
  assert.equal(html, "", "the panel must render nothing when there is nothing wrong");
});

test("a refused autoplay offers a way to start playback", () => {
  const html = renderToStaticMarkup(createElement(PlayerFailurePanel, {
    blocked: true, failure: null, onPlay: noop, onDismiss: noop,
  }));
  assert.match(html, /<button/, "a blocked autoplay must offer a button, not a dead frame");
  assert.match(html, /aria-label="[^"]+"/, "the play affordance needs an accessible name");
});

test("a broken embed names its cause", () => {
  const html = renderToStaticMarkup(createElement(PlayerFailurePanel, {
    blocked: false,
    failure: { code: 101, reason: "The owner does not allow this video to play outside YouTube." },
    onPlay: noop, onDismiss: noop,
  }));
  assert.match(html, /does not allow this video/, "the reason must reach the viewer");
});

test("when both blocked and failure are true, failure wins — the reason renders, the play button does not", () => {
  const html = renderToStaticMarkup(createElement(PlayerFailurePanel, {
    blocked: true,
    failure: { code: 101, reason: "Owner disabled" },
    onPlay: noop, onDismiss: noop,
  }));
  assert.match(html, /Owner disabled/, "the failure reason must be visible");
  assert.match(html, /aria-label="Dismiss/, "a dismiss button, not a play button");
  assert.doesNotMatch(html, /aria-label="Play/, "the play button must not appear");
});

test("NO AUTOMATIC DEMOTION: the panel offers no source switch and writes nothing", () => {
  const src = stripComments(readFileSync(panelPath, "utf8"));
  assert.doesNotMatch(src, /setSource|player_live_source|localStorage|lsSet/,
    "the failure panel must never move the viewer or write a preference");
});

test("VACUITY ANCHOR: the panel source was read to the END", () => {
  assert.match(readFileSync(panelPath, "utf8").trimEnd().slice(-30), /\}\s*$/);
});
