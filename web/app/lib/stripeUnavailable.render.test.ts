// The message a viewer sees when js.stripe.com never loaded.
//
// Run: node --test app/lib/stripeUnavailable.render.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Static, and BEFORE the component import: registers the resolver that lets a
// .tsx specifier load at all (iconRail.render.test.ts's header explains why).
import "./testTsx.ts";
const { default: StripeUnavailable } = await import("../components/StripeUnavailable.tsx");

const render = (retrying: boolean) =>
  renderToStaticMarkup(createElement(StripeUnavailable, { onRetry: () => {}, retrying }));

test("it says a payment form failed and that nothing was charged", () => {
  // The whole point: a blank box leaves the viewer to guess.
  const html = render(false);
  assert.match(html, /couldn’t load the secure payment form/i);
  assert.match(html, /Nothing has been charged/i);
});

test("it names the blocked address, so the viewer can allow it", () => {
  // The cause is almost always on their side — a blocker or a DNS filter — so
  // the remedy has to be actionable by them, not by us.
  assert.match(render(false), /js\.stripe\.com/);
});

test("idle state offers a live Try again button", () => {
  const html = render(false);
  assert.match(html, /type="button"/);
  assert.match(html, /Try again/);
  // The ATTRIBUTE, not the `disabled:opacity-60` Tailwind class that is on the
  // button in both states — a bare /disabled/ matches that class and can never fail.
  assert.doesNotMatch(html, /\sdisabled=""/);
});

test("retrying disables the button and says so", () => {
  // Without this the button looks idle while a retry is in flight and a viewer
  // mashes it — and a blocked request fails fast enough that they would.
  const html = render(true);
  assert.match(html, /\sdisabled=""/);
  assert.match(html, /Trying/);
  assert.doesNotMatch(html, />Try again</);
});

// Vacuity anchor at the END: the two renders above must actually differ, or
// every assertion could be passing over one unchanging blob of markup.
test("the two states really render different markup", () => {
  assert.notEqual(render(false), render(true));
});
