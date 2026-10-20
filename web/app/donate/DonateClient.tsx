"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { useStripe, useBillingAvailability } from "@/app/lib/useStripe";
import StripeUnavailable from "@/app/components/StripeUnavailable";
import { LoadingState } from "@/app/components/Spinner";
import { postJson } from "@/app/lib/http";
import { usePaymentResult } from "@/app/lib/usePaymentResult";
import { SITE_NAME } from "@/app/lib/legal";
import { pointsForCents } from "@/app/lib/coins";
import { currencyName, currencyOnItsWay } from "@/app/lib/currency";
import { TipForm, type TipDraft, checkoutRequestFor } from "@/app/features/support";

// The standalone /donate page's client half — an address you can paste in
// chat. Renders the shared TipForm directly, through the support feature's
// public API (never a direct file import — check-structure rule 3). Once a
// card tip is started, the embedded Stripe box replaces it, using the same
// mountCheckout shape as SupportContent.tsx's donation section (the form's
// other surface) so the two stay in lockstep.
//
// Signed-out is the FIRST-CLASS case here: nothing on this page ever
// REQUIRES an account — no sign-in wall, ever. A guest does see one one-line
// nudge under the amount — "Sign in to also get N Qorm with this tip" — while
// tipping itself still asks nothing of them. TipForm owns that line
// (`signedIn` prop, below); this page's only job is answering it honestly.
//
// TipForm must NEVER render while a Stripe checkout session is open. A Stripe
// Checkout session's amount is fixed at creation — if the form stayed mounted
// and interactive below/above the box, a viewer could change the amount shown
// on screen after the box already committed to the old one, and pay believing
// they sent the new figure. This is why SupportContent switches views instead
// of stacking them; it is not a styling preference. See
// tipFormCheckoutGuard.scan.test.ts, which pins this.
//
// Split tip button: PayPal and Venmo are a mode of TipForm's own
// "Tip $X via <method> [▾]" button, so TipForm owns the whole button and stays
// MOUNTED for the entire PayPal flow (unlike Stripe, above) — the amount-drift
// risk is closed instead by TipForm locking every one of its own controls for
// the duration of a live PayPal order (see TipForm.tsx and PayPalButton.tsx).
// This page's only job for PayPal is handing TipForm the client id and an
// onPaypalCaptured callback — same shape as startCheckout for the card path.

type View = "form" | "checkout" | "done";

