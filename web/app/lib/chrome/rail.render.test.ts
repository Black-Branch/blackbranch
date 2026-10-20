// Rail fold + RailLayout picker, rendered.
// Run: node --test app/lib/chrome/rail.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../testTsx.ts";
const { Rail } = await import("../../components/chrome/Rail.tsx");
const { RailLayout } = await import("../../components/chrome/RailLayout.tsx");

const items = [
  { key: "ai/models", label: "Models", group: "AI" },
  { key: "ai/bot", label: "Chat Bot", group: "AI" },
  { key: "ai/behavior", label: "Bot behavior", group: "AI", depth: 1 as const },
  { key: "utility/obs", label: "OBS", group: "Utility" },
  { key: "utility/timer", label: "Timer", group: "Utility", depth: 1 as const },
];
const rail = (value: string, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(Rail, { items, value, onChange: () => {}, label: "Places", fold: true, ...extra }));

test("fold: the selected place's group is open, the others are headings only", () => {
  const html = rail("ai/models");
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2, "Models + Chat Bot; Bot behavior folded under Chat Bot, Utility closed");
  assert.match(html, /aria-expanded="true"[^>]*>.*?AI/);
  assert.match(html, /aria-expanded="false"[^>]*>.*?Utility/);
  assert.doesNotMatch(html, />OBS</);
});

test("fold: a nested place shows with its parent selected; the parent carries the marker", () => {
  const html = rail("ai/bot");
  assert.match(html, />Bot behavior</);
  assert.match(html, /data-parent=""/);
});

test("fold: expandAll (a search) shows every place", () => {
  assert.equal((rail("ai/models", { expandAll: true }).match(/role="tab"/g) ?? []).length, 5);
});

test("without fold the rail renders every item with aria-hidden group headings (unchanged)", () => {
  const html = renderToStaticMarkup(createElement(Rail, { items, value: "ai/models", onChange: () => {}, label: "Places" }));
  assert.equal((html.match(/role="tab"/g) ?? []).length, 5);
  assert.match(html, /class="chrome-rail-group" aria-hidden="true"/);
});

test("picker: a button names the open place and the compact heading is not drawn", () => {
  // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file: children travels in the props object, which tsc's overload needs
  const html = renderToStaticMarkup(createElement(RailLayout, {
    rail: createElement("div", { className: "chrome-rail" }), compact: "picker", pickerLabel: "AI · Models", compactHeading: "AI · Models", current: "ai/models",
    children: createElement("p", null, "content"),
  }));
  assert.match(html, /data-compact="picker"/);
  assert.match(html, /<button type="button" class="chrome-rail-picker" aria-expanded="false">/);
  assert.match(html, />AI · Models</);
  assert.doesNotMatch(html, /chrome-rail-compact-heading/);
});

test("icons (the default) keep the compact heading and draw no picker", () => {
  // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file: children travels in the props object, which tsc's overload needs
  const html = renderToStaticMarkup(createElement(RailLayout, { rail: null, compactHeading: "Theme", children: createElement("p", null, "x") }));
  assert.match(html, /chrome-rail-compact-heading/);
  assert.doesNotMatch(html, /chrome-rail-picker/);
});
