"use client";

import { useEffect, useRef, useState } from "react";
import { postJson } from "@/app/lib/http";
import { LoadingState } from "@/app/components/Spinner";

// PayPal's subscribe button (subscription sources S3, spec §5.2, §10.1).
//
// The subscription is created by OUR server (POST /api/billing/paypal/subscription), with a
// server-minted intent id as its custom_id (D13); `createSubscription` hands PayPal that
// subscription's id to open for approval. The browser never chooses the plan or the custom_id.
// ⚠ F3 (spec §2.1): that `createSubscription` may return a server-created id is what the sandbox
// check settles; the fallback is `actions.subscription.create({ plan_id, custom_id })` with the
// same server-minted intent, a change to this file and the route's answer only.
//
// `onApprove` grants NOTHING and writes nothing: it tells the caller to show "Confirming with
// PayPal…" and watch /api/me. PayPal's webhook is the only thing that makes the viewer a Supporter.
//
// ONE PAGE, TWO SDKs. Tips load PayPal's SDK with intent=capture as `window.paypal`
// (PayPalButton.tsx). A subscription needs `vault=true&intent=subscription`, a different script,
// so it is loaded under its own namespace (`data-namespace`) and only when this button mounts:
// the tip button's `window.paypal` is never replaced. ⚠ F4: the sandbox check confirms both
// buttons work on one page.
//
// Nothing here reads what PayPal returns about the payer (payerName.scan.test.ts scans this file).

const SDK_ORIGIN = "https://www.paypal.com/sdk/js";
const SCRIPT_ID = "paypal-sdk-subscriptions";
const NAMESPACE = "paypalSubscriptions";

type SubButtonsConfig = {
  fundingSource?: string;
  style: { height: number; shape: string; color: string; label: string };
  createSubscription: () => Promise<string>;
  onApprove: () => Promise<void>;
  onError: (err: unknown) => void;
  onCancel: () => void;
};
type SubNamespace = {
  Buttons: (config: SubButtonsConfig) => { render: (el: HTMLElement) => void; close?: () => void };
  FUNDING?: { PAYPAL: string };
};

function namespace(): SubNamespace | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as Record<string, SubNamespace | undefined>)[NAMESPACE] ?? null;
}

let loading: Promise<SubNamespace> | null = null;

/** One load per page, shared; a failure clears it so "Try again" starts a fresh script. */
function loadSdk(clientId: string, currency: string): Promise<SubNamespace> {
  const ready = namespace();
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<SubNamespace>((resolve, reject) => {
    document.getElementById(SCRIPT_ID)?.remove();
    const params = new URLSearchParams({
      "client-id": clientId,
      vault: "true",
      intent: "subscription",
      components: "buttons",
      currency: currency.toUpperCase(),
      // A card through PayPal at PayPal's rates when the Card button takes cards through Stripe is a
      // fee leak (PayPalButton.tsx's reason); pay-later finances a subscription.
      "disable-funding": "paylater,card",
    });
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = `${SDK_ORIGIN}?${params.toString()}`;
    s.async = true;
    s.setAttribute("data-namespace", NAMESPACE);
    s.addEventListener("load", () => { const ns = namespace(); if (ns) resolve(ns); else reject(new Error("no namespace")); }, { once: true });
    s.addEventListener("error", () => reject(new Error("PayPal SDK failed to load")), { once: true });
    document.body.appendChild(s);
  }).catch((e: unknown) => { loading = null; throw e; });
  return loading;
}

/** @test-only resets the shared load between tests (module state, as PayPalButton.tsx's). */
export function _resetPaypalSubscribeSdkForTests(): void {
  loading = null;
}

export type ElsewhereInfo = { provider: string; periodEnd: string | null };

