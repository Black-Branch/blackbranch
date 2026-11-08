// Behavioural test for useMatrixVerification's consume effect, RENDERED not
// source-scanned — the contract is "does mounting this hook take the incoming
// request away from everyone else", which only a mounted hook can answer.
//
// The bug being pinned: the "Secure your account" nudge runs its own
// useMatrixSettings to read flowState; if that hook's verification effect
// consumed the one-shot incoming request (moving it into the nudge's local
// state and acking the provider) while the nudge rendered no verification UI,
// a verification started from another device would vanish whenever the nudge
// was on screen.
//
// `.ts` extensions are REQUIRED on these imports — `node --test` cannot
// resolve extensionless TypeScript specifiers.

import test from "node:test";
import assert from "node:assert/strict";
import { mountHook } from "./testDom.ts";
import { useMatrixVerification } from "./useMatrixVerification.ts";

/** A request emits its changes (VerificationRequestEvent.Change); these fixtures never change. */
const emits = { on: () => {}, off: () => {} };
/** A pending request as the hook reads it: the peer's device id, whose it is, and a phase. */
const pending = { otherDeviceId: "FIREFOXDEV", otherUserId: "@casey:site.test", isSelfVerification: true, phase: 0, ...emits };
/** Someone else's request (person-to-person verification). */
const fromSomeoneElse = { otherUserId: "@riley:site.test", isSelfVerification: false, initiatedByMe: false, phase: 2, ...emits };

async function mount(opts: { consume?: boolean; request?: unknown; kind?: "self" | "user" } = {}) {
  let cleared = 0;
  const h = await mountHook(() =>
    useMatrixVerification({
      client: null,
      kind: opts.kind ?? "self",
      pendingVerification: opts.request ?? pending,
      clearPendingVerification: () => { cleared += 1; },
      checkCrossSigningStatus: async () => {},
      schedule: (fn, ms) => setTimeout(fn, ms),
      ...(opts.consume === undefined ? {} : { consume: opts.consume }),
    })
  );
  return { h, get cleared() { return cleared; } };
}

test("a non-consuming mount leaves the incoming request alone: phase stays idle, the provider is not acked", async () => {
  const m = await mount({ consume: false });
  assert.equal(m.h.current.verifyPhase, "idle");
  assert.equal(m.h.current.verifyPeer, "");
  assert.equal(m.cleared, 0, "clearPendingVerification must NOT be called — that ack is what made the request vanish");
  await m.h.unmount();
});

test("the default (consuming) mount takes the request: phase becomes incoming, the provider is acked once", async () => {
  const m = await mount();
  assert.equal(m.h.current.verifyPhase, "incoming");
  assert.equal(m.h.current.verifyPeer, "FIREFOXDEV");
  assert.equal(m.cleared, 1);
  await m.h.unmount();
});

test("a request that finished while it waited in its slot is dropped (the provider is still acked)", async () => {
  for (const phase of [5, 6]) {
    const m = await mount({ kind: "user", request: { ...fromSomeoneElse, phase } });
    assert.equal(m.h.current.verifyPhase, "idle", `phase ${phase}: nothing to answer`);
    assert.equal(m.cleared, 1, "the slot is emptied so the next request can come");
    await m.h.unmount();
  }
});

test("kind 'self' leaves a user request pending (the person-to-person prompt answers it)", async () => {
  const m = await mount({ kind: "self", request: fromSomeoneElse });
  assert.equal(m.h.current.verifyPhase, "idle");
  assert.equal(m.cleared, 0);
  await m.h.unmount();
  const u = await mount({ kind: "user", request: fromSomeoneElse });
  assert.equal(u.h.current.verifyPhase, "incoming", "vacuity: the same request IS taken by kind 'user'");
  assert.equal(u.cleared, 1);
  await u.h.unmount();
});
