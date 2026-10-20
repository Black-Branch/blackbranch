// PayPal capture extraction. Pure(-ish): takes an already-parsed PayPal
// webhook event object and pulls out exactly the fields money.js's takeHome()
// and the webhook route need — nothing else. "Pure-ish" because a failed
// extraction logs loudly (see `fail` below) — an intentional, documented side
// effect, not a network call or a mutation of its input.
//
// ── The real shape is FLAT ──────────────────────────────────────────────────
// The webhook `resource` is the capture object directly — no
// `purchase_units` wrapper (that is the ORDER resource's shape). Confirmed
// against a real sandbox PAYMENT.CAPTURE.COMPLETED event from PayPal's own
// `/v1/notifications/simulate-event`, saved as the fixture this file's tests
// read: web/app/lib/__fixtures__/paypal/payment.capture.completed.json. Paths:
//   captureId → event.resource.id
//   grossUsd  → event.resource.amount.value      (currency: .amount.currency_code)
//   netUsd    → event.resource.seller_receivable_breakdown.net_amount.value
//               (already net of BOTH paypal_fee and any platform_fees[] —
//               nothing here computes a split; net_amount is taken as-is.
//               currency: .seller_receivable_breakdown.net_amount.currency_code)
//   customId  → event.resource.custom_id
//
// This function takes the WHOLE webhook event ({event_type, resource, id,
// ...}), not just `resource`: the webhook route parses the raw body into
// exactly this shape once and dispatches on `event.event_type`, and
// `verifyPaypalWebhook` in paypalClient.ts consumes that same top-level object
// as its `webhook_event`. One shape flows from `JSON.parse(rawBody)` through
// verification, dispatch, and extraction — no caller has to remember to unwrap
// `.resource`, and this function's error messages can name
// `event.resource?.id` without a second destructure at the call site.
//
// A payer's real name is NEVER read here. This module never touches `.payer`
// at all — pinned by both a runtime test (feed a realistic payload carrying a
// payer name/email, assert the extracted object carries no trace of either)
// and a source scan, both in paypalCapture.test.ts.
//
// ── A failed extraction is LOUD ─────────────────────────────────────────────
// A silent `{ok:false}` would let the caller omit `netUsd`, and money.js's
// takeHome() would fall back to `economics.stripeNet(gross)` with only a WARN
// in stream-api's own log: the night's total reads HIGH (Stripe's fee is lower
// than PayPal's typical net) and nobody is told. Every failure path goes
// through `fail()`, which logs a greppable `console.error` naming the capture
// id (or "unknown" when extraction failed before one was found) — never the
// payer, because this module never reads the payer at all.
//
// ── Currency, and a strictly-positive floor ─────────────────────────────────
//
// 1. CURRENCY. `createPaypalOrder` (paypalClient.ts) sets `currency_code:
//    "USD"` only on orders WE create; a capture that arrived in another
//    currency would otherwise have its bare number read as dollars — a capture
//    in EUR would credit its numeric value straight onto the USD support bar
//    with nothing announcing the unit mismatch. Both currency codes are read
//    and must agree with each other and be exactly "USD", or extraction fails
//    (loudly, through `fail()`, naming the code(s) actually seen).
//    An extraction failure THROWS in onCaptureCompleted, before the UPDATE
//    runs — the pending site.donations row stays status='pending' until
//    someone reconciles it by hand. That is deliberate: a tip we cannot read as
//    a dollar amount must not be silently accepted, so PayPal retries the
//    delivery and the failure stays visible in their dashboard rather than in a
//    row nothing reads. Relaxing this to assume USD on a missing/foreign code
//    reopens the silent-overstatement bug.
// 2. STRICTLY POSITIVE. `Number("")`, `Number(" ")`, `Number(null)` and
//    `Number([])` are all `0` — finite, so a finite-only check lets an
//    empty/missing-ish amount through as a "valid" `grossUsd: 0`. A tip's gross
//    and net are both nonsense at or below zero. `parsePositiveUsd` below
//    requires STRICTLY positive and reports which of two distinct ways a value
//    failed — "not numeric" (NaN: absent, an object, a non-numeric string) vs
//    "not positive" (a real number that is zero or negative, including every
//    coerces-to-zero case above) — because they are different malformed
//    payloads and the log should say which one arrived.
//    FLOOR ONLY. No upper bound of any kind lives here, ever — never cap
//    take-home. The `net > gross` guard lives in money.js's takeHome() and
//    stays there; duplicating it here would be a second place that decision
//    could silently drift from itself.

