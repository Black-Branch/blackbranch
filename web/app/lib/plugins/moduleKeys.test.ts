import { test } from "node:test";
import assert from "node:assert/strict";
import { moduleKeyInstalled } from "./moduleKeys.ts";
import { MODULES } from "../instanceSchema.generated.mjs";

test("an owner module's keys show only when a plugin implements it", () => {
  const owner = MODULES.filter((m) => m.kind === "owner");
  assert.ok(owner.length >= 1, "the manifest has owner modules to test against");
  for (const m of owner) {
    assert.equal(moduleKeyInstalled(m.id, MODULES, null), false, `${m.id} without a plugin`);
    assert.equal(moduleKeyInstalled(m.id, MODULES, { id: "x", ownerModules: [] }), false);
    assert.equal(moduleKeyInstalled(m.id, MODULES, { id: "x", ownerModules: [m.id] }), true);
  }
});

test("product modules and core keys are always installed", () => {
  const product = MODULES.filter((m) => m.kind !== "owner");
  assert.ok(product.length >= 1);
  for (const m of product) assert.equal(moduleKeyInstalled(m.id, MODULES, null), true);
  assert.equal(moduleKeyInstalled(null, MODULES, null), true);
  assert.equal(moduleKeyInstalled("core", MODULES, null), true);
});
