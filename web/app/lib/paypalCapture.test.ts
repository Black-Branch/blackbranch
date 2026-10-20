// paypalCapture.ts tests — pure extraction, no network, no PayPal SDK.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/lib/paypalCapture.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const { extractPaypalCapture } = await import("./paypalCapture.ts");

const here = dirname(fileURLToPath(import.meta.url));

// ── the REAL PayPal sandbox event (fix round 1) ──────────────────────────────
//
// Pulled from PayPal's OWN /v1/notifications/simulate-event against sandbox
// credentials — not hand-written from a description. It settles a real
// question: a description can suggest an ORDER-shaped path (purchase_units[0].payments.captures[0]...); this fixture
// proves the real PAYMENT.CAPTURE.COMPLETED webhook `resource` is FLAT — the
// capture object itself, no purchase_units wrapper.
const FIXTURE_DIR = join(here, "__fixtures__", "paypal");
const realCaptureEvent = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "payment.capture.completed.json"), "utf8"),
) as {
  event_type: string;
  resource: {
    id: string;
    custom_id: string;
    amount: { value: string; currency_code: string };
    seller_receivable_breakdown: {
      net_amount: { value: string; currency_code: string };
      paypal_fee: { value: string };
    };
  };
};

test("event_type on the real fixture really is PAYMENT.CAPTURE.COMPLETED (sanity check on the fixture itself)", () => {
  assert.equal(realCaptureEvent.event_type, "PAYMENT.CAPTURE.COMPLETED");
});

test("the fixture's own gross and net currency codes already agree (sanity check backing the currency tests below)", () => {
  assert.equal(realCaptureEvent.resource.amount.currency_code, realCaptureEvent.resource.seller_receivable_breakdown.net_amount.currency_code);
});

// Every assertion here reads its expected value OUT OF THE FIXTURE, not as a
// literal — if the fixture is refreshed with a different sample, this test
// moves with it instead of silently comparing against a stale number.
test("extracts capture id, gross USD, net USD, currency and custom_id from the REAL PayPal sandbox event", () => {
  const result = extractPaypalCapture(realCaptureEvent);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const r = realCaptureEvent.resource;
  assert.equal(result.captureId, r.id);
  assert.equal(result.grossUsd, Number(r.amount.value));
  assert.equal(result.netUsd, Number(r.seller_receivable_breakdown.net_amount.value));
  assert.equal(result.currency, r.amount.currency_code);
  assert.equal(result.customId, r.custom_id);
  // The fixture's own net_amount ($49.39) is already gross ($57.00) minus
  // BOTH paypal_fee ($2.48) and a platform_fees[] entry ($5.13) — proof that
  // net_amount is taken as-is and nothing here re-derives or re-sums a split.
  assert.notEqual(result.netUsd, result.grossUsd - Number(r.seller_receivable_breakdown.paypal_fee.value),
    "netUsd must be net_amount itself, not gross-minus-paypal_fee-only (that ignores platform_fees)");
});

test("custom_id absent on the resource is null, not a throw", () => {
  const c = JSON.parse(JSON.stringify(realCaptureEvent));
  delete c.resource.custom_id;
  const result = extractPaypalCapture(c);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.customId, null);
});

// ── payer PII: never leaks into the result ───────────────────────────────────
//
// The real fixture above happens to carry NO payer block at all (confirmed:
// the sandbox event's resource keys are exactly amount, create_time,
// custom_id, disbursement_mode, final_capture, id, invoice_id, links,
// seller_protection, seller_receivable_breakdown, status, supplementary_data,
// update_time — see the coordinator's message). That is a fact about THIS
// sample, not a guarantee about every capture PayPal will ever send, and the
// safety property this task exists to prove ("never reads payer.name /
// payer.email_address") has to hold structurally, not just on payloads that
// happen not to exercise it. So this ONE synthetic payload — the real
// fixture's resource shape, with a payer block appended exactly where
// PayPal's docs show it can appear on a capture resource — exists solely to
// prove the guarantee against a payload that actually contains the thing it
// must not read.
function syntheticCaptureWithPayer() {
  return {
    id: "WH-SYNTHETIC-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      ...realCaptureEvent.resource,
      payer: {
        name: { given_name: "Casey", surname: "Rivera" },
        email_address: "casey.weston@example.com",
        payer_id: "PAYERID123",
      },
    },
  };
}

