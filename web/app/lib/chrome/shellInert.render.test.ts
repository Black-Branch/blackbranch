// Counted inert: two page-windows may stack (account card + mod window);
// the shell un-inerts only when the LAST one releases.
// Run: node --test app/lib/chrome/shellInert.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom } from "../testDom.ts";
import { acquireShellInert } from "./shellInert.ts";

test("counted acquire/release toggles #app-shell inert", () => {
  const shell = dom.window.document.createElement("div");
  shell.id = "app-shell";
  dom.window.document.body.appendChild(shell);
  const r1 = acquireShellInert();
  assert.ok(shell.hasAttribute("inert"), "first acquire inerts the shell");
  const r2 = acquireShellInert();
  r1();
  assert.ok(shell.hasAttribute("inert"), "still held by the second window");
  r2();
  assert.ok(!shell.hasAttribute("inert"), "last release restores the shell");
  r2(); // double-release must not underflow
  const r3 = acquireShellInert();
  assert.ok(shell.hasAttribute("inert"));
  r3();
  shell.remove();
});

test("no #app-shell (popout document): a safe no-op", () => {
  const release = acquireShellInert();
  release();
});
