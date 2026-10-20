// Username colour off Matrix, read under either namespace.
// Run: node --test app/lib/matrixProfileColor.test.ts
import "./legacyNamespace.setup.test.ts"; // first: this suite pins read-both (a legacy prefix is set)
import test from "node:test";
import assert from "node:assert/strict";
import { profileFieldColor, memberContentColor } from "./matrixProfileColor.ts";

const NEW = "app.blackbranch.username_color";
const OLD = "net.prior.username_color";

test("profile field: the spec body (keyed by the field name) under the product name", () => {
  const bodies: Record<string, Record<string, unknown>> = { [NEW]: { [NEW]: "#112233" } };
  assert.equal(profileFieldColor((f) => bodies[f] ?? null), "#112233");
});

test("profile field: legacy field when the product one is absent; product wins when both", () => {
  const bodies: Record<string, Record<string, unknown>> = { [OLD]: { [OLD]: "#aabbcc" } };
  assert.equal(profileFieldColor((f) => bodies[f] ?? null), "#aabbcc");
  bodies[NEW] = { [NEW]: "#112233" };
  assert.equal(profileFieldColor((f) => bodies[f] ?? null), "#112233");
});

test("profile field: the { color } body the writer sends is still accepted on read", () => {
  assert.equal(profileFieldColor((f) => (f === OLD ? { color: "#010203" } : null)), "#010203");
});

test("profile field: not a #rrggbb colour = absent, and a bad product value falls back", () => {
  assert.equal(profileFieldColor(() => ({ [NEW]: "red", [OLD]: "red" })), null);
  const bodies: Record<string, Record<string, unknown>> = { [NEW]: { [NEW]: "red" }, [OLD]: { [OLD]: "#aabbcc" } };
  assert.equal(profileFieldColor((f) => bodies[f] ?? null), "#aabbcc");
  assert.equal(profileFieldColor(() => null), null);
});

test("member content: either namespace, product first, validated", () => {
  assert.equal(memberContentColor({ [OLD]: "#aabbcc" }), "#aabbcc");
  assert.equal(memberContentColor({ [NEW]: "#112233", [OLD]: "#aabbcc" }), "#112233");
  assert.equal(memberContentColor({ [OLD]: "javascript:alert(1)" }), null);
  assert.equal(memberContentColor(undefined), null);
});
