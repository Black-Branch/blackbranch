"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { useStripe, useBillingAvailability } from "@/app/lib/useStripe";
import StripeUnavailable from "./StripeUnavailable";
import { GIFT_MONTHS, MAX_COMMUNITY, giftAmountMinor } from "@/app/lib/giftPricing";
import { formatPrice } from "@/app/lib/moneyFormat";
import { postJson, getJson, HttpError } from "@/app/lib/http";
import { LoadingState } from "./Spinner";
import {
  TipForm, type TipDraft, checkoutRequestFor,
  PayPalSubscribeButton, recordLine, isLiveRecord, elsewhereWarning, type SubscriptionRecordView,
} from "@/app/features/support";
import { pointsForCents } from "@/app/lib/coins";
import { currencyOnItsWay } from "@/app/lib/currency";
import { subscriptionStatusLine, giftPurchaseLine, giftReceivedLine, type GiftPurchaseView, type GiftReceivedView } from "@/app/lib/supportStatus";
import type { SubscriptionView } from "@/app/lib/supportStatus";
import { usePaymentResult } from "@/app/lib/usePaymentResult";

// The whole "Support" experience in one client component: subscription state +
// one-time donations, with Stripe Embedded Checkout rendered inline (no redirect,
// no popup). Hosted by SupportModal (the profile card's supporter row).
//
// Money is never granted by this UI — the webhook is the source of truth. On
// `onComplete` we just show a thank-you; the badge/tier/ledger land via webhook.

// What subscriptionStatusLine reads — the /api/me fields it needs (the copy
// module's input type) — plus every subscription record the viewer holds, one
// per service (subscription sources): the PayPal lines and their Cancel.
type Me = SubscriptionView & { subscriptions: SubscriptionRecordView[] };

// The PayPal subscribe offer (GET /api/billing/paypal/subscription): shown only
// with the PayPal module on, a plan for the tier, and that plan priced at PayPal.
type PaypalSubOffer = { offered: boolean; price: { amount: number; currency: string } | null };

// How long "Confirming with PayPal…" watches /api/me for the webhook's record.
const CONFIRM_MS = 30_000;
const CONFIRM_EVERY_MS = 2_000;

// The gifter's ledger: what the viewer has given and
// received. Loaded with the gift section; null until it answers.
type Ledger = { given: GiftPurchaseView[]; received: GiftReceivedView[] };

// Status-line colour by tone. `ending` is the one that must stand out — it is
// the "renewal is off" / "payment due" case the panel used to get wrong.
const TONE_CLASS = {
  renews: "text-muted",
  ending: "text-amber-300",
  gift: "text-violet-300",
  ended: "text-muted",
} as const;

type Mode = "subscription" | "donation" | "gift";

const ALL_SECTIONS: Mode[] = ["subscription", "donation", "gift"];

