// Run: node --test app/lib/deviceClass.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceClass } from "./deviceClass.ts";

test("no window (SSR) → desktop", () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
  assert.equal(deviceClass(), "desktop");
});

test("window present but matchMedia missing → desktop", () => {
  const g = globalThis as { window?: unknown };
  g.window = {};
  try {
    assert.equal(deviceClass(), "desktop");
  } finally {
    delete g.window;
  }
});

test("coarse pointer + narrow viewport (matchMedia matches) → mobile", () => {
  const g = globalThis as { window?: unknown };
  g.window = { matchMedia: () => ({ matches: true }) };
  try {
    assert.equal(deviceClass(), "mobile");
  } finally {
    delete g.window;
  }
});

test("fine pointer / wide viewport (matchMedia does not match) → desktop", () => {
  const g = globalThis as { window?: unknown };
  g.window = { matchMedia: () => ({ matches: false }) };
  try {
    assert.equal(deviceClass(), "desktop");
  } finally {
    delete g.window;
  }
});
