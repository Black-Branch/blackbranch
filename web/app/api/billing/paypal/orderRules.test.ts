// PayPal order route — rule parity with /api/billing/donate. route.ts imports
// `pool` via the `@/lib/db` alias and `auth` via `@/auth`, which `node --test`
// cannot resolve (no bundler), so — same as every other route test in this repo
// (webhook/route.test.ts, mod/payments/route.test.ts, donateRateLimit.test.ts,
// donationTts.scan.test.ts) — this is a SOURCE SCAN, plus direct unit tests of
// the shared rule helpers the route calls (donationTts.ts, sanitize.ts), which
// take no aliased imports and run for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../../lib/testSource.ts";
import { donationTtsChars } from "../../../lib/donationTts.ts";
import { sanitizeChatMessage, sanitizeDisplayName } from "../../../lib/sanitize.ts";

const rawOrder = readFileSync(new URL("./order/route.ts", import.meta.url), "utf8");
const order = stripComments(rawOrder);
const rawDonate = readFileSync(new URL("../donate/route.ts", import.meta.url), "utf8");
const donate = stripComments(rawDonate);
const helperSrc = stripComments(
  readFileSync(new URL("../../../lib/tipDisplayNameServer.ts", import.meta.url), "utf8"),
);

// ─── vacuity anchor ─────────────────────────────────────────────────────────

test("order/route.ts is whole — vacuity anchor for every assertion below", () => {
  assert.ok(rawOrder.trimEnd().endsWith("}"), "order/route.ts truncated — pins below are vacuous");
  assert.match(order, /export async function POST\(/, "no POST handler found — wrong file or wrong shape");
});

// ─── identical bounds ───────────────────────────────────────────────────────

const rawCoinsRoute = readFileSync(new URL("../points/route.ts", import.meta.url), "utf8");
const coinsRoute = stripComments(rawCoinsRoute);

test("the $1–$1,000 bounds come from ONE definition — no route declares its own", () => {
  assert.ok(rawCoinsRoute.trimEnd().endsWith("}"), "vacuity anchor: points/route.ts truncated");
  for (const [name, src] of [["order", order], ["donate", donate], ["points", coinsRoute]] as const) {
    assert.doesNotMatch(src, /\b(MIN|MAX)_CENTS\s*=/, `${name}/route.ts declares its own bound — a second copy that can drift`);
    assert.match(src, /import\s*\{[^}]*PAY_MIN_CENTS[^}]*PAY_MAX_CENTS[^}]*\}\s*from\s*"@\/app\/lib\/coins"|import\s*\{[^}]*PAY_MAX_CENTS[^}]*PAY_MIN_CENTS[^}]*\}\s*from\s*"@\/app\/lib\/coins"/, `${name}/route.ts must import the shared range`);
    assert.match(src, /cents\s*<\s*PAY_MIN_CENTS\s*\|\|\s*cents\s*>\s*PAY_MAX_CENTS/, `${name}/route.ts must check against the shared range`);
  }
});

// ─── identical message-cap rule (same shape as donationTts.scan.test.ts) ────

test("the message cap is the shared tier for the amount, and it rejects rather than cuts", () => {
  assert.match(order, /donationTtsChars\(cents \/ 100\)/);
  assert.match(order, /rawMsg\.length > maxMessage/);
  assert.doesNotMatch(order, /MAX_MESSAGE/, "a second, local cap constant would drift from the shared tier");
  assert.doesNotMatch(order, /\.slice\(0, maxMessage\)/, "silently truncating instead of rejecting");
  // Sanitizing at the flat default (500) before this check runs would cut a
  // top-tier overflow to exactly 500 and the check could then never see it as
  // over `maxMessage`. `maxMessage + 1` is what makes it visible.
  assert.match(order, /sanitizeChatMessage\([^,]+,\s*maxMessage \+ 1\)/);
  assert.doesNotMatch(
    order,
    /sanitizeChatMessage\(body\??\.message\)\s*(?!.*maxMessage \+ 1)/,
    "sanitizeChatMessage called with no cap — falls back to the flat 500 default",
  );
});

test("displayName is sanitized the same way donate does it", () => {
  assert.match(order, /sanitizeDisplayName\(body\??\.displayName\)/);
});

// ─── The display-name backfill must mirror donate's ───────────────────────
//
// donate/route.ts backfills a blank name with a signed-in tipper's own
// site.users.display_name. This block pins BOTH sides of the rule (donate's
// own shape, and this route's extracted equivalent in tipDisplayNameServer.ts)
// so an edit to either one that breaks parity fails here.

