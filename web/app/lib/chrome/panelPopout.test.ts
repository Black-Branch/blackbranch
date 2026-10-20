// PanelWindow must offer the pop-out that FloatingWindow already does.
//
// A panel window with a popoutUrl (the mod panel's "/mod") shows the pop-out
// button by the ✕, like the chat appearance page's back arrow and pop-out —
// the button must not be a FloatingWindow-only feature.
//
// Run: node --test app/lib/chrome/panelPopout.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../testSource.ts";

const WINDOW = "app/components/chrome/Window.tsx";
const MODWINDOW = "app/features/moderation/ModWindow.tsx";
const src = (p: string) => stripComments(readFileSync(p, "utf8"));

test("PanelWindow destructures popoutUrl from its props", () => {
  const s = src(WINDOW);
  const body = s.slice(s.indexOf("function PanelWindow"));
  const destructure = body.slice(0, body.indexOf("\n", body.indexOf("} = props;")));
  assert.match(destructure, /popoutUrl/, "PanelWindow cannot render a prop it never reads");
});

test("PanelWindow's band receives onPopout", () => {
  const s = src(WINDOW);
  const body = s.slice(s.indexOf("function PanelWindow"));
  const band = body.slice(body.indexOf("<WindowBand"), body.indexOf("/>", body.indexOf("<WindowBand")));
  assert.match(band, /onPopout=/, "the panel band must offer the pop-out, like the floating band");
});

test("the mod panel uses the panel shell on narrow, never the fullscreen page", () => {
  const s = src(MODWINDOW);
  // A phone always gets the panel; the shape comes from windowDock (a computer
  // may slide it in too).
  assert.match(s, /useWindowDock\("mod", narrow\)/);
  assert.match(s, /presentation=\{win\.presentation\}/);
  assert.doesNotMatch(s, /presentation=\{[^}]*"page"/,
    '"page" is the fullscreen presentation');
});

test("the mod panel is a TASK panel, not a peek", () => {
  // chat appearance is `peek` because its settings are judged against the live
  // chat behind it (AccountCard.tsx:169-176). The mod panel previews nothing,
  // so it takes full pane height like every other task surface.
  assert.match(src(MODWINDOW), /kind="task"/);
});

// Vacuity anchors at the END of the file.
test("the scanned files are the real ones and still define what is asserted", () => {
  const w = src(WINDOW);
  assert.match(w, /function PanelWindow/, "Window.tsx no longer defines PanelWindow");
  assert.match(w, /function FloatingWindow/, "Window.tsx no longer defines FloatingWindow");
  assert.match(src(MODWINDOW), /popoutUrl=\{popout \? undefined : "\/mod"\}/, "ModWindow lost the popout URL entirely");
});

test("stripComments is stripping — a prose mention must not count", () => {
  const raw = readFileSync(MODWINDOW, "utf8");
  assert.match(raw, /own tool window/, "the raw file should carry its docblock");
  assert.doesNotMatch(src(MODWINDOW), /own tool window/, "stripComments is not stripping");
});