export function DonateClient({
  initialAmount,
  initialName,
  paypalClientId: serverPaypalClientId,
  paypalSandbox = false,
  signedIn,
}: {
  initialAmount?: number;
  initialName: string;
  /** `Boolean(session?.user?.id)` from page.tsx's own `auth()` call — passed
   *  straight through to TipForm's required `signedIn` prop (see there) and
   *  used here to gate the done view's "N Qorm is on its way" line, since
   *  Qorm crediting needs a matrix_id and a guest tip has none. */
  signedIn: boolean;
  /** From process.env.PAYPAL_CLIENT_ID, read server-side in page.tsx (a
   *  server component) rather than a NEXT_PUBLIC_* build-time var — the
   *  client id is public by design, but NEXT_PUBLIC_* is inlined at BUILD
   *  time, and the build host's env file is a different file from the
   *  runtime one. Null when unset: TipForm's split button then has no ▾ at
   *  all, and reads exactly "Tip $X". */
  paypalClientId: string | null;
  /** True when that PayPal is the sandbox (page.tsx, same rule as the order API):
   *  the SDK URL then carries PayPal's sandbox-only buyer-country=US. */
  paypalSandbox?: boolean;
}) {
  // Either provider opens the page (k, 2026-10-19): an install with PayPal/Venmo
  // only must still take a tip. The server half's PayPal id is the first answer,
  // so a PayPal-only page never flashes "isn't configured".
  const { stripe: stripeOn, paypalClientId } = useBillingAvailability(serverPaypalClientId, paypalSandbox);
  const configured = stripeOn || paypalClientId !== null;
  // Observed, not handed straight to EmbeddedCheckoutProvider — see useStripe.ts:
  // a failed script load would otherwise render a silent empty box.
  const { stripe, status: stripeStatus, retry: retryStripe } = useStripe();

  const [view, setView] = useState<View>("form");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // What the person last submitted, remembered so "← Change amount" can hand
  // it back as TipForm's initialDraft instead of losing it. TipForm is
  // unmounted for the entire time `view === "checkout"`, so this needs no
  // continuous syncing — one write on submit, one read on remount. Never
  // cleared afterwards, on the decline path OR the success path.
  const [draft, setDraft] = useState<TipDraft | null>(null);
  // R6: the decline banner must render OUTSIDE the Stripe iframe — it is
  // invisible from inside the frame, which was the whole point of the work
  // that added it. Wired exactly as SupportContent.tsx wires it.
  const declined = usePaymentResult(sessionId, view === "checkout");

  async function startCheckout(next: TipDraft) {
    setDraft(next);
    setBusy(true);
    setErr(null);
    try {
      const { endpoint, body } = checkoutRequestFor(next);
      const res = await postJson(endpoint, body);
      if (!res.ok) {
        // A 400 here is a rejection the route wrote FOR the person reading it
        // (e.g. "A $25.00 donation carries a message of up to 500
        // characters.") — surface it verbatim, same as SupportContent.
        setErr(
          res.status === 400
            ? (await res.text()) || "Something went wrong. Try again."
            : res.status === 503
              ? "Billing isn’t set up yet."
              : res.status === 401
                ? `Sign in to buy ${currencyName()}.`
                : res.status === 429
                  ? "Too many attempts — try again in a few minutes."
                  : "Something went wrong. Try again."
        );
        return;
      }
      const { clientSecret: cs, sessionId: sid } = (await res.json()) as {
        clientSecret?: string;
        sessionId?: string;
      };
      if (!cs) {
        setErr("Couldn’t start checkout.");
        return;
      }
      setClientSecret(cs);
      setSessionId(sid ?? null);
      setView("checkout");
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const options = useMemo(
    () => ({
      clientSecret: clientSecret ?? undefined,
      onComplete: () => setView("done"),
    }),
    [clientSecret],
  );

  // Returns to the form with a clean slate. Used both by "← Change amount"
  // (leaving an open checkout) and "Send another tip" (leaving "done") — both
  // must clear clientSecret AND sessionId, or a stale session could still be
  // paid from a screen that has moved on, or usePaymentResult could keep
  // polling a session no longer on screen.
  function backToForm() {
    setView("form");
    setClientSecret(null);
    setSessionId(null);
    setErr(null);
  }

  return (
    // The root layout's <body> is `h-app overflow-hidden` — the main site is a
    // fixed-viewport app shell. So a DOCUMENT-shaped page outside app/(main)/
    // must bring its own scroll container or its content is simply clipped at
    // the fold, with no scrollbar and no way to reach the button. app/billing/return
    // and app/legal do exactly this. (app/chat, app/popout and
    // app/overlay deliberately do NOT — they are fixed-viewport by design.)
    <div className="h-dvh overflow-y-auto">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 py-16">
      <div>
        <h1 className="text-2xl font-bold text-strong">Tip {SITE_NAME}</h1>
        <p className="mt-2 text-sm text-secondary">
          Chip in a one-off tip to support the stream — no account needed.
        </p>
      </div>

      {view === "checkout" && clientSecret ? (
        // TipForm is NOT rendered here, on purpose: the amount shown on screen
        // must never be able to drift from the amount the open Stripe session
        // actually charges. "← Change amount" is the only way back, and it
        // clears the session rather than stacking a live form on top of a
        // committed one.
        <div className="flex flex-col gap-3">
          <button onClick={backToForm} className="self-start text-xs text-secondary hover:text-body">
            ← Change amount
          </button>
          {declined && (
            <div className="flex flex-col gap-1 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-sm text-body">{declined.title}</p>
              <p className="text-xs text-secondary">{declined.body}</p>
            </div>
          )}
          {stripeStatus === "failed" || stripeStatus === "retrying" ? (
            <StripeUnavailable onRetry={retryStripe} retrying={stripeStatus === "retrying"} />
          ) : stripeStatus === "loading" ? (
            <LoadingState className="py-6" label="Loading secure payment form…" />
          ) : (
            <div className="rounded-lg overflow-hidden">
              <EmbeddedCheckoutProvider stripe={stripe} options={options}>
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            </div>
          )}
        </div>
      ) : view === "done" ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-raised bg-panel/60 py-8 text-center">
          <span className="text-3xl">♥</span>
          <p className="text-sm text-body">{draft && !draft.announce ? "Purchase complete — thank you!" : "Thank you for the support!"}</p>
          {/* Only for a signed-in tipper — Qorm crediting needs a matrix_id,
              and "on its way" (not "landed"): the webhook credits it, usually
              within seconds, but this view never claims it already has. */}
          {signedIn && draft && (
            <p className="text-xs text-secondary">
              {currencyOnItsWay(pointsForCents(Math.round(draft.amount * 100)))}
            </p>
          )}
          <button
            onClick={backToForm}
            className="rounded-lg bg-raised px-4 py-2 text-sm font-medium text-heading hover:bg-control transition-colors"
          >
            {draft && !draft.announce ? "Back" : "Send another tip"}
          </button>
        </div>
      ) : !configured ? (
        // After the checkout and done views, on purpose: a switch read while a
        // payment is open must not pull the box out from under it.
        <p className="text-sm text-amber-400/80">Billing isn’t configured on the server yet.</p>
      ) : (
        <section className="rounded-xl border border-raised bg-panel/60 p-4">
          <TipForm
            busy={busy}
            signedIn={signedIn}
            initialName={initialName}
            initialAmount={initialAmount}
            initialDraft={draft ?? undefined}
            onAmountChange={() => setErr(null)}
            error={err}
            onSubmit={startCheckout}
            paypalClientId={paypalClientId}
            cardAvailable={stripeOn}
            onPaypalCaptured={(d) => { setDraft(d); setView("done"); }}
          />
        </section>
      )}

      {/* Stripe's payment box only — PayPal shows its own currency choice. */}
      {stripeOn && (
        <p className="text-center text-2xs text-muted">
          Outside the US? You can switch the payment box to US dollars to skip the conversion fee.
        </p>
      )}

      <Link href="/" className="text-center text-xs text-secondary hover:text-body">
        ← Back to {SITE_NAME}
      </Link>
      </div>
    </div>
  );
}
