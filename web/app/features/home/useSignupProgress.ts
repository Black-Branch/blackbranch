"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/app/lib/http";
import type { SignupStep } from "@/app/lib/signupProgress";

// Where the viewer is in the sign-up steps. `undefined` = not
// asked yet (render the card, never a flash of steps over it); `null` = no row
// (the steps start at 2). Only asked while Home is active and the viewer signed
// in; an unanswerable question reads as "done" so a dead route never shows the
// steps.
export function useSignupProgress(active: boolean, signedIn: boolean) {
  // The answer is keyed on the signedIn it was asked for: the identity
  // provider starts with no matrixId, so the first render is signed-out
  // (null) and the flip to signed-in must read "not asked yet" (undefined)
  // until /api/home/me answers — a stale null showed step 2 to everyone for
  // one round trip (final review, Important 2).
  const [answer, setAnswer] = useState<{ signedIn: boolean; step: SignupStep | null | undefined }>({ signedIn, step: signedIn ? undefined : null });
  const step = answer.signedIn === signedIn ? answer.step : (signedIn ? undefined : null);

  useEffect(() => {
    if (!active || !signedIn) return;
    let cancelled = false;
    getJson<{ step: SignupStep | null }>("/api/home/me")
      .then((d) => { if (!cancelled) setAnswer({ signedIn: true, step: d?.step ?? null }); })
      .catch(() => { if (!cancelled) setAnswer({ signedIn: true, step: "done" }); });
    return () => { cancelled = true; };
  }, [active, signedIn]);

  const setStep = useCallback((s: SignupStep) => {
    setAnswer({ signedIn: true, step: s });
    void postJson("/api/home/me", { step: s }, "PUT").catch(() => {});
  }, []);

  return { step, setStep };
}
