// Static guards on the spend routes' use of the price table.
//
// Run: node --test --experimental-strip-types app/lib/storeSpendGuard.test.ts
//
// WHY STATIC. priceGuard's decision is tested behaviourally in
// storePricing.test.ts. What cannot be tested that way is whether a route
// actually CALLS it, and calls it before it debits — a route handler cannot be
// invoked here (it imports through the "@/" alias, which has no resolver
// outside the bundler). That gap is a mechanism with green tests and nothing
// wiring it up. So the wiring is pinned as source text.
//
// When a route starts charging a store price, add it to ROUTES below. A route
// missing from this list is unguarded and nothing else will say so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

// Fixed-price routes: the charge is a number the viewer was SHOWN, so every
// one of these must run priceGuard before it debits.
const ROUTES = [
  { path: ["app", "api", "points", "spend", "sticker", "route.ts"], lookup: /getPrice\(\s*"sticker"\s*\)/ },
  { path: ["app", "api", "badges", "buy-slot", "route.ts"], lookup: /getPrice\(\s*"badge_slot"\s*\)/ },
  // Two products on one route. The regex demands both keys in source order,
  // which is why the handler reads them as separate literal calls rather than
  // getPrice(mode) — a variable lookup is invisible to a static guard, and a
  // static guard is the only thing that can prove a route CALLS priceGuard.
  { path: ["app", "api", "chat", "send", "route.ts"],
    lookup: /getPrice\(\s*"highlight"\s*\)[\s\S]*getPrice\(\s*"tts"\s*\)/ },
];

// Routes whose price legitimately lives in their OWN table rather than
// site.store_prices (badge unlock_criteria; style catalog + style_prices
// override) — but which are admin-repriceable live all the same, so the
// shown-vs-charged guard applies identically: without it the store's two-step
// confirm could show one number and charge another.
const OWN_TABLE_ROUTES = [
  { path: ["app", "api", "badges", "buy", "route.ts"], lookup: /unlock_criteria/ },
  { path: ["app", "api", "points", "spend", "style", "route.ts"], lookup: /site\.style_prices/ },
];

// FLOOR routes are deliberately absent from ROUTES. A sticker boost charges
// the amount the VIEWER chose, so there is no price to disagree about and
// priceGuard does not apply — but the floor itself still has to come from the
// table, which is what this asserts. (Cheers are two fixed prices, so
// chat/send is in ROUTES.)
const FLOOR_ROUTES = [
  { path: ["app", "api", "points", "spend", "sticker-boost", "route.ts"], lookup: /getPrice\(\s*"sticker_boost"\s*\)/ },
];

function read(parts: string[]): string {
  // Comments stripped first: this file's own explanations name priceGuard and
  // the constants it replaced, and a naive text match would pass on prose.
  return stripComments(readFileSync(join(process.cwd(), ...parts), "utf8"));
}

for (const route of ROUTES) {
  const name = route.path.slice(2, -1).join("/");

  test(`${name}: charges the price from the table, not a constant`, () => {
    const src = read(route.path);
    assert.match(src, /from "@\/app\/lib\/storePricingServer"/,
      "the route must read its price from site.store_prices");
    assert.match(src, route.lookup, "the route must look up its own price row");
    assert.doesNotMatch(src, /_PRICE\b/,
      "a *_PRICE constant in a spend route is a price nobody can change between streams");
  });

  test(`${name}: runs priceGuard, and runs it before any debit`, () => {
    const src = read(route.path);
    const guard = src.indexOf("priceGuard(");
    const debit = src.indexOf("debitCoins(");
    assert.ok(guard > 0, "the route must call priceGuard");
    assert.ok(debit > 0, "expected a debit in a spend route");
    assert.ok(guard < debit,
      "priceGuard must run BEFORE the debit — guarding after the charge guards nothing");
  });

  test(`${name}: refuses the spend on a guard failure instead of falling through`, () => {
    const src = read(route.path);
    // The failure branch has to RETURN. An if that logged and continued would
    // leave the debit below it reachable at the wrong price.
    assert.match(
      src,
      /if \(!guard\.ok\) \{\s*return Response\.json\([^)]*\{ status: guard\.status \}\s*\);/,
      "the !guard.ok branch must return the guard's status, not fall through to the debit"
    );
  });

  test(`${name}: a refused spend cannot arm the cooldown`, () => {
    const src = read(route.path);
    const guard = src.indexOf("priceGuard(");
    const arm = src.indexOf(".arm(");
    if (arm < 0) return; // not every spend route is throttled
    assert.ok(guard < arm,
      "a spend refused for its price must not leave the viewer waiting out a cooldown");
  });
}