test("BOTH tip routes resolve the donor label through the ONE implementation", () => {
  // This replaced a test that pinned donate/route.ts's INLINE copy of the
  // rule and asserted the two matched. That is the wrong target: it made a
  // duplicate permanent and could only ever report drift AFTER it happened —
  // and it did not catch the one divergence that actually shipped (the
  // PayPal route landed with no backfill at all, so a signed-in tipper who
  // left the name box blank would have been promised their site name by the
  // page and then appeared with none). A single implementation cannot drift
  // from itself, so the property worth pinning is that neither route has its
  // own copy any more.
  //
  // `assert.ok(regex.test(...))`, not `assert.match(wholeFile, ...)`: a
  // failing assert.match prints the ENTIRE source file into the test output.
  for (const [name, src] of [["donate/route.ts", donate], ["paypal/order/route.ts", order]] as const) {
    assert.ok(
      /resolveTipDisplayName\(/.test(src),
      `${name} does not call resolveTipDisplayName — the donor-label rule has grown a second copy, which is exactly how the PayPal path shipped without the backfill`,
    );
    assert.ok(
      !/SELECT display_name FROM site\.users/.test(src),
      `${name} queries site.users.display_name directly instead of going through tipDisplayNameServer.ts — one rule, one implementation`,
    );
  }
  // Vacuity anchor: both files must have actually been read. An empty or
  // mis-pathed source would satisfy the negative assertion above for free.
  assert.ok(donate.length > 2000 && order.length > 1000, "vacuity anchor: a route source failed to load, so the scan above proves nothing");
});

test("the PayPal route's backfill (tipDisplayNameServer.ts) carries the same query and the same silent-fallback catch", () => {
  assert.match(helperSrc, /SELECT display_name FROM site\.users WHERE matrix_id = \$1/);
  assert.match(helperSrc, /\.catch\(\(\) => \(\{ rows: \[\] as \{ display_name: string \| null \}\[\] \}\)\)/);
  // anonymity must be the FIRST thing checked — that is what makes it win
  // over both the backfill AND an explicitly typed name.
  assert.match(helperSrc, /if \(args\.anonymous\) return "";/);
});

test("the backfill is wired in after the limiter and before the insert, and Stripe-only machinery does not leak onto this path", () => {
  const limiterCall = order.indexOf("isPaypalOrderLimited(");
  const resolveCall = order.indexOf("resolveTipDisplayName(");
  const insert = order.indexOf("INSERT INTO site.donations");
  assert.ok(resolveCall > 0, "resolveTipDisplayName must actually be called");
  assert.ok(resolveCall > limiterCall, "the backfill must run after the rate limiter");
  assert.ok(resolveCall < insert, "the backfill must resolve before the row is written — the insert needs the final displayName");
  assert.doesNotMatch(order, /ensureStripeCustomer/, "ensureStripeCustomer is Stripe-only and has no business on the PayPal path");
});

// ─── order of operations (same shape as donateRateLimit.test.ts) ───────────

test("paypalConfigured() gates the route before ANY body parsing or validation", () => {
  const gate = order.indexOf("paypalConfigured()");
  const bodyParse = order.indexOf("req.json()");
  const firstStatus = order.indexOf("status:");
  assert.ok(gate >= 0, "no paypalConfigured() gate found");
  assert.match(order.slice(gate, gate + 80), /status: 503/, "the gate must refuse with 503");
  assert.ok(gate < bodyParse, "the 503 gate must run before the body is even parsed");
  assert.ok(gate < firstStatus, "the 503 gate must be the very first refusal in the handler");
});

test("every input refusal (400) precedes the rate limiter, which precedes PayPal and the insert", () => {
  // The points branch (see below) sits earlier in the file and has its own
  // isPaypalOrderLimited(/status: 429/return Response.json({ orderId } tokens,
  // so a bare indexOf would find ITS occurrence instead of the tip path's.
  // `tipStart` (the points branch's own end, computed below as `pointsBranch`)
  // scopes these three lookups to the tip section.
  const tipStart = order.indexOf(pointsBranch) + pointsBranch.length;
  const lastRefusal400 = order.lastIndexOf("status: 400");
  const limiterCall = order.indexOf("isPaypalOrderLimited(", tipStart);
  const refusal429 = order.indexOf("status: 429", tipStart);
  const insert = order.indexOf("INSERT INTO site.donations");
  const createOrder = order.indexOf("createPaypalOrder(");
  const ret = order.indexOf("return Response.json({ orderId }", tipStart);

  assert.ok(lastRefusal400 > 0, "no 400 refusal found");
  assert.ok(limiterCall > 0, "no rate-limiter call found — createSlidingWindowLimiter must actually be invoked");
  assert.ok(limiterCall > lastRefusal400, "the rate limiter must run AFTER every input refusal — a malformed request must not consume budget");
  assert.ok(refusal429 > limiterCall, "a limited caller must be refused with 429");
  assert.ok(insert > refusal429, "the pending row must be written AFTER the limiter, not before");
  assert.ok(createOrder > insert, "PayPal must be called AFTER the row is written (custom_id can't carry the message)");
  assert.ok(ret > createOrder, "{ orderId } must be returned last");
});

test("the limiter keys on the signed-in user, else the client IP — same key shape as donate", () => {
  assert.match(order, /const isPaypalOrderLimited = createSlidingWindowLimiter\(/);
  assert.match(order, /isPaypalOrderLimited\(matrixId \?\? ipKey\(req\)\)/);
});

test("a guest (null matrixId) is accepted — auth() result is never required", () => {
  assert.match(order, /const matrixId = session\?\.user\?\.id \?\? null/);
  // the insert must be able to carry a null matrix_id — no non-null assertion
  // or thrown refusal keyed on matrixId being absent
  assert.doesNotMatch(order, /if \(!matrixId\)/);
});

// ─── the INSERT itself ──────────────────────────────────────────────────────

function orderInsert(): string {
  const m = /`(INSERT INTO site\.donations[^`\\]*)`/.exec(order);
  assert.ok(m?.[1], "no `INSERT INTO site.donations` literal found in the order route");
  return m[1].trim();
}

test("the insert writes provider='paypal', status='pending', a fresh external_id, and never touches stripe_session_id", () => {
  const sql = orderInsert();
  const cols = /\(([^)]*)\)\s*VALUES/i.exec(sql)?.[1] ?? "";
  const colList = cols.split(",").map((c) => c.trim());
  assert.ok(colList.length > 3, "vacuity anchor: the column list did not parse");
  assert.ok(colList.includes("provider"), "must write a provider column");
  assert.ok(colList.includes("external_id"), "must write external_id — the UNIQUE (provider, external_id) constraint protects nothing without it");
  assert.ok(colList.includes("status"), "must write status explicitly — the table default is 'completed', wrong for an unconfirmed PayPal order");
  assert.ok(!colList.includes("stripe_session_id"), "must NOT set stripe_session_id — this is a PayPal row, and the column is nullable since v124");
  assert.match(sql, /VALUES\s*\(\s*'paypal'/, "provider must be the literal 'paypal'");
  assert.match(sql, /'pending'/, "status must be the literal 'pending'");
  assert.match(order, /crypto\.randomUUID\(\)/, "external_id must be a freshly generated uuid");
});

test("the pending row is written before PayPal is called, and nothing else writes payment state", () => {
  // Only ONE query against site.donations may appear in this route — a second
  // write (a status flip, a grant, an alert-firing update) would be state the
  // webhook, not this route, is supposed to own.
  const hits = order.match(/site\.donations/g) ?? [];
  assert.equal(hits.length, 1, `expected exactly one reference to site.donations, found ${hits.length}`);
  assert.doesNotMatch(order, /support_events|takeHome|broadcastChatEvent|fireStreamEffects/, "this route must not grant, total, or alert — that's the webhook's job");
});

// ─── buyer-facing wording: "tip", never "donation" ─────────────────────────

test("every Response body string says tip, never donation", () => {
  const bodies = [...order.matchAll(/new Response\(\s*(`[^`]*`|"[^"]*")/g)]
    .map((m) => m[1])
    .filter((s): s is string => typeof s === "string");
  assert.ok(bodies.length >= 2, "expected at least the 503 and one 4xx body");
  for (const b of bodies) {
    assert.doesNotMatch(b.toLowerCase(), /donation/, `buyer-facing string uses "donation": ${b}`);
  }
});

