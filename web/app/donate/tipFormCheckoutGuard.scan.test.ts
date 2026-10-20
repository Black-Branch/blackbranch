import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A money-display invariant: a Stripe Checkout session's amount is fixed at
// creation, so if TipForm stayed mounted and interactive while the checkout
// box was open, a viewer could change the amount shown on screen (the preset
// buttons) AFTER the open session had already committed to the old one, and
// pay believing they sent the new figure. `busy` does not protect this: it
// only disables the submit button, and it goes false again in the `finally`.
//
// So: while a checkout session is open, TipForm must not render at all, and
// the only way back to it must clear BOTH clientSecret and sessionId — not
// just the view — so a stale session can never be paid from a screen that has
// moved on, and a fresh checkout always gets a fresh session (so
// usePaymentResult polls the session actually on screen).
//
// The test asserts POSITION, not absence-within-a-slice. An absence check
// between the checkout and done markers plus a count-of-one would still pass
// with <TipForm> rendered unconditionally right after the heading and the
// `{view === "checkout" && clientSecret ? (…) : view === "done" ? (…) : null}`
// branch appended below it — TipForm's one occurrence would sit BEFORE the
// checkout marker, outside the slice. TipForm's match index must fall AFTER
// both the checkout-branch marker and the done-branch marker, i.e. it can only
// live in the final fallback arm, the one arm that cannot coexist with a
// mounted clientSecret.
//
// PayPal/Venmo are a mode of TipForm's own split button and TipForm stays
// mounted for the whole PayPal flow — the amount-drift risk a live PayPal
// order carries (createOrder fixes the amount; the approval popup can stay
// open for minutes, same as a live Stripe session) is closed by TipForm
// LOCKING its own controls while a PayPal order is live. That half of the
// invariant is pinned by real mounts, not a source scan:
// PayPalButton.render.test.ts ("Render PayPal's button ONCE...", the
// onClick/lock/unlock tests) and TipPayButton's own render tests (every
// control disabled while locked). The Stripe half below: a live Stripe
// Checkout session gets its own exclusive view.

const src = readFileSync(new URL("./DonateClient.tsx", import.meta.url), "utf8");

test("vacuity anchor: DonateClient.tsx is read whole", () => {
  assert.ok(src.trimEnd().endsWith("}"), "DonateClient.tsx truncated — every assertion below would be vacuous");
});

// Shared marker lookup. Every test below that needs a boundary calls this
// rather than re-deriving its own indices, so the two markers stay in
// agreement across the whole file.
function markers() {
  const checkoutStart = src.indexOf('view === "checkout" && clientSecret ?');
  assert.ok(
    checkoutStart !== -1,
    "the checkout branch's guard condition is gone — either the `&& clientSecret` guard or the exclusive-branch shape changed; update this scan after confirming TipForm still can't coexist with checkout",
  );
  const doneStart = src.indexOf('view === "done" ?', checkoutStart);
  assert.ok(doneStart !== -1, "could not find the \"done\" branch after the checkout branch — file structure changed");
  return { checkoutStart, doneStart };
}

test("the checkout branch never renders TipForm", () => {
  const { checkoutStart, doneStart } = markers();
  const checkoutBlock = src.slice(checkoutStart, doneStart);
  // Vacuity anchor for the negative assertion below: a near-empty slice would
  // make "no TipForm in here" true for the wrong reason.
  assert.ok(checkoutBlock.length > 300, "vacuity anchor: the checkout block slice is implausibly short — did the markers land in the wrong place?");
  assert.ok(
    !/<TipForm\b/.test(checkoutBlock),
    "TipForm renders inside the checkout branch — the amount shown on screen can then drift from the amount the open Stripe session actually charges",
  );
});

test("TipForm renders from exactly one place, and it is POSITIONED after both the checkout AND done markers", () => {
  // Position, not absence-within-a-slice (round 2): a `<TipForm>` sitting
  // BEFORE the checkout branch — rendered unconditionally, with the checkout
  // box merely appended below it — passes every earlier assertion in this
  // file (the slice-based check above never sees it, and the count is still
  // 1) while fully reintroducing the amount-drift bug. The only render site
  // that cannot coexist with a mounted clientSecret is the FINAL fallback
  // arm, reached only once `view === "checkout"` AND `view === "done"` are
  // both ruled out — so the match index must fall after BOTH markers.
  const { checkoutStart, doneStart } = markers();

  const matches = [...src.matchAll(/<TipForm\b/g)];
  assert.equal(matches.length, 1, "TipForm should render from exactly one place in this file — a second copy could reopen the same gap on a different path");

  const first = matches[0];
  assert.ok(first !== undefined, "vacuity anchor: matchAll produced no match, despite the count-of-one assertion above");
  const tipFormAt = first.index;
  assert.ok(tipFormAt !== undefined, "vacuity anchor: matchAll match carried no index");
  assert.ok(
    tipFormAt > checkoutStart,
    "TipForm's render site sits BEFORE the checkout branch marker — it can render unconditionally alongside a live checkout session, which is the exact amount-drift shape this file exists to catch",
  );
  assert.ok(
    tipFormAt > doneStart,
    "TipForm's render site sits before the done branch marker — it is not confined to the final fallback arm, so it can still coexist with an open checkout session",
  );
});

test("the back control clears BOTH clientSecret and sessionId, not just the view", () => {
  const fnAt = src.indexOf("function backToForm(");
  assert.ok(fnAt !== -1, "vacuity anchor: backToForm is gone or renamed — update this scan");
  const closeAt = src.indexOf("}", src.indexOf("setErr(null)", fnAt));
  assert.ok(closeAt !== -1, "vacuity anchor: could not find backToForm's closing brace");
  const fnBody = src.slice(fnAt, closeAt + 1);
  assert.ok(
    /setClientSecret\(null\)/.test(fnBody),
    "backToForm no longer clears clientSecret — a stale session could still be paid from a screen that has moved on",
  );
  assert.ok(
    /setSessionId\(null\)/.test(fnBody),
    "backToForm no longer clears sessionId — usePaymentResult would keep polling a session no longer on screen",
  );
  assert.ok(/setView\("form"\)/.test(fnBody), "backToForm no longer returns to the form view");
});

test("the checkout view exposes a visible, wired way back to the form", () => {
  assert.ok(src.includes("← Change amount"), "no visible back control found — a viewer stuck on checkout has no way to change the amount");
  assert.ok(/onClick=\{backToForm\}/.test(src), "the back control(s) are not wired to backToForm");
});

test("every checkout starts from a fresh POST, so a new amount always gets a new session id", () => {
  // startCheckout always sets a NEW clientSecret/sessionId from the route's
  // response, never reuses a previous one — that's what stops a stale
  // EmbeddedCheckoutProvider from silently mounting an old (wrong-amount)
  // session after "← Change amount" and a re-submit.
  const startAt = src.indexOf("async function startCheckout(");
  assert.ok(startAt !== -1, "vacuity anchor: startCheckout is gone or renamed — update this scan");
  const endAt = src.indexOf("\n  }\n", startAt);
  assert.ok(endAt !== -1, "vacuity anchor: could not find startCheckout's end");
  const body = src.slice(startAt, endAt);
  assert.ok(/setClientSecret\(cs\)/.test(body), "startCheckout no longer sets clientSecret from the fresh response");
  assert.ok(/setSessionId\(sid/.test(body), "startCheckout no longer sets sessionId from the fresh response");
});
