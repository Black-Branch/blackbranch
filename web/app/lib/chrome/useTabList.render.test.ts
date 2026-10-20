// A real render (react-dom/server — no jsdom needed) proving that tab/panel
// ids are built from the item's INDEX, not its key, so a label with a space
// ("Mode & tools") cannot produce an invalid id, and that no consumer that
// renders no panel ships a dangling aria-controls (it is opt-in via
// `panels: true`).
// Run: node --test app/lib/chrome/useTabList.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useTabList, type TabItem } from "./useTabList.ts";

const ITEMS: TabItem[] = [
  { key: "one", label: "One" },
  { key: "Mode & tools", label: "Mode & tools" },
  { key: "three", label: "Three" },
];

// Written with createElement, not JSX — this is a .ts file, and node's
// native TypeScript support strips types, not JSX.
function TabListDemo({ panels }: { panels?: boolean }) {
  const { listProps, tabProps, panelProps } = useTabList({
    items: ITEMS,
    value: "Mode & tools",
    onChange: () => {},
    label: "Demo",
    panels,
  });
  return createElement(
    "div",
    null,
    createElement(
      "div",
      listProps,
      ITEMS.map((it, i) => createElement("button", { key: it.key, ...tabProps(i) }, it.label)),
    ),
    panels
      ? ITEMS.map((it) => createElement("div", { key: it.key, ...panelProps(it.key) }))
      : null,
  );
}

function tags(html: string, tag: string): string[] {
  return html.match(new RegExp(`<${tag}[^>]*>`, "g")) ?? [];
}
function attr(tagStr: string, name: string): string | undefined {
  return tagStr.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

test("useTabList: tab ids are index-based, valid, and unique even for a label with a space", () => {
  const html = renderToStaticMarkup(createElement(TabListDemo, {}));
  const ids = tags(html, "button").map((t) => attr(t, "id"));
  assert.equal(ids.length, 3);
  for (const id of ids) {
    assert.ok(id, "every tab has an id");
    assert.doesNotMatch(id!, /\s/, `id "${id}" must contain no whitespace`);
  }
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});

test("useTabList: exactly one tabindex=0, and aria-selected marks the selected tab", () => {
  const html = renderToStaticMarkup(createElement(TabListDemo, {}));
  const buttons = tags(html, "button");
  assert.equal(buttons.length, 3);
  const tabIndexes = buttons.map((b) => attr(b, "tabindex"));
  assert.equal(tabIndexes.filter((t) => t === "0").length, 1, "exactly one roving tabindex=0");
  const selectedFlags = buttons.map((b) => attr(b, "aria-selected"));
  assert.equal(selectedFlags.filter((s) => s === "true").length, 1, "exactly one aria-selected=true");
  assert.equal(selectedFlags[1], "true", '"Mode & tools" (index 1, the selected value) carries it');
});

test("useTabList: no aria-controls attribute when panels is omitted", () => {
  const html = renderToStaticMarkup(createElement(TabListDemo, {}));
  assert.doesNotMatch(html, /aria-controls/);
});

test("useTabList: aria-controls is present and matches a rendered panelProps id when panels: true", () => {
  const html = renderToStaticMarkup(createElement(TabListDemo, { panels: true }));
  const buttons = tags(html, "button");
  const controls = buttons.map((b) => attr(b, "aria-controls"));
  assert.equal(controls.length, 3);
  for (const c of controls) assert.ok(c, "every tab carries aria-controls");

  const panelTags = tags(html, "div").filter((t) => /role="tabpanel"/.test(t));
  assert.equal(panelTags.length, 3, "every panel rendered");
  const panelIds = panelTags.map((t) => attr(t, "id"));
  for (const c of controls) assert.ok(panelIds.includes(c), `aria-controls="${c}" must match a rendered panel id`);
});

function NullableDemo({ value }: { value: string | null }) {
  const { listProps, tabProps } = useTabList({ items: ITEMS, value, onChange: () => {}, label: "Demo" });
  return createElement("div", listProps, ITEMS.map((it, i) => createElement("button", { key: it.key, ...tabProps(i) }, it.label)));
}

test("useTabList: value null selects nothing but keeps exactly one roving tabindex=0", () => {
  const html = renderToStaticMarkup(createElement(NullableDemo, { value: null }));
  const buttons = tags(html, "button");
  assert.equal(buttons.filter((b) => attr(b, "aria-selected") === "true").length, 0, "nothing is selected");
  assert.equal(buttons.filter((b) => attr(b, "tabindex") === "0").length, 1, "the strip stays keyboard-reachable");
  assert.equal(attr(buttons[0]!, "tabindex"), "0", "focus falls to the first tab");
});