// ─── direct unit tests of the extracted rule helpers the route depends on ──
// (route.ts itself can't be executed — see header — so these pin the REAL
// behavior of the functions it calls, with the actual values this route's
// bounds admit: $1.00 .. $1,000.00.)

test("donationTtsChars gives the same tier boundaries the order route's bounds allow", () => {
  assert.equal(donationTtsChars(1), 50);
  assert.equal(donationTtsChars(5), 150);
  assert.equal(donationTtsChars(10), 300);
  assert.equal(donationTtsChars(25), 500);
  assert.equal(donationTtsChars(1000), 500);
});

test("sanitizeChatMessage at maxMessage + 1 lets an overflow be SEEN as over, never silently cut to look exact", () => {
  // top tier: maxMessage = 500. A 600-char message sanitized at the flat
  // default (500) would come back exactly 500 chars — indistinguishable from
  // a message that was always 500 — and `rawMsg.length > maxMessage` (500)
  // could then never fire. Sanitized at maxMessage + 1 (501) it comes back
  // 501 chars, which IS > 500, so the route correctly rejects it.
  const maxMessage = donationTtsChars(25); // 500, the top tier
  const overflow = "z".repeat(600);
  const atFlatDefault = sanitizeChatMessage(overflow); // the bug this pins against
  const atLimitPlusOne = sanitizeChatMessage(overflow, maxMessage + 1);
  assert.equal(atFlatDefault.length, 500, "sanity: the flat default is 500");
  assert.equal(atFlatDefault.length > maxMessage, false, "the bug: a flat-500 sanitize can never read as over a 500 cap");
  assert.equal(atLimitPlusOne.length, 501);
  assert.equal(atLimitPlusOne.length > maxMessage, true, "the fix: +1 lets the overflow be measured as over");
});

