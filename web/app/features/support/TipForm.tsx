"use client";

import { useId, useRef, useState } from "react";
import { useEmotes } from "@/app/lib/useEmotes";
import { useEmoteAutocomplete } from "@/app/lib/useEmoteAutocomplete";
import { EmoteCompletionList } from "@/app/components/EmoteCompletionList";
import { donationTtsChars, donationTtsLine } from "@/app/lib/donationTts";
import { CharCounter } from "@/app/components/CharCounter";
import { pointsForCents, PAY_MIN_CENTS, PAY_MAX_CENTS } from "@/app/lib/coins";
import { currencyName } from "@/app/lib/currency";
import { formatPrice, currencySign } from "@/app/lib/moneyFormat";
import { useStorePrices } from "@/app/lib/useStorePrices";
import { useClientValue } from "@/app/lib/useClientState";
import { Toggle } from "@/app/components/SettingsControls";
import { TipPayButton } from "./TipPayButton";
import type { TipDraft } from "./types";

export type { TipDraft } from "./types";

// The one-time-tip form, shared by every surface that takes a tip
// (SupportContent's donation section and the standalone /donate page), so a
// fix lands everywhere at once instead of drifting into copies.
//
// This component owns the controls: amount, the "Announce on stream" switch,
// message (with emote autocomplete), the anonymous checkbox, and the submit
// button. Announce OFF turns this into a quiet Qorm purchase:
// message/name/anonymous hide (and are never sent), and the submit button
// becomes TipPayButton's gold `purpose="points"` half. The caller owns the
// outer <section>, its heading, and its panel chrome classes, so a page and an
// embedded panel can frame the same controls differently.

// Whole units of the site's currency (moneyFormat.ts SITE_CURRENCY — the one every checkout route
// charges in), written by formatPrice, never with a literal "$".
const PRESETS = [3, 5, 10, 25];