export default function SupportContent({
  onClose,
  initialGiftRecipient = null,
  sections,
  signedIn,
}: {
  onClose?: () => void;
  initialGiftRecipient?: string | null;
  /** Which sections to show in the home view. Omitted/empty = all three.
   *  Lets a scoped entry point (the Donate / Subscribe / Gift buttons) open
   *  straight to the relevant part while the menu's "Support" shows everything. */
  sections?: Mode[] | null;
  /** Threaded straight to the donation section's TipForm (its own `signedIn`
   *  prop docs say why it's required) and gates this component's own done
   *  view "N Qorm is on its way" line. Required for the same reason: this
   *  component has exactly two hosts — AccountCard (always a signed-in
   *  matrixId) and StreamView's GuestSupportContent (always signed out) —
   *  and a default here would let either one silently forget which it is. */
  signedIn: boolean;
}) {
  // Either provider opens the panel (k, 2026-10-19). Subscriptions and gifts are
  // Stripe checkouts, so with Stripe off they give way to one plain line; the tip
  // form stays, with PayPal/Venmo as its pay button.
  const { stripe: stripeOn, paypalClientId, supporter } = useBillingAvailability();
  // Subscriptions and gifts need a usable Supporter price at Stripe (R1.10): without one they are
  // not offered at all — never a button that answers "not set up".
  const subsOn = stripeOn && supporter !== null;
  const configured = stripeOn || paypalClientId !== null;
  // Observed, not handed straight to EmbeddedCheckoutProvider — see useStripe.ts:
  // a failed script load would otherwise render a silent empty box.
  const { stripe, status: stripeStatus, retry: retryStripe } = useStripe();

  // Normalize the requested sections to a stable, de-duped, ordered list.
  const shown = useMemo<Mode[]>(() => {
    const want = sections && sections.length ? sections : ALL_SECTIONS;
    return ALL_SECTIONS.filter((s) => want.includes(s));
  }, [sections]);
  // PayPal subscriptions (S3): asked of the server only when PayPal is on at all.
  const [paypalSub, setPaypalSub] = useState<PaypalSubOffer | null>(null);
  useEffect(() => {
    if (!paypalClientId || !shown.includes("subscription")) return;
    let alive = true;
    getJson<Partial<PaypalSubOffer>>("/api/billing/paypal/subscription", { cache: "no-store" })
      .then((d) => { if (alive) setPaypalSub({ offered: d.offered === true, price: d.price ?? null }); })
      .catch(() => { /* not offered */ });
    return () => { alive = false; };
  }, [paypalClientId, shown]);
  const paypalSubOn = Boolean(paypalClientId && paypalSub?.offered && paypalSub.price);
  // A subscription is offered by a card (Stripe) or by PayPal; gifts are Stripe checkouts only.
  const subscribeOn = subsOn || paypalSubOn;
  const show = (s: Mode) => shown.includes(s) && (s === "donation" || (s === "subscription" ? subscribeOn : subsOn));
  // Asked for (the whole panel, or a Subscribe/Gift entry point) but not offered here.
  const subsMissing = shown.includes("subscription") && !subscribeOn;
  const giftsMissing = shown.includes("gift") && !subsOn;
  const stripeOnlyAsked = subsMissing || giftsMissing;

  const [me, setMe] = useState<Me | null>(null);
  const [loadingMe, setLoadingMe] = useState(true);

  const [view, setView] = useState<"home" | "checkout" | "confirming" | "done">("home");
  // PayPal approved, but its webhook had not made the record by the time we stopped watching.
  const [confirmLate, setConfirmLate] = useState(false);
  // The viewer read "you'd be paying twice" and chose to subscribe anyway.
  const [elsewhereAck, setElsewhereAck] = useState(false);
  const [elsewhereDismissed, setElsewhereDismissed] = useState(false);
  // A Supporter elsewhere that the SERVER reported (a page older than the record).
  const [serverElsewhere, setServerElsewhere] = useState<{ provider: string; periodEnd: string | null } | null>(null);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(shown[0] ?? "subscription");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const declined = usePaymentResult(sessionId, view === "checkout");
  // What was last submitted from the donation section's TipForm, remembered
  // so "← Back" (this component's checkout view is an early return, which
  // unmounts TipForm same as DonateClient's) hands it back as initialDraft
  // instead of losing it. Never cleared afterwards.
  const [donationDraft, setDonationDraft] = useState<TipDraft | null>(null);

  // Gift inputs.
  const [giftType, setGiftType] = useState<"direct" | "community">("direct");
  const [giftMonths, setGiftMonths] = useState<number>(1);
  const [recipient, setRecipient] = useState("");
  const [recipientInfo, setRecipientInfo] = useState<{ displayName: string | null } | null>(null);
  const [recipientErr, setRecipientErr] = useState<string | null>(null);
  const [giftCount, setGiftCount] = useState(5);
  const [giftAnon, setGiftAnon] = useState(false);
  const giftUnits = giftType === "direct" ? 1 : giftCount;
  // What the gift button says it charges — the same sum the gift route charges (giftAmountMinor).
  const giftTotal = supporter ? formatPrice(giftAmountMinor(supporter.amount, giftMonths, giftUnits), supporter.currency) : "";
  const monthlyPrice = supporter ? formatPrice(supporter.amount, supporter.currency) : "";

  // Validate a typed recipient against /resolve so the gifter gets feedback.
  async function checkRecipient(value?: string) {
    const u = (value ?? recipient).trim();
    setRecipientInfo(null);
    setRecipientErr(null);
    if (!u) return;
    try {
      const d = await getJson<{ displayName: string | null }>(
        `/api/billing/gift/resolve?u=${encodeURIComponent(u)}`
      );
      setRecipientInfo({ displayName: d.displayName });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      if (status === 404) setRecipientErr("No user with that name.");
      else if (status === 400) setRecipientErr("You can’t gift yourself.");
      else if (status === 401) setRecipientErr("Sign in to gift.");
      else setRecipientErr("Couldn’t check that name.");
    }
  }

  // Username autocomplete for the direct-gift recipient. Debounced prefix search
  // against /suggest; Tab/Enter/click fills the field.
  const [suggests, setSuggests] = useState<{ username: string; displayName: string | null }[]>([]);
  const [suggestSel, setSuggestSel] = useState(0);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickSuggest = useCallback((u: string) => {
    setRecipient(u);
    setSuggests([]);
    setSuggestOpen(false);
    void checkRecipient(u);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- checkRecipient is a plain function, re-created every render, so listing it would defeat this memo entirely. It DOES capture the `recipient` state (`value ?? recipient`), but every call on this path passes the value explicitly, so the stale capture is never the one that gets read.
  }, []);
  function onRecipientChange(value: string) {
    setRecipient(value);
    setRecipientInfo(null);
    setRecipientErr(null);
    setSuggestSel(0);
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    const q = value.trim();
    if (q.length < 1) { setSuggests([]); setSuggestOpen(false); return; }
    suggestTimer.current = setTimeout(async () => {
      try {
        const d = await getJson<{ users: { username: string; displayName: string | null }[] }>(
          `/api/billing/gift/suggest?q=${encodeURIComponent(q)}`
        );
        setSuggests(d.users ?? []);
        setSuggestOpen(true);
      } catch { setSuggests([]); }
    }, 160);
  }

  const refreshMe = useCallback(async () => {
    try {
      const d = await getJson<Partial<Me>>("/api/me", { cache: "no-store" });
      setMe({
        tier: d.tier ?? null,
        subStatus: d.subStatus ?? null,
        subRenewsAt: d.subRenewsAt ?? null,
        subCancelAtPeriodEnd: d.subCancelAtPeriodEnd ?? false,
        giftActive: d.giftActive ?? false,
        giftExpiresAt: d.giftExpiresAt ?? null,
        giftFrom: d.giftFrom ?? null,
        subscriptions: Array.isArray(d.subscriptions) ? d.subscriptions : [],
      });
      return d;
    } catch {
      /* leave me as-is */
    } finally {
      setLoadingMe(false);
    }
  }, []);

  // Microtask defer keeps refreshMe()'s sync setState out of the effect pass.
  useEffect(() => {
    Promise.resolve().then(refreshMe);
  }, [refreshMe]);

  // The gifter's ledger — only when the gift section is on screen (a guest's
  // Donate window never asks; the route is auth-gated and would 401).
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const refreshLedger = useCallback(async () => {
    try {
      const d = await getJson<{ given?: GiftPurchaseView[]; received?: GiftReceivedView[] }>("/api/billing/gifts", { cache: "no-store" });
      setLedger({ given: d.given ?? [], received: d.received ?? [] });
    } catch {
      /* leave the ledger as-is — the form above it still works */
    }
  }, []);
  const giftShown = show("gift");
  useEffect(() => {
    if (!giftShown) return;
    Promise.resolve().then(refreshLedger);
  }, [giftShown, refreshLedger]);

  // Pre-target a gift recipient (e.g. opened from a user's "Gift" button).
  useEffect(() => {
    if (!initialGiftRecipient) return;
    Promise.resolve().then(() => {
      setGiftType("direct");
      setRecipient(initialGiftRecipient);
      checkRecipient(initialGiftRecipient);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pre-target fires once per incoming recipient. checkRecipient is re-created every render, so listing it would re-run this (and its /resolve fetch) on every render; the recipient is passed explicitly here, so the stale capture is never read
  }, [initialGiftRecipient]);

  const subActive = me?.tier != null;
  // One sentence about where the viewer stands: renews / renewal off / via a
  // gift / ended — or nothing (supportStatus.test.ts pins the wording).
  const status = me ? subscriptionStatusLine(me) : null;
  // Subscription sources: every live record, and the PayPal ones this panel manages.
  const liveRecords = (me?.subscriptions ?? []).filter((r) => isLiveRecord(r));
  const paypalRecords = liveRecords.filter((r) => r.provider === "paypal");
  const subscribedHere = subActive || paypalRecords.length > 0;
  // Not subscribed by card or PayPal, yet a Supporter through another service: warn before any payment.
  const entitlingElsewhere = liveRecords.find((r) => r.status === "active" || r.status === "past_due") ?? null;
  const elsewhere = serverElsewhere ?? (entitlingElsewhere ? { provider: entitlingElsewhere.provider, periodEnd: entitlingElsewhere.periodEnd } : null);
  const warnElsewhere = Boolean(elsewhere) && !elsewhereAck;

  // After PayPal's approval: watch /api/me until the webhook's record shows (display only — the
  // webhook is what makes the viewer a Supporter), for up to CONFIRM_MS.
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);
  function confirmPaypal() {
    setMode("subscription");
    setView("confirming");
    setConfirmLate(false);
    const until = Date.now() + CONFIRM_MS;
    const tick = async () => {
      const d = await refreshMe();
      const done = (d?.subscriptions ?? []).some((r) => r.provider === "paypal" && (r.status === "active" || r.status === "past_due"));
      if (done || Date.now() >= until) {
        setConfirmLate(!done);
        setView("done");
        return;
      }
      confirmTimer.current = setTimeout(() => void tick(), CONFIRM_EVERY_MS);
    };
    confirmTimer.current = setTimeout(() => void tick(), CONFIRM_EVERY_MS);
  }

  // The on-site Cancel (PayPal's merchant cancel). Writes nothing here: PayPal's CANCELLED webhook
  // updates the record, and access runs to the end of the period already paid for.
  async function cancelPaypal() {
    setBusy(true);
    setErr(null);
    try {
      const res = await postJson("/api/billing/paypal/subscription/cancel");
      if (!res.ok) {
        setErr(res.status === 429 ? "Too many attempts — try again in a minute." : "Couldn’t reach PayPal. Try again.");
        return;
      }
      setCancelNote("Cancelled. PayPal confirms it in a moment; you stay a Supporter until the end of the month you paid for.");
      confirmTimer.current = setTimeout(() => void refreshMe(), 4_000);
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Create a Checkout Session on our server and mount Embedded Checkout with the
  // returned client secret. Errors are handled here so the iframe only mounts on
  // a good secret.
  async function mountCheckout(next: Mode, endpoint: string, body: object) {
    setBusy(true);
    setErr(null);
    try {
      const res = await postJson(endpoint, body);
      if (res.status === 409) {
        // The server says the viewer is already a Supporter elsewhere (a page older than the
        // record): bring the paying-twice warning back rather than an error line.
        const c = (await res.json().catch(() => null)) as { error?: string; provider?: string; periodEnd?: string | null } | null;
        if (c?.error === "subscribed_elsewhere" && c.provider) {
          setServerElsewhere({ provider: c.provider, periodEnd: c.periodEnd ?? null });
          setElsewhereAck(false);
          return;
        }
        setErr("You already have a subscription here — manage it below.");
        return;
      }
      if (!res.ok) {
        // A 400 here is a rejection the route wrote FOR the person reading it
        // (e.g. donate's "A $25.00 donation carries a message of up to 500
        // characters.") — it names the actual limit, which a canned line
        // below cannot. Every other status keeps its generic copy.
        setErr(
          res.status === 400
            ? (await res.text()) || "Something went wrong. Try again."
            : res.status === 503
              ? "Billing isn’t set up yet."
              : res.status === 404
                ? "No user with that name."
                : res.status === 401
                  ? "Sign in to do that."
                  : res.status === 429
                    ? "Too many attempts — try again in a few minutes."
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
      setMode(next);
      setView("checkout");
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function startSubscriptionCheckout() {
    return mountCheckout("subscription", "/api/billing/checkout", { tier: "supporter", alsoElsewhere: elsewhereAck });
  }

  function startGift() {
    if (giftType === "direct") {
      if (!recipient.trim()) {
        setErr("Enter a username to gift to.");
        return;
      }
      return mountCheckout("gift", "/api/billing/gift", {
        type: "direct",
        recipient: recipient.trim(),
        months: giftMonths,
        anonymous: giftAnon,
      });
    }
    if (giftCount < 1 || giftCount > MAX_COMMUNITY) {
      setErr(`Pick 1–${MAX_COMMUNITY} recipients.`);
      return;
    }
    return mountCheckout("gift", "/api/billing/gift", {
      type: "community",
      count: giftCount,
      months: giftMonths,
      anonymous: giftAnon,
    });
  }

  const options = useMemo(
    () => ({
      clientSecret: clientSecret ?? undefined,
      onComplete: () => {
        setView("done");
        if (mode === "subscription") refreshMe();
        if (mode === "gift") refreshLedger();
      },
    }),
    [clientSecret, mode, refreshMe, refreshLedger]
  );

  function backToHome() {
    setView("home");
    setClientSecret(null);
    setSessionId(null);
    setErr(null);
  }

  async function manage() {
    setBusy(true);
    setErr(null);
    try {
      const res = await postJson("/api/billing/portal");
      if (!res.ok) {
        setErr("Couldn’t open the billing portal.");
        return;
      }
      const { url } = (await res.json()) as { url?: string };
      if (url) window.open(url, "_blank", "noopener"); // new tab keeps the stream open
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // ── Checkout view: embedded Stripe iframe ──────────────────────────────────
  if (view === "checkout" && clientSecret) {
    return (
      <div className="flex flex-col gap-3">
        <button onClick={backToHome} className="self-start text-xs text-secondary hover:text-body">
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

  // ── Confirming view: PayPal approved; its webhook has not landed yet ───────
  if (view === "confirming") {
    return <LoadingState className="py-8" label="Confirming with PayPal…" />;
  }

  // ── Done view ──────────────────────────────────────────────────────────────
  if (view === "done") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <span className="text-3xl">{mode === "subscription" ? "★" : mode === "gift" ? "🎁" : "♥"}</span>
        <p className="text-sm text-body">
          {/* Branch on giftType: "right away" is only true
              for a DIRECT gift. Community gifts park in gift_pending and are
              claimed on sign-in/up, for up to 90 days — telling the gifter
              everyone "gets Supporter right away" sets up a "my gift didn't
              work" report the first time they check. */}
          {mode === "subscription"
            ? confirmLate
              ? "PayPal approved it — thank you! You become a Supporter as soon as PayPal confirms the first payment."
              : "You’re a Supporter now — thank you! Your badge will appear shortly."
            : mode === "gift"
              ? giftType === "direct"
                ? "Gift sent — thank you! The recipient gets Supporter right away."
                : "Gifts sent — thank you! Community members claim them when they sign in (they stay claimable for 90 days)."
              : donationDraft && !donationDraft.announce
                ? "Purchase complete — thank you!"
                : "Thank you for the support! ♥"}
        </p>
        {/* Donation only, and only signed in — Qorm crediting needs a
            matrix_id, and subscriptions/gifts don't pay Qorm (D1 is tips
            only). "On its way" (not "landed"): the webhook credits it,
            usually within seconds, but this view never claims it already
            has. */}
        {mode === "donation" && signedIn && donationDraft && (
          <p className="text-xs text-secondary">
            {currencyOnItsWay(pointsForCents(Math.round(donationDraft.amount * 100)))}
          </p>
        )}
        <button
          onClick={onClose ?? backToHome}
          className="rounded-lg bg-raised px-4 py-2 text-sm font-medium text-heading hover:bg-control transition-colors"
        >
          {onClose ? "Close" : "Done"}
        </button>
      </div>
    );
  }

  // After the checkout and done views, on purpose: a switch read while a payment
  // is open must not pull the box out from under it.
  if (!configured) {
    return <p className="text-sm text-amber-400/80">Billing isn’t configured on the server yet.</p>;
  }

  // ── Home view: subscription + donation ──────────────────────────────────────
  return (
    <div className="flex flex-col gap-5">
      {/* Subscription */}
      {show("subscription") && (
      <section className="rounded-xl border border-raised bg-panel/60 p-4">
        <div className="flex items-center gap-2">
          <span className="text-amber-400">★</span>
          <h3 className="text-sm font-semibold text-heading">Supporter</h3>
          {subscribedHere && (
            <span className="ml-auto rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300">
              {me?.subStatus === "past_due" || paypalRecords.some((r) => r.status === "past_due") ? "Payment due" : "Active"}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-secondary">
          Support the stream for <span className="text-body">{monthlyPrice || (paypalSub?.price ? formatPrice(paypalSub.price.amount, paypalSub.price.currency) : "")}/month</span> — a Supporter badge in chat
          and a faster chat rate limit.
        </p>
        {loadingMe ? (
          <LoadingState className="mt-3" />
        ) : subscribedHere ? (
          <div className="mt-3">
            {subActive && status && <p className={`text-xs ${TONE_CLASS[status.tone]}`}>{status.text}</p>}
            {/* One line per PayPal subscription, with the on-site Cancel (spec §10.2). */}
            {paypalRecords.map((r, i) => {
              const line = recordLine(r);
              if (!line) return null;
              return (
                <div key={`paypal-${i}`} className="mt-1 flex flex-wrap items-center gap-2">
                  <p className={`text-xs ${line.ending ? TONE_CLASS.ending : TONE_CLASS.renews}`}>
                    <span className="text-body">{line.service}</span> · {line.text}
                  </p>
                  {r.renews && r.status !== "pending" && !cancelNote && (
                    <button
                      onClick={cancelPaypal}
                      disabled={busy}
                      className="rounded-lg bg-raised px-3 py-1 text-xs font-medium text-heading hover:bg-control disabled:opacity-50 transition-colors"
                    >
                      {busy ? "Cancelling…" : "Cancel"}
                    </button>
                  )}
                </div>
              );
            })}
            {cancelNote && <p className="mt-1 text-xs text-secondary">{cancelNote}</p>}
            {subActive && (
              <button
                onClick={manage}
                disabled={busy}
                className="mt-2 rounded-lg bg-raised px-4 py-2 text-sm font-medium text-heading hover:bg-control disabled:opacity-50 transition-colors"
              >
                {busy ? "Opening…" : "Manage subscription"}
              </button>
            )}
          </div>
        ) : (
          <div className="mt-3">
            {status && (
              <p className={`mb-2 text-xs ${TONE_CLASS[status.tone]}`}>
                {status.tone === "gift" ? "🎁 " : ""}{status.text}
              </p>
            )}
            {warnElsewhere && elsewhere ? (
              // Before any payment: a Supporter through another service would pay twice (§10.1, D24).
              elsewhereDismissed ? null : (
                <div className="flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                  <p className="text-xs text-body">{elsewhereWarning(elsewhere)}</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => { setElsewhereAck(true); setServerElsewhere(null); }}
                      className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium text-heading hover:bg-control transition-colors"
                    >
                      Subscribe anyway
                    </button>
                    <button
                      onClick={() => { if (onClose) onClose(); else setElsewhereDismissed(true); }}
                      className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-amber-400 transition-colors"
                    >
                      Keep what I have
                    </button>
                  </div>
                </div>
              )
            ) : (
              <div className="flex flex-col items-start gap-2">
                {subsOn && (
                  <button
                    onClick={startSubscriptionCheckout}
                    disabled={busy}
                    className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-amber-400 disabled:opacity-50 transition-colors"
                  >
                    {busy ? "Starting…" : "Become a Supporter"}
                  </button>
                )}
                {paypalSubOn && paypalClientId && paypalSub?.price && signedIn && (
                  <div className="w-full max-w-xs">
                    <PayPalSubscribeButton
                      clientId={paypalClientId}
                      currency={paypalSub.price.currency}
                      alsoElsewhere={elsewhereAck}
                      onApproved={confirmPaypal}
                      onElsewhere={(e) => { setServerElsewhere(e); setElsewhereAck(false); }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {/* Donation */}
      {show("donation") && (
      <section className="rounded-xl border border-raised bg-panel/60 p-4">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400">♥</span>
          <h3 className="text-sm font-semibold text-heading">One-time tip</h3>
        </div>
        <p className="mt-2 text-sm text-secondary">Chip in a one-off tip to support the stream.</p>
        <TipForm
          busy={busy}
          signedIn={signedIn}
          initialDraft={donationDraft ?? undefined}
          onAmountChange={() => setErr(null)}
          onSubmit={(d) => {
            setDonationDraft(d);
            const { endpoint, body } = checkoutRequestFor(d);
            return mountCheckout("donation", endpoint, body);
          }}
          paypalClientId={paypalClientId}
          cardAvailable={stripeOn}
          onPaypalCaptured={(d) => {
            setDonationDraft(d);
            setMode("donation");
            setView("done");
          }}
        />
      </section>
      )}

      {/* Gift */}
      {show("gift") && (
      <section className="rounded-xl border border-raised bg-panel/60 p-4">
        <div className="flex items-center gap-2">
          <span className="text-violet-400">🎁</span>
          <h3 className="text-sm font-semibold text-heading">Gift Supporter</h3>
        </div>
        <p className="mt-2 text-sm text-secondary">
          Give Supporter to someone else — one-time, no auto-renew.
        </p>

        {/* Direct vs community */}
        <div className="mt-3 inline-flex rounded-lg bg-raised p-0.5 text-xs font-medium">
          {(["direct", "community"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setGiftType(t);
                setErr(null);
              }}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                giftType === t ? "bg-violet-500 text-on-accent" : "text-body-dim hover:text-strong"
              }`}
            >
              {t === "direct" ? "To a user" : "Community"}
            </button>
          ))}
        </div>

        {giftType === "direct" ? (
          <div className="mt-3 relative">
            <input
              value={recipient}
              onChange={(e) => onRecipientChange(e.target.value)}
              onKeyDown={(e) => {
                if (!suggestOpen || suggests.length === 0) return;
                if (e.key === "ArrowDown") { e.preventDefault(); setSuggestSel((i) => (i + 1) % suggests.length); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setSuggestSel((i) => (i - 1 + suggests.length) % suggests.length); }
                else if (e.key === "Tab" || e.key === "Enter") {
                  const pick = suggests[suggestSel];
                  if (pick) { e.preventDefault(); pickSuggest(pick.username); }
                } else if (e.key === "Escape") { setSuggestOpen(false); }
              }}
              onBlur={() => { setTimeout(() => setSuggestOpen(false), 120); checkRecipient(); }}
              placeholder="username — type to search"
              aria-label="Gift recipient username"
              autoComplete="off"
              className="w-full rounded-lg border border-control bg-canvas px-3 py-2 text-sm text-heading outline-none focus:border-violet-500"
            />
            {suggestOpen && suggests.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-control bg-panel shadow-xl">
                {suggests.map((s, i) => (
                  <button
                    key={s.username}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); pickSuggest(s.username); }}
                    onMouseEnter={() => setSuggestSel(i)}
                    className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      i === suggestSel ? "bg-violet-500/20 text-strong" : "text-body-dim hover:bg-surface-2"
                    }`}
                  >
                    <span className="font-medium">{s.username}</span>
                    {s.displayName && s.displayName !== s.username && (
                      <span className="truncate text-xs text-muted">{s.displayName}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {recipientInfo && (
              <p className="mt-1 text-xs text-violet-300">
                Gifting {recipientInfo.displayName || recipient.trim()} ✓
              </p>
            )}
            {recipientErr && <p role="alert" className="mt-1 text-xs text-red-400">{recipientErr}</p>}
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <label className="text-sm text-secondary">How many random viewers?</label>
            <input
              type="number"
              min={1}
              max={MAX_COMMUNITY}
              value={giftCount}
              onChange={(e) => {
                setGiftCount(Math.trunc(Number(e.target.value)) || 0);
                setErr(null);
              }}
              className="w-20 rounded-lg border border-control bg-canvas px-3 py-2 text-sm text-heading outline-none focus:border-violet-500"
            />
          </div>
        )}

        {/* Months */}
        <div className="mt-3 flex flex-wrap gap-2">
          {GIFT_MONTHS.map((m) => (
            <button
              key={m}
              onClick={() => {
                setGiftMonths(m);
                setErr(null);
              }}
              className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                giftMonths === m ? "bg-violet-500 text-on-accent" : "bg-raised text-body hover:bg-control"
              }`}
            >
              {m} mo
            </button>
          ))}
        </div>

        <label className="mt-3 flex items-center gap-2 text-xs text-secondary select-none cursor-pointer">
          <input
            type="checkbox"
            checked={giftAnon}
            onChange={(e) => setGiftAnon(e.target.checked)}
            className="accent-violet-500"
          />
          Gift anonymously
        </label>

        <button
          onClick={startGift}
          disabled={busy || (giftType === "direct" ? !recipient.trim() : giftCount < 1)}
          className="mt-3 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-violet-400 disabled:opacity-50 transition-colors"
        >
          {busy ? "Starting…" : `Gift ${giftTotal}`}
        </button>

        {/* The ledger: what this viewer has given, one row per purchase,
            newest first (server order). A community gift shows how many
            slots were claimed and how many still wait for a new member.
            Rendered only when there is something to show. */}
        {ledger && ledger.given.length > 0 && (
          <div className="mt-4 border-t border-raised pt-3">
            <h4 className="text-xs font-semibold text-heading">Gifts you’ve given</h4>
            <ul className="mt-1.5 flex flex-col gap-1">
              {ledger.given.map((p) => (
                <li key={p.sessionId} className="flex items-baseline gap-2 text-xs">
                  <span className="shrink-0 tabular-nums text-muted">
                    {new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                  <span className="text-secondary">
                    {giftPurchaseLine(p)}
                    {p.anonymous ? " · anonymous" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {ledger && ledger.received.length > 0 && (
          <div className="mt-4 border-t border-raised pt-3">
            <h4 className="text-xs font-semibold text-heading">Gifts you’ve received</h4>
            <ul className="mt-1.5 flex flex-col gap-1">
              {ledger.received.map((r, i) => (
                <li key={`${r.expiresAt}-${i}`} className="text-xs text-secondary">
                  {giftReceivedLine(r)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      )}

      {/* One line, not empty sections: a Subscribe or Gift entry point must not
          open to a blank panel on a PayPal-only site. */}
      {stripeOnlyAsked && (
        <p className="text-xs text-secondary">
          {subsMissing && giftsMissing
            ? "Subscriptions and gifts aren’t available on this site."
            : subsMissing
              ? "Subscriptions aren’t available on this site."
              : "Gifts aren’t available on this site."}
        </p>
      )}

      {err && <p role="alert" className="text-xs text-red-400">{err}</p>}

      <p className="mt-1 text-center text-2xs text-muted">
        {stripeOn && paypalClientId
          ? "Payments are processed by Stripe, or by PayPal for PayPal and Venmo."
          : stripeOn
            ? "Payments are processed by Stripe."
            : "Payments are processed by PayPal, for PayPal and Venmo."}{" "}
        By continuing you agree to our{" "}
        <a href="/legal#terms" className="underline hover:text-secondary">Terms</a>,{" "}
        <a href="/legal#privacy" className="underline hover:text-secondary">Privacy Policy</a>{" "}
        and{" "}
        <a href="/legal#refunds" className="underline hover:text-secondary">Refund Policy</a>.
      </p>
    </div>
  );
}
