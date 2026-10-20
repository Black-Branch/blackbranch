"use client";

import { useCallback, useEffect, useState } from "react";
import type { Stripe } from "@stripe/stripe-js";
import { getStripePromise, setStripePublishableKey, stripePublishableConfigured } from "./stripeClient";
import { getJson } from "./http";
import { setPaypalSandbox } from "./paypalSdkEnv";

// The ONE sanctioned way to consume getStripePromise(). <EmbeddedCheckoutProvider>
// does `parsed.stripePromise.then(…)` with NO `.catch`, so a raw promise handed
// to it lets a failed script load escape as an unhandled rejection, its
// internal `embeddedCheckout` stays null forever, and <EmbeddedCheckout>
// renders a bare empty <div>: the viewer presses Donate and gets a blank box
// with no error, no spinner and no way to retry. (Verified in node_modules,
// not assumed.)
//
// So the load is observed HERE, where a failure is state a component can render.

/** "retrying" is deliberately distinct from "loading": the first load gets a
 *  spinner, but a retry must keep the failure message on screen with its button
 *  disabled. A blocked request fails almost instantly, so collapsing the two
 *  would flash the spinner and put the same message back — which reads as the
 *  button doing nothing at all. */
export type StripeStatus = "loading" | "ready" | "failed" | "retrying";

export type StripeLoad = {
  /** Resolved Stripe.js. Only non-null once status is "ready". */
  stripe: Stripe | null;
  status: StripeStatus;
  /** Re-attempt the script load. This is only useful because getStripePromise()
   *  no longer caches a rejection — @stripe/stripe-js re-injects its <script>
   *  tag on the next call after a load error, so a retry can genuinely succeed
   *  when a blocker is turned off or a flaky network recovers. */
  retry: () => void;
};

export function useStripe(): StripeLoad {
  const [stripe, setStripe] = useState<Stripe | null>(null);
  const [status, setStatus] = useState<StripeStatus>("loading");
  // Bumping this re-runs the effect; it is the retry. Status is moved to
  // "retrying" by retry() itself (an event handler), never synchronously in the
  // effect body — `react-hooks/set-state-in-effect` is a hard error here, and
  // both settles below land in a promise callback, not the effect pass.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    getStripePromise().then(
      (s) => { if (alive) { setStripe(s); setStatus("ready"); } },
      () => { if (alive) setStatus("failed"); },
    );
    return () => { alive = false; };
  }, [attempt]);

  const retry = useCallback(() => {
    setStatus("retrying");
    setAttempt((n) => n + 1);
  }, []);

  return { stripe, status, retry };
}

/** Which payment providers this install takes money through. `stripe`: card payments (Stripe's
 *  embedded checkout, subscriptions, gifts). `paypalClientId`: PayPal and Venmo, null while off.
 *  A payment surface opens when EITHER is on. */
export type BillingAvailability = { stripe: boolean; paypalClientId: string | null };

/** The ONE availability answer for the payment surfaces (/donate, the Support panel, the Store,
 *  the stream page's support buttons), read from /api/billing/stripe/config.
 *
 *  First answer: a publishable key baked into the build (an older install's) and the PayPal id the
 *  caller already has from its server half (/donate's page.tsx), else none. Then the server's,
 *  read on mount AND again whenever the window regains focus — the server reads the switches at
 *  call time, so an operator's change (Site → Modules, a provider's setup page) shows on the next
 *  read, without a page reload. A recorded Stripe key goes to the card form. A failed request keeps
 *  the last answer: a hiccup must not hide a working checkout. */
export function useBillingAvailability(initialPaypalClientId: string | null = null, initialPaypalSandbox = false): BillingAvailability {
  // Recorded before anything renders a PayPal button, so the SDK URL's sandbox-only
  // buyer-country is right on the first load (paypalSdkEnv.ts).
  if (initialPaypalClientId) setPaypalSandbox(initialPaypalSandbox);
  const [stripe, setStripe] = useState<boolean>(stripePublishableConfigured());
  const [paypalClientId, setPaypalClientId] = useState<string | null>(initialPaypalClientId);
  useEffect(() => {
    let alive = true;
    const read = () => {
      getJson<{ publishableKey: string | null; paypalClientId?: string | null; paypalSandbox?: boolean }>("/api/billing/stripe/config", { cache: "no-store" })
        .then((d) => {
          if (!alive) return;
          const key = typeof d.publishableKey === "string" && /^pk_(live|test)_[A-Za-z0-9]+$/.test(d.publishableKey) ? d.publishableKey : null;
          if (key) setStripePublishableKey(key);
          setStripe(key !== null);
          setPaypalSandbox(d.paypalSandbox === true); // before the id: the button that mounts on it loads the SDK
          setPaypalClientId(typeof d.paypalClientId === "string" && d.paypalClientId ? d.paypalClientId : null);
        })
        .catch(() => { /* keep the last answer */ });
    };
    read();
    window.addEventListener("focus", read);
    return () => { alive = false; window.removeEventListener("focus", read); };
  }, []);
  return { stripe, paypalClientId };
}