export function TipForm(props: {
  onSubmit: (draft: TipDraft) => void;
  busy: boolean;
  /** Whether the tipper is signed in — drives the Qorm line under the amount
   *  ("You'll also get N Qorm" vs "Sign in to also get N Qorm") and whether
   *  the caller's done view can show its "N Qorm is on its way" line at all
   *  (Qorm crediting needs a matrix_id — coinsServer.ts / the billing
   *  webhook). Required, not defaulted: a host that forgets it should fail to
   *  compile, not silently show the wrong half of this to a real tipper.
   *
   *  Tipping still never REQUIRES an account; the signed-out line is a
   *  one-line nudge, not a wall (see DonateClient). */
  signedIn: boolean;
  /** Prefills the name box; the signed-in user's display name, else "".
   *  Still used when `initialDraft` is absent, and still what decides
   *  whether the "leave blank" hint below the name box can show at all. */
  initialName?: string;
  /** Preselects an amount; ignored unless finite and within bounds. Still
   *  used when `initialDraft` is absent (e.g. a `?amount=` link). */
  initialAmount?: number;
  /** Seeds the WHOLE draft — amount, message, name and anonymity — from what
   *  the person already typed here before the form unmounted. Takes
   *  precedence over `initialName`/`initialAmount` when present.
   *
   *  TipForm unmounts for the entire time a checkout session is open (it
   *  must — see tipFormCheckoutGuard.scan.test.ts), so without this prop a
   *  decline-and-retry would silently reset the whole draft: pick $25, write a
   *  280-character message, the card declines, tap back to retry at $10 →
   *  amount resets, message and name are gone. The caller only has to remember
   *  the `TipDraft` it already receives via `onSubmit` and hand it back here on
   *  remount — nothing here needs to keep syncing, because nothing can change
   *  in an unmounted component. */
  initialDraft?: TipDraft;
  /** Where the Announce switch starts. Default true (a tip): /donate and the
   *  Support panel. The Store passes false. `initialDraft.announce` wins
   *  when present, so a declined card comes back where the person left it.
   *  Ignored when signed out: a guest gets no switch and always tips (a
   *  quiet purchase needs a wallet; /api/billing/points 401s a guest). */
  initialAnnounce?: boolean;
  /** Called when the AMOUNT changes, so the caller can clear a stale error —
   *  a message about the last attempt is not about this one. */
  onAmountChange?: () => void;
  /** External error to show under the button (e.g. a network failure).
   *  Unused by SupportContent, which keeps its own shared error block
   *  (`err` also carries gift/subscription errors) — this is the standalone
   *  /donate page's error surface, added in a later task. */
  error?: string | null;
  /** From process.env.PAYPAL_CLIENT_ID (read server-side — see DonateClient's
   *  own docs for why never a NEXT_PUBLIC_* var). Null/undefined = PayPal
   *  isn't configured: the split button's ▾ doesn't render at all, and the
   *  button reads exactly "Tip $X". TipForm owns the whole split button, not
   *  just a slot under it, because PayPal/Venmo have to stay mounted BESIDE
   *  the form's own controls (see the lock mechanism below), not swapped in
   *  behind a separate view. */
  paypalClientId?: string | null;
  /** Called once a PayPal/Venmo capture succeeds — mirrors `onSubmit`'s role
   *  for the card path. Carries the same draft `onSubmit` would have, so a
   *  caller's done view can show "N Qorm is on its way" for the PayPal path
   *  too, not just card — PayPalButton's own onCaptured takes no arguments
   *  (it never had a caller that needed one before this), so this reads the
   *  same `draft` below that `getDraft` already hands TipPayButton, which is
   *  frozen by the lock for the whole life of the order and therefore still
   *  correct at capture time. The caller decides what "done" looks like (both
   *  DonateClient and SupportContent switch to their own done view). */
  onPaypalCaptured?: (draft: TipDraft) => void;
  /** Whether card payments (Stripe) are on here — the caller's
   *  useBillingAvailability().stripe. false = PayPal/Venmo only: no card half,
   *  PayPal's own button stands alone and this form's amount, message, name and
   *  anonymity feed it. Default true. */
  cardAvailable?: boolean;
}) {
  // The amount to seed from: a remembered draft (returning from a declined
  // or cancelled checkout) takes precedence over the page's own
  // initialAmount (e.g. a ?amount= link). Both are optional and unvalidated
  // at the call site, so the shared PAY_MIN/MAX_CENTS range applies either way.
  const inRange = (dollars: number) => {
    const cents = Math.round(dollars * 100);
    return cents >= PAY_MIN_CENTS && cents <= PAY_MAX_CENTS;
  };
  const seedAmountRaw = props.initialDraft?.amount ?? props.initialAmount;
  const seedAmount = Number.isFinite(seedAmountRaw) && inRange(seedAmountRaw!) ? seedAmountRaw! : undefined;
  const seedIsPreset = seedAmount !== undefined && PRESETS.includes(seedAmount);

  const [amount, setAmount] = useState(() => (seedIsPreset ? seedAmount! : 5));
  // A seeded amount that ISN'T one of the presets goes in the custom box
  // too, not just the submit button's label — otherwise the figure the link
  // (or the remembered draft) picked shows nowhere the person can see or
  // edit it.
  const [custom, setCustom] = useState(() => (seedAmount !== undefined && !seedIsPreset ? String(seedAmount) : ""));
  const [message, setMessage] = useState(() => props.initialDraft?.message ?? "");
  const [name, setName] = useState(() => props.initialDraft?.displayName ?? props.initialName ?? "");
  const [donateAnon, setDonateAnon] = useState(() => props.initialDraft?.anonymous ?? false);
  const anonHelpId = useId();
  // Whether a name was prefilled from a signed-in account — independent of
  // the CURRENT `name` state, which changes as the person types (and which a
  // remembered draft can also repopulate), so the hint below stays correct
  // for the whole life of the form, not just its first render.
  const hadPrefilledName = Boolean(props.initialName && props.initialName.trim() !== "");
  // The Announce switch (Qorm-for-all-income piece 3): off turns this form
  // into a quiet Qorm purchase. Ignored when signed out — a guest gets no
  // switch and always tips (see `initialAnnounce`'s doc above).
  const [announceChoice, setAnnounceChoice] = useState(() => props.initialDraft?.announce ?? props.initialAnnounce ?? true);
  // The buy switch (`currency.purchasable`): with buying off there is no quiet
  // purchase, so no switch — every submit is a tip. Unknown (the store table's first read has
  // not landed) keeps the switch: the purchase routes refuse on their own when it is off.
  const canBuy = useStorePrices().purchasable !== false;
  const announce = props.signedIn && canBuy ? announceChoice : true;
  const customNum = parseFloat(custom);
  const effective = custom.trim() !== "" && Number.isFinite(customNum) ? customNum : amount;
  const validAmount = inRange(effective);

  // What the voice will read of the message at THIS amount. The box caps at
  // it; a draft that outlives a lowered amount is not cut — the counter goes
  // red and the button waits (donationTts.ts).
  const ttsChars = donationTtsChars(validAmount ? effective : 0);
  const messageTooLong = announce && message.length > ttsChars;

  // The ONE draft shape — what onSubmit sends AND what TipPayButton's PayPal/
  // Venmo half snapshots at click time (getDraft below), so the split button
  // can never see a different amount/name/message than a card submit would.
  // Announce OFF is a quiet Qorm purchase: message/name/anonymous are always
  // ""/""/false, whatever is still sitting in the (hidden) controls — a
  // message nobody will hear must never leak into a Qorm order.
  const draft: TipDraft = announce
    ? { amount: effective, message, displayName: donateAnon ? "" : name.trim(), anonymous: donateAnon, announce: true }
    : { amount: effective, message: "", displayName: "", anonymous: false, announce: false };
  const valid = validAmount && !messageTooLong;
  // This exact substring (`!validAmount || messageTooLong`) is pinned by
  // donationTts.scan.test.ts — kept written out in full, rather than only
  // through `valid` above, so the scan (which reads this file's source, not
  // TipPayButton's) still finds it after the button itself moved out.
  const disabledCard = props.busy || !validAmount || messageTooLong;

  // The Qorm this tip will pay, at the D1 peg (pointsForCents, coins.ts — ONE
  // place for the cents->Qorm conversion, so this line and the caller's
  // thank-you view can never show two different numbers for the same tip).
  // Falls back to 0 while the box is invalid, the same shape ttsChars above
  // uses — "0 Qorm" mid-edit reads better than a wild out-of-range figure.
  const pointsAmount = pointsForCents(Math.round((validAmount ? effective : 0) * 100));
  // Where "Sign in" sends a signed-out tipper back to — this page/panel,
  // exactly as it is now. useClientValue, not next/navigation's usePathname:
  // that hook needs an App Router context this component doesn't always
  // render inside (SupportContent mounts it too, and every render test in
  // this feature mounts TipForm bare, with no router provider). Renders the
  // SSR-safe default on the server/first paint and the real path once
  // hydrated — the same idiom StreamView.tsx uses for embedHost.
  const pathname = useClientValue(() => window.location.pathname, "/");
  const signInHref = `/auth/signin?callbackUrl=${encodeURIComponent(pathname)}`;

  // A live PayPal order fixes the amount at createOrder and its approval
  // popup can stay open for minutes — the same property a live Stripe
  // checkout session has (see tipFormCheckoutGuard.scan.test.ts). Stripe's
  // answer is unmounting TipForm entirely; PayPal's answer has to be
  // different because the split button keeps TipForm mounted (that's the
  // point of it), so instead every control here locks for the duration:
  // TipPayButton flips this via onLockChange the moment its own PayPal/Venmo
  // onClick passes validation, and unlocks on cancel/error/a failed order or
  // capture (PayPalButton.tsx). A successful capture leaves it locked — the
  // caller is expected to move on to its own "done" view.
  const [locked, setLocked] = useState(false);
  const controlsDisabled = locked;

  // Emote tab-autocomplete for the donation message (same engine as live chat).
  const emotes = useEmotes();
  const msgRef = useRef<HTMLTextAreaElement>(null);
  const {
    overlayMatches, overlaySel, isMentionMode,
    hoverSelect, applyOverlayItem, handleOverlayKeyDown, onSelectionChange,
  } = useEmoteAutocomplete({
    value: message,
    // Never cut on insert — a picked emote can push a draft past ttsChars,
    // but an over-long draft is held by `messageTooLong` (the counter + the
    // disabled button), same as typing past it directly. Slicing here would
    // silently throw away characters the rest of the form promises never to cut.
    //
    // While LOCKED, this is a no-op: the message is one of the controls a lock
    // must freeze, and this is the one path that could still change it even
    // though the textarea itself is `disabled` — a click on an emote suggestion
    // that was already open and on screen the instant PayPal's onClick fired.
    // Independent, belt-and-suspenders mechanism from hiding the list below
    // (same two-mechanisms shape as PayPalButton's `!valid` guard): if the
    // render guard were ever defeated, this still can't let the message
    // change under a snapshot the order already carries.
    setValue: (v) => { if (!controlsDisabled) setMessage(v); },
    emotes,
    inputRef: msgRef,
  });
  // ONE condition for the suggestion list AND the textarea's combobox ARIA:
  // hiding the list while locked but leaving aria-controls pointing at it
  // would name a listbox no longer in the DOM.
  const listOpen = overlayMatches.length > 0 && !controlsDisabled;

  return (
    <>
      {props.signedIn && canBuy && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-sm text-body">Announce on stream</span>
          <Toggle
            on={announce}
            onToggle={() => { setAnnounceChoice((v) => !v); props.onAmountChange?.(); }}
            label="Announce on stream"
            disabled={controlsDisabled}
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((p) => {
          const selected = custom.trim() === "" && amount === p;
          return (
            <button
              key={p}
              onClick={() => {
                setAmount(p);
                setCustom("");
                props.onAmountChange?.();
              }}
              disabled={controlsDisabled}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
                selected ? (announce ? "bg-emerald-500 text-on-accent" : "bg-yellow-500 text-on-accent") : "bg-raised text-body hover:bg-control"
              }`}
            >
              {formatPrice(p * 100)}
            </button>
          );
        })}
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">
            {currencySign()}
          </span>
          <input
            type="number"
            min={PAY_MIN_CENTS / 100}
            max={PAY_MAX_CENTS / 100}
            inputMode="decimal"
            placeholder="Other"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              props.onAmountChange?.();
            }}
            disabled={controlsDisabled}
            className="w-28 rounded-lg border border-control bg-canvas py-2 pl-7 pr-3 text-sm text-heading outline-none focus:border-emerald-500 disabled:opacity-50"
          />
        </div>
      </div>

      {/* A tip pays 1 Qorm per USD cent. Always shown — even a guest sees
          what signing in would additionally get them, which is the whole
          point of the nudge. */}
      <p className="mt-2 text-xs text-body-dim">
        {props.signedIn
          ? <>You&apos;ll {announce ? "also " : ""}get <strong className="font-semibold text-body">{pointsAmount.toLocaleString()}</strong> {currencyName(pointsAmount)}</>
          : <><a href={signInHref} className="text-emerald-400 hover:text-emerald-300 underline">Sign in</a> to also get <strong className="font-semibold text-body">{pointsAmount.toLocaleString()}</strong> {currencyName(pointsAmount)}</>}
      </p>

      {announce && (
        <>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={donateAnon || controlsDisabled}
            // Matches sanitizeDisplayName's own `.slice(0, 32)` (sanitize.ts) —
            // the server is still the authority, this only stops the box
            // promising more than the server keeps (a longer name would show in
            // full here and be read out on stream cut mid-word).
            maxLength={32}
            placeholder="Your name (optional)"
            aria-label="Your name"
            className="mt-3 w-full rounded-lg border border-control bg-canvas px-3 py-2 text-sm text-heading outline-none focus:border-emerald-500 disabled:opacity-50"
          />
          {hadPrefilledName && name.trim() === "" && (
            // Only for a signed-in person, and only while the box is actually
            // empty: donate/route.ts re-fills a blank, non-anonymous name
            // from site.users.display_name for them, which is correct — but an
            // empty box otherwise reads as "this will be Anonymous", which for a
            // signed-in person it is not.
            // A signed-out person never sees this: for them a blank box really
            // does mean Anonymous.
            <p className="mt-1 text-xs text-body-dim">
              Leave blank to use your account name, or tick &quot;Tip anonymously&quot;.
            </p>
          )}

          <div className="relative mt-3">
            {/* Hidden while locked: a list already open with matches when
                PayPal's onClick fires must not stay clickable — its onMouseDown
                calls applyOverlayItem -> setValue -> setMessage, changing the
                screen's message after the order already snapshotted a different
                one. */}
            {listOpen && (
              <EmoteCompletionList
                matches={overlayMatches}
                selected={overlaySel}
                onSelect={applyOverlayItem}
                onChangeSelected={hoverSelect}
                isMention={isMentionMode}
                listboxId="support-emote-listbox"
              />
            )}
            <textarea
              ref={msgRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => { handleOverlayKeyDown(e); }}
              onSelect={onSelectionChange}
              placeholder="Add a message (optional) — type : for emotes"
              // A plain textarea, not ChatComposerField, so the combobox wiring
              // is inline — same conditions as the overlay's own render above.
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={listOpen}
              aria-controls={listOpen ? "support-emote-listbox" : undefined}
              aria-activedescendant={listOpen ? `support-emote-listbox-opt-${overlaySel}` : undefined}
              rows={2}
              maxLength={ttsChars}
              disabled={controlsDisabled}
              className="w-full resize-none rounded-lg border border-control bg-canvas px-3 py-2 text-sm text-heading outline-none focus:border-emerald-500 disabled:opacity-50"
            />
            <p className="mt-1 flex items-center justify-between text-xs text-body-dim">
              <span>{donationTtsLine(validAmount ? effective : 0)}</span>
              <CharCounter length={message.length} max={ttsChars} showWithin={ttsChars} />
            </p>
            {messageTooLong && (
              <p role="alert" className="mt-1 text-xs text-red-400">
                Your message is longer than a ${validAmount ? effective : "—"} donation reads. Shorten it or raise the amount.
              </p>
            )}
          </div>

          <label className="mt-3 flex items-center gap-2 text-xs text-secondary select-none cursor-pointer">
            <input
              type="checkbox"
              checked={donateAnon}
              onChange={(e) => setDonateAnon(e.target.checked)}
              disabled={controlsDisabled}
              aria-describedby={anonHelpId}
              className="accent-emerald-500 disabled:opacity-50"
            />
            Tip anonymously
          </label>
          {/* k's wording (2026-10-19). Always shown with the checkbox, never toggled
              with it, so ticking the box cannot move anything below it. */}
          <p id={anonHelpId} className="mt-1 text-xs text-body-dim">
            Hides your name from public alerts and chat. The payment provider and site operator still have payment records.
          </p>
        </>
      )}

      <TipPayButton
        amount={validAmount ? effective : 0}
        busy={props.busy}
        disabledCard={disabledCard}
        valid={valid}
        purpose={announce ? "tip" : "points"}
        getDraft={() => draft}
        paypalClientId={props.paypalClientId ?? null}
        locked={locked}
        onLockChange={setLocked}
        onCardSubmit={() => props.onSubmit(draft)}
        onPaypalCaptured={() => props.onPaypalCaptured?.(draft)}
        cardAvailable={props.cardAvailable ?? true}
      />
      {locked && (
        <p className="mt-1 text-xs text-body-dim">
          Finish in the PayPal window — the amount is locked until you do.
        </p>
      )}
      {props.error && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {props.error}
        </p>
      )}
    </>
  );
}
