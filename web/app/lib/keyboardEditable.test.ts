// The keyboard prediction fires only for targets that TYPE.
// Run: node --test app/lib/keyboardEditable.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom } from "./testDom.ts";
import { stripComments } from "./testSource.ts";
import { raisesKeyboard } from "./keyboardEditable.ts";

const input = (type: string | null) => {
  const el = dom.window.document.createElement("input");
  if (type !== null) el.setAttribute("type", type);
  return el;
};

test("text-entry inputs, textareas and contenteditable raise the keyboard", () => {
  for (const t of ["text", "search", "url", "tel", "email", "password", "number", "TEXT"]) {
    assert.equal(raisesKeyboard(input(t)), true, `type=${t}`);
  }
  assert.equal(raisesKeyboard(input(null)), true, "no type attribute = text");
  assert.equal(raisesKeyboard(dom.window.document.createElement("textarea")), true);
  const ce = dom.window.document.createElement("div");
  ce.setAttribute("contenteditable", "true");
  dom.window.document.body.appendChild(ce);
  assert.equal(raisesKeyboard(ce), true);
  ce.remove();
});

test("a colour swatch, and the other picker/button inputs, do not", () => {
  for (const t of ["color", "range", "checkbox", "radio", "button", "submit", "file", "date", "time"]) {
    assert.equal(raisesKeyboard(input(t)), false, `type=${t}`);
  }
  assert.equal(raisesKeyboard(dom.window.document.createElement("div")), false);
  assert.equal(raisesKeyboard(null), false);
});

test("the keyboard-height hook predicts through this rule, not its own tag check", () => {
  const src = stripComments(readFileSync(new URL("./useViewportHeightVar.ts", import.meta.url), "utf8"));
  assert.match(src, /function onFocusIn\(e: FocusEvent\) \{\s*if \(!raisesKeyboard\(e\.target\)\) return;/);
  assert.ok(!/el\.tagName === "INPUT" \|\| el\.tagName === "TEXTAREA"/.test(src), "the old any-<input> check is gone");
  assert.ok(src.lastIndexOf("removeEventListener(\"focusout\"") > src.indexOf("raisesKeyboard("), "END anchor");
});
