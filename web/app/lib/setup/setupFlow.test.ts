// The setup pages' order and resume. Run: node --test app/lib/setup/setupFlow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepOrder, resumeStep, nextStep, previousStep, maySave } from "./setupFlow.ts";

test("the order: the eight fixed pages, one per switched-on module with setup steps", () => {
  assert.deepEqual(stepOrder([]), ["admin", "recovery", "site", "points", "modules", "community", "finish"]);
  assert.deepEqual(stepOrder(["obs"]), ["admin", "recovery", "site", "points", "modules", "module:obs", "community", "finish"]);
});

test("resume: a closed browser comes back to the saved step", () => {
  const order = stepOrder(["obs"]);
  for (const s of ["recovery", "site", "points", "modules", "module:obs", "community", "finish"]) assert.equal(resumeStep(s, order, true), s);
  assert.equal(resumeStep(undefined, order, true), "recovery", "an admin with nothing saved yet: the step after the account");
  // No admin yet: the first step, whatever was saved.
  assert.equal(resumeStep("points", order, false), "admin");
  // A module step whose module was switched off since: back to the modules page.
  assert.equal(resumeStep("module:obs", stepOrder([]), true), "modules");
  // Garbage or "admin" saved after the admin exists never re-opens the account page.
  assert.equal(resumeStep("admin", order, true), "recovery");
  assert.equal(resumeStep("nope", order, true), "recovery");
});

test("next / back: back never reaches the account or the recovery sheet", () => {
  const order = stepOrder([]);
  assert.equal(nextStep("recovery", order), "site");
  assert.equal(nextStep("finish", order), null);
  assert.equal(previousStep("site", order), null, "the recovery sheet is shown once");
  assert.equal(previousStep("points", order), "site");
  assert.equal(previousStep("community", order), "modules");
});

test("a page may be saved only when it is the current one or one already passed — never ahead, never one-way ones", () => {
  const order = stepOrder([]);
  assert.equal(maySave("points", "points", order), true);
  assert.equal(maySave("site", "points", order), true);
  assert.equal(maySave("community", "points", order), false, "no skipping ahead");
  assert.equal(maySave("recovery", "points", order), false);
  assert.equal(maySave("admin", "points", order), false);
  assert.equal(maySave("recovery", "recovery", order), true);
  assert.equal(maySave("module:obs", "community", order), false, "not in this order");
});

test("the lists chosen on the modules page follow the module pages; a dropped one resumes at modules", () => {
  const order = stepOrder(["stripe"], ["twitch", "kick"]);
  assert.deepEqual(order.slice(4, 8), ["modules", "module:stripe", "core:twitch", "core:kick"]);
  assert.equal(order.at(-2), "community");
  assert.equal(resumeStep("core:kick", order, true), "core:kick");
  assert.equal(resumeStep("core:streamplace", order, true), "modules", "a list unticked since");
  assert.equal(nextStep("core:kick", order), "community");
});