test("the extracted object carries no trace of the payer's name or email, even though the source payload has both", () => {
  const result = extractPaypalCapture(syntheticCaptureWithPayer());
  assert.equal(result.ok, true);
  const dump = JSON.stringify(result);
  assert.ok(!dump.includes("Casey"), "the payer's given name leaked into the extracted object");
  assert.ok(!dump.includes("Rivera"), "the payer's surname leaked into the extracted object");
  assert.ok(!dump.includes("casey.weston@example.com"), "the payer's email leaked into the extracted object");
  assert.ok(!dump.includes("PAYERID123"), "the payer id leaked into the extracted object");
  assert.ok(!("payer" in (result as unknown as Record<string, unknown>)), "a payer field exists on the result at all");
});

/** Swaps console.error for a capturing stub for the duration of `fn`, restoring it after. */
async function withCapturedErrors<T>(fn: () => T | Promise<T>): Promise<{ result: T; errors: unknown[][] }> {
  const errors: unknown[][] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    const result = await fn();
    return { result, errors };
  } finally {
    console.error = real;
  }
}

// ── malformed / partial payloads must report failure, never throw ───────────

const BAD_SHAPES: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["a number", 42],
  ["a bare string", "not an event"],
  ["an empty object", {}],
  ["resource missing", { event_type: "PAYMENT.CAPTURE.COMPLETED" }],
  ["resource null", { resource: null }],
  ["resource not an object", { resource: "nope" }],
  ["resource.id missing", { resource: { amount: { value: "5.00" }, seller_receivable_breakdown: { net_amount: { value: "4.50" } } } }],
  [
    "resource.amount missing",
    { resource: { id: "C1", seller_receivable_breakdown: { net_amount: { value: "4.50" } } } },
  ],
  [
    "resource.amount.value not numeric",
    { resource: { id: "C1", amount: { value: "not-a-number" }, seller_receivable_breakdown: { net_amount: { value: "4.50" } } } },
  ],
  [
    "seller_receivable_breakdown missing",
    { resource: { id: "C1", amount: { value: "5.00" } } },
  ],
  [
    "net_amount missing",
    { resource: { id: "C1", amount: { value: "5.00" }, seller_receivable_breakdown: {} } },
  ],
  [
    "net_amount.value not numeric",
    { resource: { id: "C1", amount: { value: "5.00" }, seller_receivable_breakdown: { net_amount: { value: "N/A" } } } },
  ],
];

for (const [label, bad] of BAD_SHAPES) {
  test(`does not throw on a malformed event (${label}) — reports failure instead`, async () => {
    const { result } = await withCapturedErrors(() => extractPaypalCapture(bad));
    assert.equal((result as { ok: boolean }).ok, false, `expected extraction to fail for: ${label}`);
  });
}

// ── fix round 1, part 2: a failed extraction is LOUD, never silent ──────────
//
// An extractPaypalCapture that returned {ok:false} with no log at all would
// let the caller omit netUsd, money.js's takeHome() would
// quietly fall back to stripeNet, and the night's total would read high with
// nobody told — indistinguishable from success. This proves the failure path
// logs, and logs the capture id (the recovery handle), never the payer.

test("a failed extraction logs a greppable console.error naming the capture id", async () => {
  const bad = { resource: { id: "CAPTURE-LOUD-1", amount: { value: "5.00" }, seller_receivable_breakdown: {} } };
  const { result, errors } = await withCapturedErrors(() => extractPaypalCapture(bad));
  assert.equal((result as { ok: boolean }).ok, false);
  assert.equal(errors.length, 1, "extraction failure must log exactly once");
  const text = errors[0]!.join(" ");
  assert.match(text, /paypalCapture/i, "the line must be greppable by module name");
  assert.match(text, /CAPTURE-LOUD-1/, "the line must carry the capture id — it is the recovery handle");
});

