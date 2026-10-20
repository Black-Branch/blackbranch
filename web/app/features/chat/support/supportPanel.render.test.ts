import "../../../lib/testTsx.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";

// The help desk's panel is an ordinary element of the chat column — not a pop-up portalled to
// <body> and pinned to the composer's coordinates. Reproduced at 390 px on the Home tab: the
// load-time greeting floated over Home, pointing at a composer in a pane that was not on screen,
// with no way to type the reply it asked for. In the column, it shows where the chat is, and
// only when the chat is.

const state = {
  msgs: [{ id: 1, role: "bot" as const, text: "If you need anything, I'm here to help!" }],
  options: [{ key: "k-a", label: "Report someone" }, { key: "k-b", label: "Something else" }],
  awaiting: null,
};

test("the panel renders in place: its greeting and its choices are in the markup where it is mounted", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { SupportPanel } = await import("./SupportPanel.tsx");
  const html = renderToStaticMarkup(createElement(SupportPanel, {
    state: state as never, onPick: () => {}, onClose: () => {},
    self: { name: "casey", color: null, badges: [] },
  }));
  assert.ok(html.includes("here to help"), "the greeting is not rendered in place");
  assert.ok(html.includes("Report someone") && html.includes("Something else"), "the choices are not rendered in place");
  assert.match(html, /aria-label="Close support"/);
});

test("the panel is not a portal or a positioned pop-up", () => {
  const src = stripComments(readFileSync(join(import.meta.dirname, "SupportPanel.tsx"), "utf8"));
  assert.doesNotMatch(src, /ComposerPopover|createPortal/, "the panel floats again");
  assert.doesNotMatch(src, /\bfixed\b/, "the panel is positioned against the viewport again");
  assert.ok(src.trimEnd().endsWith("}"), "END anchor: the whole file was read");
});

test("the chat column mounts the panel between the messages and the composer", () => {
  const src = stripComments(readFileSync(join(import.meta.dirname, "../ChatSidebar.tsx"), "utf8"));
  const panel = src.indexOf("<SupportPanel");
  const bar = src.indexOf('<Bar\n        slot="bottom"');
  const holds = src.indexOf("<AutomodHoldBar");
  assert.ok(panel !== -1 && bar !== -1 && holds !== -1, "a landmark moved — this test read nothing");
  assert.ok(holds < panel && panel < bar, "the panel is not in the column just above the composer");
  assert.ok(src.trimEnd().endsWith("}"), "END anchor: the whole file was read");
});
