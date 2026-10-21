"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PayPalButton, usePaypalSdk, venmoEligible } from "./PayPalButton";
import { readLastPayMethod, rememberPayMethod, type PayMethod } from "./payMethod";
import { pointsForCents } from "@/app/lib/coins";
import { currencyName } from "@/app/lib/currency";
import { formatPrice, currencySign } from "@/app/lib/moneyFormat";
import type { TipDraft } from "./types";

// The split "Tip $X [▾]" button, so PayPal is never hidden behind a collapsed
// disclosure and the in-site Support panel offers it too:
//
//   [          Tip $5           ][ ▾ ]      ▾ opens: Card, Apple Pay & more / PayPal / Venmo
//
// The main half does not say "via Card": Stripe's box is not just card — it
// also offers Apple Pay, Google Pay, Link, Cash App and Amazon Pay.
//
// The method is chosen BEFORE pressing, defaulting to the method last used
// (payMethod.ts — remembered per browser). Card is TipForm's plain submit
// button. PayPal/Venmo hand the main half to PayPalButton — PayPal's brand
// rules forbid our own text on their button, so the small line under it is
// the only copy this component adds for those two.
//
// Starts from "card" on EVERY render, including the very first client one —
// never from `readLastPayMethod()` as the initial state. DonateClient's page
// is server-rendered (SupportContent is client-only, but this component is
// shared), and a lazy initializer that reads localStorage would run during
// the FIRST CLIENT render too (hydration), before React has compared it
// against the server-rendered HTML — producing a mismatch (wrong label, wrong
// aria-expanded, wrong selected row) the moment the stored method isn't
// "card". Reading it in an effect after mount is what keeps the first paint
// identical on both sides; the one-render "flip" to a remembered method is a
// normal, accepted cost of that.
export function TipPayButton(props: {
  amount: number;
  busy: boolean;
  /** `props.busy || !validAmount || messageTooLong` from TipForm — passed
   *  down rather than recomputed, so there is exactly one copy of that rule
   *  (donationTts.scan.test.ts pins the literal in TipForm.tsx itself). */
  disabledCard: boolean;
  valid: boolean;
  getDraft: () => TipDraft;
  /** null when PAYPAL_CLIENT_ID isn't configured — no ▾, no PayPal/Venmo row,
   *  the main half reads exactly "Tip $X". */
  paypalClientId: string | null;
  locked: boolean;
  onLockChange: (locked: boolean) => void;
  onCardSubmit: () => void;
  onPaypalCaptured: () => void;
  /** What the button buys — TipForm passes "points" when its own Announce
   *  switch is off; everything else is a tip. Default "tip" keeps every
   *  existing caller unchanged. */
  purpose?: "tip" | "points";
  /** Whether card payments (Stripe) are on. false = no card half and no Card
   *  row: PayPal's own button IS the pay button (an install with PayPal/Venmo
   *  only). Default true keeps every existing caller unchanged. */
  cardAvailable?: boolean;
}) {
  const { amount, busy, disabledCard, valid, getDraft, paypalClientId, locked, onLockChange, onCardSubmit, onPaypalCaptured } = props;
  const cardAvailable = props.cardAvailable ?? true;
  const points = (props.purpose ?? "tip") === "points";
  const pointsCount = valid ? pointsForCents(Math.round(amount * 100)).toLocaleString() : "";
  // The amount in the site's currency (moneyFormat.ts), never a literal "$": "$5", "$4.50", "$—".
  const tipAmount = amount ? formatPrice(Math.round(amount * 100)) : `${currencySign()}—`;
  const cardLabel = points
    ? (busy ? "Starting checkout…" : `Buy ${pointsCount} ${currencyName()}`)
    : (busy ? "Starting…" : `Tip ${tipAmount}`);
  const cardColour = points ? "bg-yellow-500 hover:brightness-110" : "bg-emerald-500 hover:bg-emerald-400";

  const [chosenMethod, setMethod] = useState<PayMethod>("card");
  // With card off, "card" is never a method: the state still starts at "card"
  // (the hydration reason above), and this derivation — not an effect — makes
  // the first paint PayPal's on both sides. Derived on every render, so a card
  // switch flipped while the page is open moves the button with it.
  const method: PayMethod = !cardAvailable && chosenMethod === "card" ? "paypal" : chosenMethod;
  const [sdkEnabled, setSdkEnabled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // True once the person has picked a row from the ▾ themselves — including
  // "Card". A ref, not state: it must be readable synchronously inside the
  // mount-preference effect below without becoming a dependency that effect
  // would have to re-run for.
  const userChoseRef = useRef(false);

  // Early loader (usePaypalSdk's own `enabled` param, PayPalButton.tsx) — lets
  // the ▾ menu know whether Venmo is eligible before PayPal/Venmo is even
  // chosen, and lets a remembered paypal/venmo preference start loading at
  // mount instead of waiting for a click.
  const { status: sdkStatus } = usePaypalSdk(paypalClientId ?? "", sdkEnabled && Boolean(paypalClientId));

  // Apply the remembered method whenever a client id BECOMES available (see
  // file header for why not as the initial state) — keyed on `paypalClientId`
  // itself, not `[]` (fix round 1, review finding 2). SupportContent renders
  // TipForm immediately with `paypalClientId = null` and only fills it in
  // once its own config fetch resolves; a `[]`-keyed effect had already run
  // (and bailed on `!paypalClientId`) by the time that happened, so a
  // returning PayPal/Venmo tipper in the Support panel always started on
  // Card. Guarded by `userChoseRef` so a late-arriving id can never stomp a
  // choice the person already made from the menu in the meantime — that race
  // is real: the config fetch and a fast click can land either order.
  useEffect(() => {
    if (!paypalClientId) return;
    if (userChoseRef.current) return;
    let alive = true;
    // A microtask defer, not a synchronous setState in the effect body —
    // `react-hooks/set-state-in-effect` is a hard error under this config,
    // same idiom as useStripe.ts/SupportContent.tsx: state that's already
    // resolvable at effect-run time (localStorage never needs an async load)
    // still settles outside the effect pass, not inside it.
    Promise.resolve().then(() => {
      if (!alive || userChoseRef.current) return;
      const stored = readLastPayMethod();
      if (stored !== "card") {
        setMethod(stored);
        setSdkEnabled(true);
      }
    });
    return () => { alive = false; };
  }, [paypalClientId]);

  // A remembered "venmo" that turns out ineligible (PayPal reports this only
  // once the SDK is actually loaded) falls back to "paypal" — never leaves
  // the main half showing a button PayPal itself won't render. This applies
  // regardless of `userChoseRef`: an ineligible Venmo can't render correctly
  // no matter how it got selected.
  useEffect(() => {
    if (sdkStatus !== "ready") return;
    if (method !== "venmo") return;
    let alive = true;
    Promise.resolve().then(() => {
      if (alive && !venmoEligible()) setMethod("paypal");
    });
    return () => { alive = false; };
  }, [sdkStatus, method]);

  // Escape and click-outside close the menu.
  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [menuOpen]);

  function openMenu() {
    setSdkEnabled(true); // opening the menu starts loading the SDK
    setMenuOpen(true);
  }

  function choose(m: PayMethod) {
    userChoseRef.current = true; // a late-arriving paypalClientId must not override this
    setMethod(m);
    setMenuOpen(false);
    if (m !== "card") setSdkEnabled(true);
  }

  function submitCard() {
    if (!cardAvailable || locked || disabledCard) return;
    rememberPayMethod("card");
    onCardSubmit();
  }

  // Computed once per sdkStatus transition, not on every render (nit,
  // review): venmoEligible() asks the real SDK to construct a probe
  // paypal.Buttons({fundingSource: VENMO}) instance every time it's called,
  // and this render's value only ever CHANGES when sdkStatus flips.
  const venmoRowEligible = useMemo(() => sdkStatus === "ready" && venmoEligible(), [sdkStatus]);

  return (
    <div className="mt-3">
      <div className="flex">
        {method === "card" ? (
          <button
            type="button"
            onClick={submitCard}
            disabled={disabledCard || locked}
            className={`h-10 flex-1 px-4 text-sm font-semibold text-on-accent ${cardColour} disabled:opacity-50 transition-colors ${
              paypalClientId ? "rounded-l-lg" : "rounded-lg"
            }`}
          >
            {/* No "via Card": Stripe's box also offers Apple Pay, Google Pay,
                Link, Cash App and Amazon Pay, so naming one of them would
                mislead. The menu row says it. */}
            {cardLabel}
          </button>
        ) : (
          <div className="flex-1">
            <PayPalButton
              clientId={paypalClientId ?? ""}
              fundingSource={method}
              valid={valid}
              getDraft={getDraft}
              onLockChange={onLockChange}
              onCaptured={onPaypalCaptured}
              purpose={props.purpose ?? "tip"}
            />
            <p className="mt-1 text-xs text-body-dim">
              {points ? `Buying ${pointsCount} ${currencyName()}` : `Tipping ${tipAmount}`} via {method === "paypal" ? "PayPal" : "Venmo"}
            </p>
          </div>
        )}

        {paypalClientId && (
          <div ref={menuRef} className="relative shrink-0">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Choose how to pay"
              onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
              disabled={locked}
              className={`flex h-10 w-11 items-center justify-center rounded-r-lg border-l border-canvas/20 disabled:opacity-50 ${
                // The ▾ wears the colour of the button beside it,
                // so the pair reads as ONE button whichever method is chosen.
                // No `transition-colors`: PayPal's own button swaps instantly,
                // so a fading ▾ would lag behind it and read as a flicker.
                method === "card"
                  ? `${cardColour} text-on-accent`
                  : method === "paypal"
                    ? "bg-paypal text-on-accent hover:brightness-95"
                    : "bg-venmo text-strong hover:brightness-110"
              }`}
            >
              {/* An inline SVG chevron, not the text glyph "▾" — the glyph
                  reads as too small to notice at a normal reading distance.
                  currentColor tracks both halves' colour schemes
                  (emerald-on-accent for Card, body for PayPal/Venmo). */}
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 7.5L10 12.5L15 7.5" />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                // Opens UPWARD: a downward menu would be clipped inside the
                // Support panel by the panel's own bottom edge. The form's own
                // controls above this button always leave room upward, on both
                // surfaces, so `bottom-full mb-1` is unconditional rather
                // than a viewport-dependent choice.
                className="absolute right-0 bottom-full z-20 mb-1 w-52 overflow-hidden rounded-lg border border-control bg-panel shadow-xl"
              >
                {cardAvailable && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => choose("card")}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-body hover:bg-control"
                  >
                    Card, Apple Pay &amp; more {method === "card" && <span aria-hidden>✓</span>}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => choose("paypal")}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-body hover:bg-control"
                >
                  PayPal {method === "paypal" && <span aria-hidden>✓</span>}
                </button>
                {venmoRowEligible && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => choose("venmo")}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-body hover:bg-control"
                  >
                    Venmo {method === "venmo" && <span aria-hidden>✓</span>}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
