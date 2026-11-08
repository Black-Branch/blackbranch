// Which surface answers a verification request: Settings (your own other device) or the
// person-to-person prompt (someone else) — and the provider keeps one pending slot per kind, so a
// request of one kind never replaces a waiting request of the other.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { verificationKind, verificationSlot } from "./verificationKind.ts";
import { PHASE_CANCELLED, PHASE_DONE, PHASE_READY } from "./matrixVerification.ts";

const me = "@casey:site.test";

test("own other device → self", () => {
  assert.equal(verificationKind({ otherUserId: me, isSelfVerification: true }, me), "self");
  // The id alone decides it too (a request object that has not filled isSelfVerification).
  assert.equal(verificationKind({ otherUserId: me, isSelfVerification: false }, me), "self");
});

test("another user → user", () => {
  assert.equal(verificationKind({ otherUserId: "@riley:site.test", isSelfVerification: false }, me), "user");
});

test("a live request goes to its kind's slot; a finished one (sync catch-up) goes nowhere", () => {
  const mine = { otherUserId: me, isSelfVerification: true, phase: 2 };
  const theirs = { otherUserId: "@riley:site.test", isSelfVerification: false, phase: PHASE_READY };
  assert.equal(verificationSlot(mine, me), "self");
  assert.equal(verificationSlot(theirs, me), "user");
  for (const phase of [PHASE_CANCELLED, PHASE_DONE]) assert.equal(verificationSlot({ ...theirs, phase }, me), null);
});

test("wiring: the provider keeps one slot per kind and routes both the sync's requests and offered ones through verificationSlot", () => {
  const ctx = stripComments(readFileSync(join(process.cwd(), "app/lib/MatrixClientContext.tsx"), "utf8"));
  assert.match(ctx, /useState<\{ self: unknown \| null; user: unknown \| null \}>\(\{ self: null, user: null \}\)/);
  const received = ctx.indexOf("CryptoEvent.VerificationRequestReceived");
  assert.ok(received > 0);
  assert.match(ctx.slice(received, received + 400), /routeVerification\(request, userId\)/);
  const offer = ctx.indexOf("const offerVerification = useCallback(");
  assert.ok(offer > 0);
  assert.match(ctx.slice(offer, offer + 300), /routeVerification\(request, /);
  const route = ctx.indexOf("const routeVerification = useCallback(");
  assert.ok(route > 0);
  assert.match(ctx.slice(route, route + 400), /verificationSlot\(/);
  // End anchor.
  assert.match(ctx.slice(-400), /<\/Ctx\.Provider>\s*\);\s*\}\s*$/);
});
