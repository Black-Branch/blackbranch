"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { useStripe, useBillingAvailability } from "@/app/lib/useStripe";
import StripeUnavailable from "@/app/components/StripeUnavailable";
import { Sections } from "@/app/components/chrome";
import PointsIcon from "@/app/components/PointsIcon";
import {
  formatCoinsShort, earnedParenthetical,
  type LedgerKind, type SpendSink, ledgerKindLabel,
} from "@/app/lib/coins";
import { useCoinBalance, useEarnedBalance, refreshCoinBalance } from "@/app/lib/useCoinBalance";
import StoreSpend from "./StoreSpend";
import { LoadingState } from "@/app/components/Spinner";
import { usePaymentResult } from "@/app/lib/usePaymentResult";
import { TipForm, checkoutRequestFor, type TipDraft } from "@/app/features/support";
import { currencyName } from "@/app/lib/currency";
import { useStorePrices } from "@/app/lib/useStorePrices";

// The coin store: top-up (card via embedded Stripe checkout, or PayPal/Venmo
// via the shared TipForm's split button) + the user's own ledger. Money is
// never granted by this UI — the webhook credits the wallet in both cases;
// onComplete/onPaypalCaptured just polls the balance until it moves.
//
// Qorm-for-all-income piece 3 (task 4): the Store renders the SAME TipForm
// that /donate and the Support panel do, with "Announce on stream" starting
// OFF (a quiet Qorm purchase — the store's original purpose). Flipping it on
// turns the same box into a real tip. One form, one checkout path
// (checkoutRequestFor), instead of the Store's own amount box and pay button.
//
// Transparency is the product stance here: the 1:1 peg is stated where the
// amount is entered, and the history tab exposes every ledger row. No bundles,
// no markup, no obscured rate.

type LedgerRowWire = {
  id: number;
  delta: number;
  kind: LedgerKind;
  sink: SpendSink | null;
  createdAt: string;
};

const GOLD = "#eab308";

/** The store is ONE page — history is the only thing behind a tab. */
type Tab = "store" | "history";

const STORE_TABS = [
  { key: "store", label: "Store" },
  { key: "history", label: "History" },
] as const satisfies readonly { key: Tab; label: string }[];

/** Callers still speak the old three-tab vocabulary; "topup" additionally means
 *  "put the buy box in front of them", which is now a scroll rather than a tab. */
type EntryTab = "topup" | "spend" | "history";