// ── chat/send sends the identity field EACH KIND'S CARD BRANCH reads ────────
//
// A separate regression from priceGuard above. alert.js's cheer/highlight card
// branch destructures cheererMatrixId; tts_msg has its OWN branch,
// destructuring senderMatrixId — a different name, inherited from the
// sticker/sound family it was built alongside. Sending one name for both
// silently drops the spender's identity for whichever kind doesn't read it: a
// read-aloud card with no badges/avatar/user-card, or a persisted
// site.chat_messages row with matrix_id NULL for a highlight. The route
// branches on `mode` to send the right name; this pins that it keeps doing so.
//
// WHY STATIC, same reasoning as priceGuard's header above: chat/send imports
// through the "@/" alias, which node --test cannot resolve outside the
// bundler, so the route cannot be invoked here — only read as source text.
//
// read() strips comments before matching, and that is load-bearing here in
// a way it usually isn't: this route's OWN comment, sitting right above the
// real code, names both field names in prose to explain the branch. Matching
// against raw source would let that prose alone satisfy "the file contains
// both names" even if the code beneath it regressed to sending one name
// unconditionally — stripping the prose is exactly what makes the assertion
// below fail red on reverted code and pass on the real one; a raw-source
// version of the same regex does not.
test("chat/send: sends the identity field each kind's own card branch reads, not one name for both", () => {
  const src = read(["app", "api", "chat", "send", "route.ts"]);
  assert.match(src, /cheererMatrixId/,
    "the highlight branch needs cheererMatrixId — alert.js's cheer/highlight card branch destructures that name");
  assert.match(src, /senderMatrixId/,
    "the tts branch needs senderMatrixId — alert.js's tts_msg card branch destructures that name, not cheererMatrixId");
  // Mode-conditional, not both unconditional: the two names must sit on
  // opposite arms of a `mode === "highlight"` ternary — not as two sibling
  // properties sent in the same unconditional object, and not each guarded by
  // a DIFFERENT condition that could both be true or both be false.
  assert.match(
    src,
    /mode === "highlight"\s*\?\s*\{[^}]*cheererMatrixId[^}]*\}\s*:\s*\{[^}]*senderMatrixId[^}]*\}/,
    "cheererMatrixId and senderMatrixId must be mode-conditional (one per ternary arm), not both sent unconditionally"
  );
});

for (const route of OWN_TABLE_ROUTES) {
  const name = route.path.slice(2, -1).join("/");

  test(`${name}: charges the price from its own table`, () => {
    const src = read(route.path);
    assert.match(src, route.lookup, "the route must look up its own price source");
    assert.doesNotMatch(src, /_PRICE\b/,
      "a *_PRICE constant in a spend route is a price nobody can change between streams");
  });

  test(`${name}: runs priceGuard, and runs it before any debit`, () => {
    const src = read(route.path);
    const guard = src.indexOf("priceGuard(");
    const debit = src.indexOf("debitCoins(");
    assert.ok(guard > 0, "the route must call priceGuard — these two shipped without it once already");
    assert.ok(debit > 0, "expected a debit in a spend route");
    assert.ok(guard < debit,
      "priceGuard must run BEFORE the debit — guarding after the charge guards nothing");
  });

  test(`${name}: refuses the spend on a guard failure instead of falling through`, () => {
    const src = read(route.path);
    assert.match(
      src,
      /if \(!guard\.ok\) \{\s*return Response\.json\([^)]*\{ status: guard\.status \}\s*\);/,
      "the !guard.ok branch must return the guard's status, not fall through to the debit"
    );
  });
}