test("a failed extraction with NO capture id yet logs 'unknown', not a crash or a blank", async () => {
  const { result, errors } = await withCapturedErrors(() => extractPaypalCapture({ resource: {} }));
  assert.equal((result as { ok: boolean }).ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.join(" "), /unknown/, "no capture id was ever resolved — the log must say so, not omit it");
});

test("a failed extraction never logs the payer, even when the malformed payload carries one", async () => {
  const bad = { resource: { payer: { name: { given_name: "Casey" }, email_address: "casey@example.com" } } }; // no id → fails
  const { errors } = await withCapturedErrors(() => extractPaypalCapture(bad));
  const text = errors.map((a) => a.join(" ")).join("\n");
  assert.ok(!/Casey/.test(text), "the payer's name leaked into the failure log");
  assert.ok(!/casey@example\.com/.test(text), "the payer's email leaked into the failure log");
});

test("a SUCCESSFUL extraction logs nothing at all", async () => {
  const { errors } = await withCapturedErrors(() => extractPaypalCapture(realCaptureEvent));
  assert.equal(errors.length, 0, "a clean extraction must be silent — only failure is loud");
});

// ── fix round 2, item 1: currency must be USD, and gross/net must agree ─────
//
// createPaypalOrder (paypalClient.ts) hardcodes currency_code:"USD" when WE
// mint the order, so a capture that comes back in a different currency, or
// with gross/net disagreeing about the currency, means something happened
// that this system does not model. Guessing "must be USD anyway" would credit
// a foreign number onto the USD support bar — the exact silent-overstatement
// bug fix round 1 closed for a missing net. These payloads are built by
// spreading the REAL fixture's resource and overriding only the currency
// field(s) — same technique as syntheticCaptureWithPayer() above — so they
// stay anchored to the real shape rather than a hand-typed guess at one.

function withCurrency(overrides: { gross?: string | undefined; net?: string | undefined; dropGross?: boolean; dropNet?: boolean }) {
  const c = JSON.parse(JSON.stringify(realCaptureEvent)) as typeof realCaptureEvent;
  if (overrides.dropGross) delete (c.resource.amount as { currency_code?: string }).currency_code;
  else if (overrides.gross !== undefined) c.resource.amount.currency_code = overrides.gross;
  if (overrides.dropNet) delete (c.resource.seller_receivable_breakdown.net_amount as { currency_code?: string }).currency_code;
  else if (overrides.net !== undefined) c.resource.seller_receivable_breakdown.net_amount.currency_code = overrides.net;
  return c;
}

test("a non-USD currency (gross and net agree with each other, but it's EUR) is refused, loudly, naming the actual code — the tip is not dropped, only the dollar assertion is", async () => {
  const bad = withCurrency({ gross: "EUR", net: "EUR" });
  const { result, errors } = await withCapturedErrors(() => extractPaypalCapture(bad));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /EUR/, "the reason must name the actual currency code seen");
  assert.match(result.reason, /USD/i, "the reason should say what WAS required (USD), not just what wasn't");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.join(" "), /EUR/);
});

test("gross and net currency codes disagreeing with each other is refused, naming BOTH codes", async () => {
  const bad = withCurrency({ gross: "USD", net: "EUR" });
  const { result } = await withCapturedErrors(() => extractPaypalCapture(bad));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /USD/);
  assert.match(result.reason, /EUR/);
});

test("a missing currency_code on the gross amount is refused", async () => {
  const bad = withCurrency({ dropGross: true });
  const { result } = await withCapturedErrors(() => extractPaypalCapture(bad));
  assert.equal(result.ok, false);
});

test("a missing currency_code on the net amount is refused", async () => {
  const bad = withCurrency({ dropNet: true });
  const { result } = await withCapturedErrors(() => extractPaypalCapture(bad));
  assert.equal(result.ok, false);
});