/**
 * Consumed by paypalWebhookHandlers.ts's onCaptureCompleted, which passes it
 * the parsed webhook event and threads `netUsd` into stream-api's /chat/event
 * donation handler (money.js's takeHome).
 */
export type PaypalCaptureResult =
  | { ok: true; captureId: string; grossUsd: number; netUsd: number; currency: string; customId: string | null }
  | { ok: false; reason: string };

type PositiveUsdParse = { ok: true; value: number } | { ok: false; reason: 'not numeric' | 'not positive' };

// A capture amount arrives as a decimal STRING ("57.00"), never a number.
// `Number()` on a non-string/non-number input (an object, an array with a
// non-numeric first element) already returns NaN — that's the "not numeric"
// case. But `Number("")`, `Number(" ")`, `Number(null)` and `Number([])` are
// all `0`, which IS finite — a tip's amount must be strictly positive, so
// that's the separate "not positive" case (fix round 2). Both are reported
// distinctly because they're different malformed payloads.
function parsePositiveUsd(v: unknown): PositiveUsdParse {
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, reason: 'not numeric' };
  if (n <= 0) return { ok: false, reason: 'not positive' };
  return { ok: true, value: n };
}

// The one place every failure exits through — see "a failed extraction is
// LOUD" above. `captureId` is whatever was resolved so far (null if
// extraction failed before `resource.id` was even read); never the payer,
// because nothing here ever holds a payer value to log in the first place.
function fail(reason: string, captureId: string | null): PaypalCaptureResult {
  console.error(
    '[paypalCapture] FAILED to extract a PAYMENT.CAPTURE.COMPLETED capture (capture id: %s): %s',
    captureId ?? 'unknown',
    reason,
  );
  return { ok: false, reason };
}

/**
 * Consumed by paypalWebhookHandlers.ts's onCaptureCompleted.
 */
export function extractPaypalCapture(event: unknown): PaypalCaptureResult {
  const evt = event as { resource?: unknown } | null | undefined;
  const resource = evt && typeof evt === 'object' ? evt.resource : undefined;
  if (!resource || typeof resource !== 'object') {
    return fail('event.resource missing or not an object', null);
  }
  const r = resource as {
    id?: unknown;
    custom_id?: unknown;
    amount?: { value?: unknown; currency_code?: unknown } | null;
    seller_receivable_breakdown?: { net_amount?: { value?: unknown; currency_code?: unknown } | null } | null;
  };

  const captureId = typeof r.id === 'string' && r.id ? r.id : null;
  if (!captureId) return fail('resource.id missing or not a string', null);

  const grossParsed = parsePositiveUsd(r.amount?.value);
  if (!grossParsed.ok) {
    return fail(`resource.amount.value is ${grossParsed.reason} (saw ${JSON.stringify(r.amount?.value)})`, captureId);
  }
  const grossUsd = grossParsed.value;

  const netParsed = parsePositiveUsd(r.seller_receivable_breakdown?.net_amount?.value);
  if (!netParsed.ok) {
    return fail(
      `resource.seller_receivable_breakdown.net_amount.value is ${netParsed.reason} ` +
        `(saw ${JSON.stringify(r.seller_receivable_breakdown?.net_amount?.value)})`,
      captureId,
    );
  }
  const netUsd = netParsed.value;

  // Fix round 2, item 1: both currency codes must be present, must agree with
  // each other, and must be USD — see the header comment for why a missing or
  // foreign code is refused rather than assumed.
  const grossCurrency = typeof r.amount?.currency_code === 'string' ? r.amount.currency_code : null;
  const netCurrency =
    typeof r.seller_receivable_breakdown?.net_amount?.currency_code === 'string'
      ? r.seller_receivable_breakdown.net_amount.currency_code
      : null;
  if (!grossCurrency || !netCurrency) {
    return fail(
      `currency_code missing (gross=${grossCurrency ?? 'missing'}, net=${netCurrency ?? 'missing'})`,
      captureId,
    );
  }
  if (grossCurrency !== netCurrency) {
    return fail(`gross and net currency_code disagree (gross=${grossCurrency}, net=${netCurrency})`, captureId);
  }
  if (grossCurrency !== 'USD') {
    return fail(
      `currency_code is not USD (saw ${grossCurrency}) — createPaypalOrder only ever mints USD orders, ` +
        `so a non-USD capture is unmodeled here; the tip is still recorded by Task 10, this function just ` +
        `refuses to assert a dollar net it cannot stand behind`,
      captureId,
    );
  }

  const customId = typeof r.custom_id === 'string' ? r.custom_id : null;

  return { ok: true, captureId, grossUsd, netUsd, currency: grossCurrency, customId };
}
