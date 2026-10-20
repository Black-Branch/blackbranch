// payMethod.ts. Small enough to be a behavioural test throughout rather than a
// source scan: the module is three functions and a key, and every one of them
// is importable and runnable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, resetStorage } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts"; // registers the "@/" resolver payMethod.ts's import needs

const { readLastPayMethod, rememberPayMethod } = await import("./payMethod.ts");

test("defaults to card when nothing is stored", () => {
  resetStorage();
  assert.equal(readLastPayMethod(), "card");
});

test("round-trips a remembered method", () => {
  resetStorage();
  rememberPayMethod("paypal");
  assert.equal(readLastPayMethod(), "paypal");
  rememberPayMethod("venmo");
  assert.equal(readLastPayMethod(), "venmo");
  rememberPayMethod("card");
  assert.equal(readLastPayMethod(), "card");
});

test("an unrecognised stored value reads as card, not as a throw", () => {
  resetStorage();
  dom.window.localStorage.setItem("bb_tipMethod", "bitcoin");
  assert.equal(readLastPayMethod(), "card");
});

test("a throwing localStorage getter/setter never throws through — reads as card, write is a silent no-op", () => {
  resetStorage();
  const real = Object.getOwnPropertyDescriptor(dom.window.Storage.prototype, "getItem");
  const realSet = Object.getOwnPropertyDescriptor(dom.window.Storage.prototype, "setItem");
  Object.defineProperty(dom.window.Storage.prototype, "getItem", {
    configurable: true,
    value: () => { throw new DOMException("blocked", "SecurityError"); },
  });
  Object.defineProperty(dom.window.Storage.prototype, "setItem", {
    configurable: true,
    value: () => { throw new DOMException("blocked", "SecurityError"); },
  });
  try {
    assert.doesNotThrow(() => rememberPayMethod("paypal"));
    assert.doesNotThrow(() => {
      const m = readLastPayMethod();
      assert.equal(m, "card", "a throwing getter must read as the default, not propagate");
    });
  } finally {
    if (real) Object.defineProperty(dom.window.Storage.prototype, "getItem", real);
    if (realSet) Object.defineProperty(dom.window.Storage.prototype, "setItem", realSet);
  }
});
