// A real click in jsdom: the widget must hand the WHOLE item to the host, not
// just "open news" — the host opens the reader on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { createRoot } = await import("react-dom/client");
const { NewsWidget } = await import("./widgets/NewsWidget.tsx");

const item = { id: "n1", feedId: 1, feedTitle: "Feed", guid: "g1", title: "A headline", link: "https://x/1", summary: null, imageUrl: null, publishedAt: null };

test("a headline click hands the whole item to the host", async () => {
  const got: unknown[] = [];
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(React.createElement(NewsWidget, { news: [item], loading: false, nowMs: 0, onOpenNews: (i: unknown) => { got.push(i); } }));
    });
    const btn = host.querySelector("button");
    assert.ok(btn, "a button per row");
    await act(async () => { btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(got, [item]);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