for (const route of FLOOR_ROUTES) {
  const name = route.path.slice(2, -1).join("/");

  test(`${name}: takes its floor from the table, not a constant`, () => {
    const src = read(route.path);
    assert.match(src, route.lookup, "the floor must come from site.store_prices");
  });

  test(`${name}: refuses rather than falling back when the floor is unknown`, () => {
    const src = read(route.path);
    // A missing floor must not silently become "any amount is fine" — that is
    // the same class of bug as charging a price nobody saw.
    assert.match(src, /price_unavailable/,
      "an unknown floor must refuse the spend, not default it");
  });
}

// ── A refund must return exactly what the debit took ────────────────────────

// THE HAZARD DYNAMIC PRICING INTRODUCES. With a constant price, a debit and its
// refund cannot disagree. With a price read per request, a refund that RE-READ
// the price instead of reusing the charged value would pay back whatever the
// store costs at refund time — silently short-changing anyone whose spend
// failed across a recompute. Every spend route must hold the amount in one
// variable and use that variable for both.
for (const route of [...ROUTES, ...FLOOR_ROUTES]) {
  const name = route.path.slice(2, -1).join("/");

  test(`${name}: every refund returns the same amount the debit took`, () => {
    const src = read(route.path);
    const debit = /debitCoins\(\{[^}]*?amount: ([a-zA-Z_][a-zA-Z0-9_]*)/.exec(src);
    // chat/send's single debitCoins call serves the highlight/tts spend and
    // the fixed-price cheers — it matches this pattern too.
    if (!debit) return;
    const charged = debit[1];
    const refunds = [...src.matchAll(/refundCoins\(\{[^}]*?amount: ([a-zA-Z_][a-zA-Z0-9_]*)/g)];
    assert.ok(refunds.length > 0, "a spend route with no refund path cannot undo a failure");
    for (const r of refunds) {
      assert.equal(r[1], charged,
        `refund pays back \`${r[1]}\` but the debit took \`${charged}\` — a recompute between the two would short the viewer`);
    }
  });
}

// ── The seed and the renderer must agree ────────────────────────────────────

test("the recompute route is admin-gated and refuses before doing anything", () => {
  const src = read(["app", "api", "store", "prices", "recompute", "route.ts"]);
  assert.match(src, /requireAdmin\(\)/, "setting E changes what everyone is charged");
  const gate = src.indexOf("requireAdmin(");
  const work = Math.min(
    ...["previewRecompute(", "recomputeStorePrices("].map((s) => {
      const i = src.indexOf(s);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    })
  );
  assert.ok(gate < work, "the admin check must precede any pricing work");
});

test("the recompute route only writes when apply is EXPLICITLY true", () => {
  // A truthy check would make `apply: "no"` a live repricing. The dry run is
  // the whole safety property of this route; it must be the default.
  const src = read(["app", "api", "store", "prices", "recompute", "route.ts"]);
  assert.match(src, /apply\s*=\s*\(body[^)]*\)\?\.apply === true/,
    "apply must be an identity check against true, not a truthy test");
  assert.match(src, /apply\s*\n?\s*\?\s*await storePricing\.recomputeStorePrices\(e\)\s*\n?\s*:\s*await storePricing\.previewRecompute\(e\)/,
    "the non-apply path must preview, never write");
});

test("the recompute route bounds E instead of accepting any positive number", () => {
  const src = read(["app", "api", "store", "prices", "recompute", "route.ts"]);
  assert.match(src, /e < 5 \|\| e > 500/,
    "an unbounded E turns a typo into a store-wide repricing");
});