export default function StoreContent({
  initialTab = "topup",
  onClose,
}: {
  initialTab?: EntryTab;
  onClose?: () => void;
}) {
  // Either provider opens the Store (k, 2026-10-19): with Stripe off, PayPal's
  // own button buys the points (a quiet PayPal points order, paypalPointsOrder.ts).
  // The Store sells no subscriptions or gifts, so nothing else changes here.
  const { stripe: stripeOn, paypalClientId } = useBillingAvailability();
  const configured = stripeOn || paypalClientId !== null;
  // Observed, not handed straight to EmbeddedCheckoutProvider — see useStripe.ts:
  // a failed script load would otherwise render a silent empty box.
  const { stripe, status: stripeStatus, retry: retryStripe } = useStripe();
  const balance = useCoinBalance(true);
  // The header shows the total balance and the earned part, "200q (100q)". The
  // number is /api/points/balance's `earned`, one fold over the ledger shared
  // with the profile card rather than a second one here.
  const earned = useEarnedBalance(true);

  const [tab, setTab] = useState<Tab>(initialTab === "history" ? "history" : "store");
  const { purchasable } = useStorePrices();
  // Entering with "topup" used to select a tab; now it scrolls the buy box into
  // view. Every caller keeps working (StreamMetaBar's Qorm pill, CheerChip's
  // "Top up" when short, ProfileEditor's two style links, TradeTicket) without
  // knowing the tabs changed — the event contract is the compatibility surface,
  // not the internal shape.
  const topupRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (initialTab !== "topup") return;
    topupRef.current?.scrollIntoView({ block: "nearest" });
  }, [initialTab]);
  const [view, setView] = useState<"home" | "checkout" | "done">("home");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const declined = usePaymentResult(sessionId, view === "checkout");
  // TipForm owns the whole draft — amount, message, name, anonymity and the
  // Announce switch. Remembered across a decline-and-retry (the same reason
  // /donate and the Support panel keep it) and across a "← Back" from
  // checkout, so TipForm remounts with exactly what was there before.
  const [draft, setDraft] = useState<TipDraft | null>(null);

  // History rows, fetched lazily when the tab first opens.
  const [rows, setRows] = useState<LedgerRowWire[] | null>(null);
  const [histErr, setHistErr] = useState(false);
  useEffect(() => {
    if (tab !== "history" || rows !== null) return;
    fetch("/api/points/history")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { rows: LedgerRowWire[] }) => setRows(d.rows))
      .catch(() => setHistErr(true));
  }, [tab, rows]);

  async function startCheckout(next: TipDraft) {
    setDraft(next);
    setBusy(true);
    setErr(null);
    try {
      const { endpoint, body } = checkoutRequestFor(next);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setErr(
          res.status === 400 ? (await res.text()) || "Something went wrong. Try again."
          : res.status === 503 ? "Billing isn’t set up yet."
          : res.status === 401 ? "Sign in to top up."
          : res.status === 429 ? "Too many attempts — try again in a few minutes."
          : "Something went wrong. Try again."
        );
        return;
      }
      const { clientSecret: cs, sessionId: sid } = (await res.json()) as { clientSecret?: string; sessionId?: string };
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

  // The webhook credits the wallet moments after payment — poll the balance a
  // few times so the chip updates while the "done" view is still open.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startBalancePoll = useCallback(() => {
    let ticks = 0;
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(() => {
      refreshCoinBalance();
      if (++ticks >= 6 && pollTimer.current) clearInterval(pollTimer.current);
    }, 2000);
  }, []);
  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const options = useMemo(
    () => ({
      clientSecret: clientSecret ?? undefined,
      onComplete: () => {
        setView("done");
        startBalancePoll();
      },
    }),
    [clientSecret, startBalancePoll]
  );

  if (view === "checkout" && clientSecret) {
    return (
      <div className="flex flex-col gap-3">
        <button
          onClick={() => { setView("home"); setClientSecret(null); setSessionId(null); setErr(null); }}
          className="self-start text-xs text-secondary hover:text-body"
        >
          ← Back
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
    );
  }

  if (view === "done") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <PointsIcon size={30} />
        <p className="text-sm text-body">
          {draft?.announce
            ? `Thank you for the tip! Your ${currencyName()} will appear in your wallet in a few seconds.`
            : `Thank you! Your ${currencyName()} will appear in your wallet in a few seconds.`}
        </p>
        <button
          // No onClose (standalone Store, not a modal): a completed tip is
          // over, so the remembered draft goes with it — otherwise reopening
          // the home view finds `draft` still set and, because a saved draft
          // overrides `initialAnnounce={false}`, the Store would come back
          // announcing with the old message instead of quiet (the spec's
          // starting state). The onClose (modal) path is untouched — that
          // caller unmounts StoreContent entirely, so there is no stale draft
          // to carry into a later remount here.
          onClick={onClose ?? (() => { setView("home"); setRows(null); setDraft(null); })}
          className="mt-1 rounded-md bg-surface-2 px-4 py-1.5 text-sm text-body hover:bg-surface-3 transition-colors"
        >
          Done
        </button>
      </div>
    );
  }

  // After the checkout and done views, on purpose: a switch read while a payment
  // is open must not pull the box out from under it.
  if (!configured) {
    return <p className="text-sm text-amber-400/80">Billing isn’t configured on the server yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Wallet header. The parenthetical is how much of the total was EARNED
          rather than bought — always shown, see earnedParenthetical. */}
      <div className="flex items-baseline justify-between rounded-xl border border-raised bg-panel/60 px-4 py-3">
        <span className="text-sm text-secondary">Your wallet</span>
        <span className="inline-flex items-baseline gap-1.5 text-base font-semibold" style={{ color: GOLD }}>
          <PointsIcon size="1em" className="self-center" />
          {balance === null ? "—" : (
            <span className="tabular-nums">
              {formatCoinsShort(balance)}
              <span className="text-muted font-normal">{earnedParenthetical(earned)}</span>
            </span>
          )}
        </span>
      </div>

      {/* Tabs. Top up and Spend are one page: buying and spending are one
          errand, and making them exclusive would mean checking your balance in
          one place and acting in another. History stays behind a tab: it is a
          different question. */}
      <Sections items={STORE_TABS} value={tab} onChange={setTab} label="Store sections" />

      {/* No top-up box when buying is switched off (`currency.purchasable`) — the
          Store is then spending and history only. */}
      {tab === "store" && purchasable !== false && (
        <section ref={topupRef} className="rounded-xl border border-raised bg-panel/60 p-4">
          <TipForm
            busy={busy}
            // StoreContent only mounts inside AccountCard, which only mounts
            // for a signed-in matrixId.
            signedIn
            initialAnnounce={false}
            initialDraft={draft ?? undefined}
            onAmountChange={() => setErr(null)}
            error={err}
            onSubmit={startCheckout}
            paypalClientId={paypalClientId}
            cardAvailable={stripeOn}
            onPaypalCaptured={(d) => { setDraft(d); setView("done"); startBalancePoll(); }}
          />
        </section>
      )}

      {/* Buying is above spending on the same page, in that order: what you can
          afford is the question every row below answers. */}
      {tab === "store" && <StoreSpend />}

      {tab === "history" && (
        <section className="rounded-xl border border-raised bg-panel/60 p-2 max-h-72 overflow-y-auto">
          {histErr ? (
            <p className="p-2 text-xs text-red-400">Couldn’t load history.</p>
          ) : rows === null ? (
            <LoadingState className="p-2" />
          ) : rows.length === 0 ? (
            <p className="p-2 text-xs text-muted">
              Nothing yet — {purchasable === false ? "earn" : "top up or earn"} {currencyName()} by watching and chatting while the stream is live.
            </p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-edge last:border-0">
                    <td className="px-2 py-1.5 text-body-dim">{ledgerKindLabel(r.kind, r.sink)}</td>
                    <td className="px-2 py-1.5 text-muted whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </td>
                    <td
                      className={`px-2 py-1.5 text-right font-mono whitespace-nowrap ${
                        r.delta >= 0 ? "text-emerald-400" : "text-secondary"
                      }`}
                    >
                      {r.delta >= 0 ? "+" : ""}{r.delta.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
