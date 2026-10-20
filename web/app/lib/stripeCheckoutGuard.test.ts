// The money surfaces must never hand a raw Stripe promise to Stripe's own
// provider. <EmbeddedCheckoutProvider> does `stripePromise.then(…)` with NO
// `.catch`, so a failed js.stripe.com load leaves its internal
// embeddedCheckout null forever and <EmbeddedCheckout> renders a bare empty
// <div> — a viewer presses Donate and gets a blank box with no error and no
// spinner. Every flow shares the shape: donation, subscription and gift
// (SupportContent), the store, and the standalone /donate tip page.
//
// Run: node --test app/lib/stripeCheckoutGuard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const FILES = {
  SupportContent: "app/components/SupportContent.tsx",
  StoreContent: "app/features/store/StoreContent.tsx",
  DonateClient: "app/donate/DonateClient.tsx",
};

const src = (p: string) => stripComments(readFileSync(p, "utf8"));

for (const [name, path] of Object.entries(FILES)) {
  test(`${name} consumes Stripe through useStripe, never getStripePromise`, () => {
    const s = src(path);
    assert.match(s, /useStripe\(\)/, "must call the observing hook");
    assert.doesNotMatch(
      s,
      /getStripePromise/,
      "a raw promise here lets the rejection escape unhandled and the box render empty",
    );
  });

  test(`${name} renders a failure state and a retry, not a silent empty box`, () => {
    const s = src(path);
    assert.match(s, /StripeUnavailable/, "the failure branch must render the message component");
    assert.match(s, /retry=\{retryStripe\}|onRetry=\{retryStripe\}/, "the message must be able to retry");
  });

  test(`${name} mounts EmbeddedCheckoutProvider only with a RESOLVED stripe`, () => {
    const s = src(path);
    // `stripe={stripe}` is the resolved instance from the hook. `stripe={stripePromise}`
    // (or any …Promise identifier) is the defect: parseStripeProp takes the async
    // branch, whose .then has no .catch.
    const mounts = [...s.matchAll(/<EmbeddedCheckoutProvider\s+stripe=\{(\w+)\}/g)].map((m) => m[1]);
    assert.equal(mounts.length, 1, "exactly one provider mount expected");
    assert.equal(mounts[0], "stripe", "must pass the resolved instance, not a promise");
  });
}

// ── Vacuity anchors, at the END of the file ────────────────────────────────
// Every assertion above is a scan over a file read at runtime. If a path were
// renamed, readFileSync would throw — but a file that merely lost the code
// under test would make the doesNotMatch assertions pass over a hole.
test("the scanned files exist and still mount Stripe's embedded checkout", () => {
  for (const [name, path] of Object.entries(FILES)) {
    const s = src(path);
    assert.ok(s.length > 2000, `${path} is implausibly small — did the scan read the right file?`);
    assert.match(s, /EmbeddedCheckoutProvider/, `${name} no longer mounts embedded checkout at all`);
    assert.match(s, /view === "checkout"/, `${name} lost its checkout view`);
  }
});

test("stripComments really removed comments — a prose mention must not count", () => {
  // getStripePromise is named in a COMMENT in both files. Without stripping,
  // the doesNotMatch assertions above would fail; if stripComments silently
  // became a no-op, they would fail loudly rather than pass vacuously — this
  // pins the direction.
  const raw = readFileSync(FILES.SupportContent, "utf8");
  assert.match(raw, /silent empty box/, "the raw file should carry the script-load comment");
  assert.doesNotMatch(src(FILES.SupportContent), /silent empty box/, "stripComments is not stripping");
});
