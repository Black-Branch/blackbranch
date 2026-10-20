// Who owns the phone's keyboard — a top TASK window with focus inside it while the
// keyboard is up takes the whole visible pane (and its pull reaches it); and while the keyboard is
// up under a top window, the chat column's bar-reveal stands down.
//
// Run: node --test app/lib/chrome/keyboardOwner.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom } from "../testDom.ts";
import "../testTsx.ts";

const { ownsKeyboard, topWindowUnderKeyboard } = await import("./keyboardOwner.ts");
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

test("a top task window owns the keyboard only with the keyboard up AND focus inside it", () => {
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const { p, input } = panelIn(root, { "data-from": "top", "data-kind": "task" });
  const chatBox = doc.createElement("textarea");
  root.appendChild(chatBox);
  input.focus();
  assert.equal(ownsKeyboard(p), false, "no keyboard: the usual half");
  doc.documentElement.classList.add("kb-open");
  assert.equal(ownsKeyboard(p), true, "keyboard up, typing in it: the whole pane");
  chatBox.focus();
  assert.equal(ownsKeyboard(p), false, "typing in the chat box: the chat shows under it again");
  const card = panelIn(root, { "data-from": "top", "data-kind": "peek" });
  card.input.focus();
  assert.equal(ownsKeyboard(card.p), false, "a card is content-fit — not this rule");
  const bottom = panelIn(root, { "data-kind": "task" });
  bottom.input.focus();
  assert.equal(ownsKeyboard(bottom.p), false, "a bottom window already reaches the ceiling");
  assert.equal(ownsKeyboard(null), false);
  doc.documentElement.classList.remove("kb-open");
  root.remove();
});

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
