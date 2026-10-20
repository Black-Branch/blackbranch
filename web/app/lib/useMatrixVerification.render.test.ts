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

/** A pending request as the hook reads it: the peer's device id and a phase. */
const pending = { otherDeviceId: "FIREFOXDEV", phase: 0 };

async function mount(opts: { consume?: boolean } = {}) {
  let cleared = 0;
  const h = await mountHook(() =>
    useMatrixVerification({
      client: null,
      pendingVerification: pending,
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