test("sanitizeDisplayName strips invisibles and caps at 32 — what the route hands to the overlay", () => {
  assert.equal(sanitizeDisplayName("  a   b  "), "a b");
  assert.equal(sanitizeDisplayName("x".repeat(400)).length, 32);
});

// ─── Piece 2: purpose "points" — a quiet Qorm purchase ───────────────────────

const pointsBranch = (() => {
  const start = order.indexOf('purpose === "points"');
  assert.ok(start >= 0, 'no `purpose === "points"` branch in order/route.ts');
  // the branch runs to its own `return Response.json(` — the only response it can succeed with
  const end = order.indexOf("return Response.json(", start);
  assert.ok(end > start, "points branch has no success return");
  return order.slice(start, end + "return Response.json(".length);
})();

test("points: an unknown purpose is refused, and an absent one still means a tip", () => {
  assert.match(order, /purpose\s*!==\s*"tip"\s*&&\s*purpose\s*!==\s*"points"|!\["tip",\s*"points"\]\.includes/, "an unknown purpose must 400, not silently become a tip");
  // The default lives in orderPurpose (absent → tip), which paypalPointsOrder.test.ts pins;
  // here, only that the route goes through it.
  assert.match(order, /const purpose = orderPurpose\(body\?\.purpose\);/, "absent purpose must default to tip — live tips send no purpose");
});

test("the pressed button (fundingSource) is read through orderFundingSource, refused when unknown, and reaches BOTH order paths", () => {
  assert.match(order, /const fundingSource = orderFundingSource\(body\?\.fundingSource\);/, "the route must read the button through the one helper");
  assert.match(order, /if \(!fundingSource\) return new Response\("Bad funding source", \{ status: 400 \}\);/, "an unknown funding source must 400, not become a PayPal order");
  assert.match(pointsBranch, /pointsOrders\.open\(\{ matrixId: buyer, cents, fundingSource \}\)/, "a points purchase must carry the button");
  assert.match(order, /createPaypalOrder\(\{ amountUsd: cents \/ 100, customId: externalId, fundingSource \}\)/, "a tip must carry the button");
  assert.ok(order.indexOf("orderFundingSource(") < order.indexOf("isPaypalOrderLimited("), "the refusal is an input refusal: before the throttle");
});

test("points: bounds are the shared range — the same check as a tip, never literals", () => {
  assert.doesNotMatch(pointsBranch, /COIN_M(IN|AX)_PURCHASE/, "the purchase-only range is gone");
  assert.doesNotMatch(pointsBranch, /cents\s*<\s*\d|cents\s*>\s*\d/, "a literal bound in the points branch is a second copy");
});

test("points: signed-out → 401, refused before the throttle, the row and PayPal", () => {
  const i401 = pointsBranch.indexOf("status: 401");
  assert.ok(i401 >= 0, "the points branch must 401 a signed-out caller");
  const iLimit = pointsBranch.indexOf("isPaypalOrderLimited(");
  const iOpen = pointsBranch.indexOf("pointsOrders.open(");
  assert.ok(iLimit > i401, "throttle must come after the sign-in refusal");
  assert.ok(iOpen > iLimit, "the order must open only after the throttle");
});

test("points: never writes donations, never reads a message or a name", () => {
  assert.doesNotMatch(pointsBranch, /site\.donations/);
  assert.doesNotMatch(pointsBranch, /INSERT/);
  assert.doesNotMatch(pointsBranch, /displayName|message|anonymous/);
});
