// While the phone's keyboard is up under a top window, the chat column's bar-reveal stands down.
// (A top task you type in takes the whole visible pane by chrome.css alone; every top pull reaches
// the whole pane since #234, so the pull no longer asks who owns the keyboard.)
//
// Run: node --test app/lib/chrome/keyboardOwner.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom } from "../testDom.ts";
import "../testTsx.ts";

const { topWindowUnderKeyboard } = await import("./keyboardOwner.ts");
const doc = dom.window.document;

function panelIn(root: HTMLElement, attrs: Record<string, string>) {
  const p = doc.createElement("div");
  p.className = "chrome-window-panel";
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  const input = doc.createElement("input");
  p.appendChild(input);
  root.appendChild(p);
  return { p, input };
}

test("the bar-reveal stands down only with the keyboard up and a top window open in the column", () => {
  const col = doc.createElement("aside");
  doc.body.appendChild(col);
  doc.documentElement.classList.add("kb-open");
  assert.equal(topWindowUnderKeyboard(col), false, "no window");
  const bottom = panelIn(col, { "data-kind": "task" });
  assert.equal(topWindowUnderKeyboard(col), false, "a bottom window: the reveal is unchanged");
  bottom.p.remove();
  panelIn(col, { "data-from": "top", "data-kind": "task" });
  assert.equal(topWindowUnderKeyboard(col), true);
  doc.documentElement.classList.remove("kb-open");
  assert.equal(topWindowUnderKeyboard(col), false, "keyboard down: the swipe reveals the bar as before");
  col.remove();
});
