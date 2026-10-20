// BarButton — the one bar control.
//
// Run: node --test app/lib/chrome/barButton.render.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Static, and BEFORE the component import: registers the resolver that lets a
// .tsx specifier load at all (iconRail.render.test.ts's header explains why).
import "../testTsx.ts";
const { BarButton } = await import("../../components/chrome/BarButton.tsx");

// Typed to what every call site below actually passes (label always, display
// sometimes) — a bare Record<string, unknown> can't prove BarButtonProps's
// required `label` is present after the spread, so tsc rejects the call.
const render = (props: { label: string; display?: string }) =>
  renderToStaticMarkup(createElement(BarButton, { icon: "x", onClick: () => {}, ...props }));

test("one label prop drives BOTH aria-label and title", () => {
  // Three of the four hand-rolled spellings set one and not the other; the
  // whole point of a component is that they cannot disagree again.
  const html = render({ label: "Close" });
  assert.match(html, /aria-label="Close"/);
  assert.match(html, /title="Close"/);
});

test("it is a type=button carrying the shared class", () => {
  // type=button matters: these sit inside bars that can be nested in a form,
  // where the default `submit` would navigate.
  const html = render({ label: "Pop out" });
  assert.match(html, /type="button"/);
  assert.match(html, /class="[^"]*chrome-bar-btn/);
});

test("display is appended, never replacing the shared class", () => {
  // The fold arrow is desktop-only (`hidden md:flex`). A `display` prop that
  // REPLACED the class would silently un-style it — which is exactly how the
  // hand-rolled spellings started.
  const html = render({ label: "Fold", display: "hidden md:flex" });
  assert.match(html, /class="[^"]*chrome-bar-btn[^"]*hidden md:flex/);
});

// ── One button style everywhere ────────────────────────────────────────────

test("`active` marks a toggle's on-state as data-active — visual only, since these toggles rename themselves", () => {
  // A toggle whose label changes with its state ("Fold player" / "Unfold
  // player") must not ALSO carry aria-pressed: assistive tech would read a
  // pressed button whose name already says the other action. The on-state is
  // a data attribute for the style alone.
  const on = renderToStaticMarkup(createElement(BarButton, { icon: "x", onClick: () => {}, label: "Fold player", active: true }));
  const off = renderToStaticMarkup(createElement(BarButton, { icon: "x", onClick: () => {}, label: "Fold player", active: false }));
  assert.match(on, /data-active=""/);
  assert.doesNotMatch(on, /aria-pressed/);
  assert.doesNotMatch(off, /data-active/);
  assert.doesNotMatch(render({ label: "Close" }), /data-active/, "a plain control carries no state attribute");
});

