// The React adapter over the readiness registry: a thin useSyncExternalStore —
// a stage advance re-renders the reader with the new merged view, and an
// unchanged store does not.
import test from "node:test";
import assert from "node:assert/strict";
import { mountHook } from "./testDom.ts";
import "./testTsx.ts";
import { registerReadiness, _resetReadinessForTests } from "./readiness.ts";
const { useReadiness } = await import("./useReadiness.ts");

const KEYS = ["matrix", "emotes"] as const;

test("useReadiness re-renders on advance and hands back the merged, ordered view", async () => {
  _resetReadinessForTests();
  const matrix = registerReadiness("matrix", [{ id: "token", label: "Checking your session" }]);
  const h = await mountHook(() => useReadiness(KEYS));
  assert.deepEqual(h.current.map((s) => s.status), ["pending"]);
  const first = h.current;
  await h.act(async () => { matrix.advance("token", "active"); });
  assert.deepEqual(h.current.map((s) => s.status), ["active"]);
  assert.notEqual(h.current, first);
  await h.act(async () => { registerReadiness("emotes", [{ id: "catalog", label: "Loading emotes" }]); });
  assert.deepEqual(h.current.map((s) => `${s.key}/${s.id}`), ["matrix/token", "emotes/catalog"], "a late registrant appears in place, in the surface's key order");
  await h.unmount();
});