// ── a strictly-positive floor, not just "finite" ────────────────────────────
//
// Number(""), Number(" "), Number(null) and Number([]) are all 0 — finite —
// so a naive `Number.isFinite` floor lets an empty/missing-ish amount through
// as a "valid" $0.00 tip. A tip's gross and net are both nonsense at or below
// zero, so both are required to be STRICTLY positive, and the two ways a
// value can fail ("not numeric" vs "not positive") are reported distinctly.
//
// These are FLOOR-only tests. Nothing here asserts an upper bound — that
// guard (net > gross) lives in money.js's takeHome(), not here, and stays
// there; see money-currency.test.js.

const NON_POSITIVE: Array<[string, unknown]> = [
  ["zero", "0.00"],
  ["negative", "-5.00"],
  ["an empty string", ""],
  ["a whitespace-only string", " "],
  ["null", null],
  ["an empty array", []],
];

for (const [label, bad] of NON_POSITIVE) {
  test(`a gross amount of ${label} is refused as NOT POSITIVE, not accepted as $0`, async () => {
    const c = JSON.parse(JSON.stringify(realCaptureEvent)) as typeof realCaptureEvent;
    (c.resource.amount as { value: unknown }).value = bad;
    const { result } = await withCapturedErrors(() => extractPaypalCapture(c));
    assert.equal(result.ok, false, `expected refusal for gross=${label}`);
    if (result.ok) return;
    assert.match(result.reason, /not positive/, `gross=${label}: reason should distinguish "not positive", got: ${result.reason}`);
  });

  test(`a net amount of ${label} is refused as NOT POSITIVE, not accepted as $0`, async () => {
    const c = JSON.parse(JSON.stringify(realCaptureEvent)) as typeof realCaptureEvent;
    (c.resource.seller_receivable_breakdown.net_amount as { value: unknown }).value = bad;
    const { result } = await withCapturedErrors(() => extractPaypalCapture(c));
    assert.equal(result.ok, false, `expected refusal for net=${label}`);
    if (result.ok) return;
    assert.match(result.reason, /not positive/, `net=${label}: reason should distinguish "not positive", got: ${result.reason}`);
  });
}

const NOT_NUMERIC: Array<[string, unknown]> = [
  ["a non-numeric string", "abc"],
  ["an object", {}],
  ["undefined (field absent)", undefined],
];

for (const [label, bad] of NOT_NUMERIC) {
  test(`a gross amount that is ${label} is refused as NOT NUMERIC, a different reason from "not positive"`, async () => {
    const c = JSON.parse(JSON.stringify(realCaptureEvent)) as typeof realCaptureEvent;
    if (bad === undefined) delete (c.resource.amount as { value?: unknown }).value;
    else (c.resource.amount as { value: unknown }).value = bad;
    const { result } = await withCapturedErrors(() => extractPaypalCapture(c));
    assert.equal(result.ok, false, `expected refusal for gross=${label}`);
    if (result.ok) return;
    assert.match(result.reason, /not numeric/, `gross=${label}: reason should distinguish "not numeric", got: ${result.reason}`);
  });
}

// ── payer PII: never read (source scan) ──────────────────────────────────────
//
// A source scan backs the runtime proof above: even if some future edit
// stopped reading `.payer` into the RESULT but started logging it elsewhere,
// the module must still never reference payer.name or email_address anywhere
// in its own source.
//
// Vacuity anchor: readOwnSource asserts the file ends where expected, so a
// truncated read cannot make this pass by proving nothing.

const webRoot = join(here, "..", "..");

function readOwnSource(tail: RegExp): string {
  const src = readFileSync(join(webRoot, "app/lib/paypalCapture.ts"), "utf8");
  assert.match(src.slice(-400), tail, "paypalCapture.ts did not end as expected — the read is truncated");
  return stripComments(src);
}

test("paypalCapture.ts never reads payer.name or the payer's email address", () => {
  const src = readOwnSource(/\n}\s*$/);
  assert.ok(!/payer\s*[.?]\s*name/.test(src), "reads payer.name");
  assert.ok(!/email_address/.test(src), "reads the payer's email address");
  assert.ok(!/\.payer\b/.test(src), "reads the payer object at all");
});