export function PayPalSubscribeButton({
  clientId,
  currency,
  alsoElsewhere,
  onApproved,
  onElsewhere,
}: {
  clientId: string;
  currency: string;
  /** The viewer saw the "you'd be paying twice" warning and chose to subscribe anyway. */
  alsoElsewhere: boolean;
  onApproved: () => void;
  /** The server says the viewer is already a Supporter elsewhere (a stale page): show the warning. */
  onElsewhere: (e: ElsewhereInfo) => void;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const el = useRef<HTMLDivElement | null>(null);
  // Read inside PayPal's callbacks, which are created once per render of the button.
  const latest = useRef({ alsoElsewhere, onApproved, onElsewhere });
  useEffect(() => { latest.current = { alsoElsewhere, onApproved, onElsewhere }; });

  useEffect(() => {
    let alive = true;
    let close: (() => void) | undefined;
    loadSdk(clientId, currency).then((ns) => {
      if (!alive || !el.current) return;
      setStatus("ready");
      el.current.replaceChildren();
      const buttons = ns.Buttons({
        ...(ns.FUNDING ? { fundingSource: ns.FUNDING.PAYPAL } : {}),
        style: { height: 40, shape: "rect", color: "gold", label: "subscribe" },
        createSubscription: async () => {
          setErr(null);
          let res: Response;
          try {
            res = await postJson("/api/billing/paypal/subscription", { tier: "supporter", alsoElsewhere: latest.current.alsoElsewhere });
          } catch (e) {
            setErr("Network error. Try again.");
            throw e;
          }
          if (res.status === 409) {
            const body = (await res.json().catch(() => null)) as { error?: string; provider?: string; periodEnd?: string | null } | null;
            if (body?.error === "subscribed_elsewhere" && body.provider) latest.current.onElsewhere({ provider: body.provider, periodEnd: body.periodEnd ?? null });
            else if (body?.error === "subscribe_in_progress") setErr("The PayPal subscription you just started is still being confirmed — try again in a few minutes.");
            else setErr("You already have a PayPal subscription here.");
            throw new Error(body?.error ?? "conflict");
          }
          if (!res.ok) {
            const message = res.status === 429 ? "Too many attempts — try again in a minute."
              : res.status === 401 ? "Sign in to subscribe."
              : "Couldn’t start the subscription. Try again.";
            setErr(message);
            throw new Error(message);
          }
          const body = (await res.json().catch(() => null)) as { subscriptionId?: string } | null;
          if (!body?.subscriptionId) { setErr("Couldn’t start the subscription. Try again."); throw new Error("no subscription id"); }
          return body.subscriptionId;
        },
        onApprove: async () => { latest.current.onApproved(); },
        onError: (e) => {
          // PayPal reports a closed popup through onError ("Detected popup close"), not onCancel.
          const message = e instanceof Error ? e.message : String(e);
          if (/popup close|subscribed_elsewhere|already_subscribed|subscribe_in_progress|conflict/i.test(message)) return;
          setErr((cur) => cur ?? "Something went wrong with PayPal. Try again.");
        },
        onCancel: () => setErr(null),
      });
      buttons.render(el.current);
      close = () => buttons.close?.();
    }).catch(() => { if (alive) setStatus("failed"); });
    return () => { alive = false; close?.(); };
  }, [clientId, currency, attempt]);

  if (status === "failed") {
    return (
      <div className="flex flex-col items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
        <p className="text-xs text-secondary">We couldn’t load PayPal. An ad blocker or privacy filter is usually why. Nothing has been charged.</p>
        <button type="button" onClick={() => { setStatus("loading"); setAttempt((n) => n + 1); }}
          className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium text-heading hover:bg-control transition-colors">
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {status === "loading" && <LoadingState className="py-3" label="Loading PayPal…" />}
      {/* scheme-light: PayPal's iframe is a light document on a dark page (PayPalButton.tsx says why). */}
      <div className="h-10 overflow-hidden rounded-lg scheme-light">
        <div ref={el} />
      </div>
      {err && <p role="alert" className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
