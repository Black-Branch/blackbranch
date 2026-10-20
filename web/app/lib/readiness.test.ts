// The readiness registry's core — pure, node-tested, no React. A subsystem
// registers an ordered stage list once and reports through the returned
// reporter; surfaces read ONE merged, ordered view. The view's referential
// stability is load-bearing: useSyncExternalStore re-renders on every snapshot
// identity change, so an unchanged store must hand back the same array.
import test from "node:test";
import assert from "node:assert/strict";
import {
  registerReadiness, readReadiness, subscribeReadiness, summarizeReadiness, _resetReadinessForTests,
} from "./readiness.ts";

const MATRIX = [{ id: "token", label: "Checking your session" }, { id: "sync", label: "Syncing the community" }] as const;
const EMOTES = [{ id: "catalog", label: "Loading emotes" }] as const;

test.beforeEach(() => _resetReadinessForTests());

test("a registrant's stages read back in registration order, all pending, with their labels", () => {
  registerReadiness("matrix", MATRIX);
  assert.deepEqual(readReadiness(["matrix"]).map((s) => [s.key, s.id, s.label, s.status, s.error]), [
    ["matrix", "token", "Checking your session", "pending", null],
    ["matrix", "sync", "Syncing the community", "pending", null],
  ]);
});

test("advance moves one stage; error carries a message and clears when the stage moves on", () => {
  const r = registerReadiness("matrix", MATRIX);
  r.advance("token", "active");
  assert.equal(readReadiness(["matrix"])[0]!.status, "active");
  r.advance("token", "error", "Sign in to join the community");
  assert.deepEqual([readReadiness(["matrix"])[0]!.status, readReadiness(["matrix"])[0]!.error], ["error", "Sign in to join the community"]);
  r.advance("token", "done");
  assert.deepEqual([readReadiness(["matrix"])[0]!.status, readReadiness(["matrix"])[0]!.error], ["done", null], "leaving error clears the message — a stale reason on a done stage would be a lie");
  r.advance("sync", "error");
  assert.equal(readReadiness(["matrix"])[1]!.error, "Something went wrong", "an error without a reason still says SOMETHING — a blank error row reads as a stuck stage");
});

test("the merged view follows the ORDER OF KEYS the surface asks for, and skips keys nobody has registered yet", () => {
  registerReadiness("matrix", MATRIX);
  registerReadiness("emotes", EMOTES);
  assert.deepEqual(readReadiness(["emotes", "matrix"]).map((s) => `${s.key}/${s.id}`), ["emotes/catalog", "matrix/token", "matrix/sync"]);
  assert.deepEqual(readReadiness(["matrix", "dm"]).map((s) => `${s.key}/${s.id}`), ["matrix/token", "matrix/sync"],
    "a surface may compose a subsystem that has not registered — it contributes nothing until it does (the DM window's stages arrive with the DM program)");
});

test("the view is referentially stable until something changes — useSyncExternalStore's contract", () => {
  const r = registerReadiness("matrix", MATRIX);
  const a = readReadiness(["matrix"]);
  assert.equal(readReadiness(["matrix"]), a, "no change → the same array");
  assert.equal(readReadiness([]), readReadiness([]), "the empty view is stable too");
  r.advance("token", "active");
  const b = readReadiness(["matrix"]);
  assert.notEqual(b, a, "a change → a new array");
  r.advance("token", "active");
  assert.equal(readReadiness(["matrix"]), b, "advancing to the SAME status is not a change — Sync fires SYNCING every poll, and a fresh snapshot per poll would re-render every reader every 15s");
  assert.ok(Object.isFrozen(b), "frozen: a surface cannot mutate a snapshot other surfaces hold");
});

test("subscribers hear every change, and unsubscribe", () => {
  const r = registerReadiness("matrix", MATRIX);
  let n = 0;
  const off = subscribeReadiness(() => { n++; });
  r.advance("token", "active");
  r.advance("token", "active");
  assert.equal(n, 1, "one notification per real change");
  registerReadiness("emotes", EMOTES);
  assert.equal(n, 2, "a new registrant is a change (its stages appear in views that asked for its key)");
  off();
  r.advance("token", "done");
  assert.equal(n, 2);
});

test("re-registering the same key with the same stage ids KEEPS the statuses; a different shape replaces and resets", () => {
  // StrictMode/HMR re-run module code and effects; a registrant that
  // re-registers must not wipe progress it has already reported.
  const r = registerReadiness("matrix", MATRIX);
  r.advance("token", "done");
  registerReadiness("matrix", [{ id: "token", label: "Renamed" }, { id: "sync", label: "Syncing the community" }]);
  assert.equal(readReadiness(["matrix"])[0]!.status, "done", "same ids: progress kept…");
  assert.equal(readReadiness(["matrix"])[0]!.label, "Checking your session", "…and so is the original registration (the first label wins; a rename is a new shape, not a re-register)");
  registerReadiness("matrix", [{ id: "token", label: "Checking your session" }]);
  assert.deepEqual(readReadiness(["matrix"]).map((s) => [s.id, s.status]), [["token", "pending"]], "a different stage list is a new subsystem shape: replaced, all pending");
});

test("reset returns every stage to pending — the retry's first act", () => {
  const r = registerReadiness("matrix", MATRIX);
  r.advance("token", "done"); r.advance("sync", "error", "x");
  let n = 0; subscribeReadiness(() => { n++; });
  r.reset();
  assert.deepEqual(readReadiness(["matrix"]).map((s) => [s.status, s.error]), [["pending", null], ["pending", null]]);
  assert.equal(n, 1);
  r.reset();
  assert.equal(n, 1, "resetting an already-pending registrant is not a change");
});

test("an unknown stage id is a registrant bug: loud outside production, ignored in it", () => {
  const r = registerReadiness("matrix", MATRIX);
  assert.throws(() => r.advance("nope", "active"), /no stage "nope"/);
});

test("summarizeReadiness: idle with no stages, loading while any is pending/active, error if any failed, ready when all done", () => {
  assert.equal(summarizeReadiness([]).phase, "idle");
  const r = registerReadiness("matrix", MATRIX);
  assert.deepEqual(summarizeReadiness(readReadiness(["matrix"])), { phase: "loading", done: 0, total: 2, active: null, failed: null });
  r.advance("token", "active");
  assert.equal(summarizeReadiness(readReadiness(["matrix"])).active?.id, "token");
  r.advance("token", "done"); r.advance("sync", "error", "Connection lost");
  const s = summarizeReadiness(readReadiness(["matrix"]));
  assert.equal(s.phase, "error");
  assert.equal(s.failed?.error, "Connection lost");
  r.advance("sync", "done");
  assert.deepEqual(summarizeReadiness(readReadiness(["matrix"])), { phase: "ready", done: 2, total: 2, active: null, failed: null });
});
