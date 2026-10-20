// Tests for the link-label phishing guard.
//
// The logic lives in linkGuard.ts rather than renderText.tsx because the
// runner only globs `app/**/*.test.ts` — inside the .tsx it would be
// untestable.
//
// Run: node --test app/lib/linkGuard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { deceptiveLinkHost } from "./linkGuard.ts";

test("the attack it exists to stop", () => {
  assert.equal(
    deceptiveLinkHost("paypal.com", "https://evil.com/login"),
    "evil.com",
    "a label naming another domain must surface the real destination"
  );
});

test("honest labels stay clean", () => {
  // Same host, parent, subdomain, and www-normalized all count as honest.
  const honest: [string, string][] = [
    ["example.com", "https://example.com/x"],
    ["example.com", "https://www.example.com/x"],
    ["www.example.com", "https://example.com/x"],
    ["example.com", "https://docs.example.com/x"],
    ["docs.example.com", "https://example.com/x"],
  ];
  for (const [label, href] of honest) {
    assert.equal(deceptiveLinkHost(label, href), null, `false alarm on ${label} → ${href}`);
  }
});

test("labels making no domain claim are never flagged", () => {
  for (const label of ["here", "this link", "click me", "Horse.", "", "read more…"]) {
    assert.equal(
      deceptiveLinkHost(label, "https://evil.com"),
      null,
      `flagged a label that claims no domain: ${JSON.stringify(label)}`
    );
  }
});

test("an unparseable href is not flagged", () => {
  assert.equal(deceptiveLinkHost("paypal.com", "not a url"), null);
});

// ─── the @handle carve-out ────────────────────────────────────────────────────

test("Bluesky handles are handles, not destination claims", () => {
  // REAL rows from our own Synapse (bridged Bluesky embeds). Bluesky handles are
  // literally domains, so without the @ carve-out every one of these would paint a
  // phishing warning on ordinary, honest content.
  const real: [string, string][] = [
    ["midwest emo fan (@natalie.sh)", "https://bsky.app/profile/natalie.sh/post/3m5hh5rnqwk2v"],
    ["wukko (@wukko.me)", "https://bsky.app/profile/did:plc:kqbbf4ln3yekk7vn5stjz3ys"],
  ];
  for (const [label, href] of real) {
    assert.equal(
      deceptiveLinkHost(label, href),
      null,
      `warned on a legitimate Bluesky handle: ${label}`
    );
  }
});

test("an email-shaped label is NOT a handle — the canonical phishing string", () => {
  // REGRESSION GUARD. A first cut skipped any claim preceded by "@", which
  // silently disabled the guard on the most natural phishing label there is. It
  // was also a regression against the pre-extraction behaviour (\b matched across
  // "@"), and because renderText shares this module it applied to ordinary
  // markdown links too. Caught by security review, not by me.
  for (const label of ["security@paypal.com", "support@paypal.com", "no-reply@paypal.com"]) {
    assert.equal(
      deceptiveLinkHost(label, "https://evil.example/login"),
      "evil.example",
      `the guard was suppressed by an email-shaped label: ${label}`
    );
  }
});

test("a bare @domain is still checked — only PARENTHESIZED handles are exempt", () => {
  assert.equal(deceptiveLinkHost("@paypal.com", "https://evil.example"), "evil.example");
  assert.equal(deceptiveLinkHost("(@paypal.com", "https://evil.example"), "evil.example",
    "an unclosed paren must not be enough");
});

test("the carve-out does not become a bypass", () => {
  // An @-prefixed handle must not launder a SECOND, un-prefixed domain claim in
  // the same label — otherwise "@ok.social paypal.com" is a free pass.
  assert.equal(
    deceptiveLinkHost("@ok.social paypal.com", "https://evil.com"),
    "evil.com",
    "an un-prefixed claim after a handle must still be checked"
  );
});

test("an honest claim does not shield a dishonest one", () => {
  // Returning on the FIRST match would clear this label on "evil.com" alone.
  assert.equal(
    deceptiveLinkHost("evil.com — actually paypal.com", "https://evil.com"),
    "evil.com",
    "every domain claim in the label must be checked, not just the first"
  );
});

// ─── regression traps ─────────────────────────────────────────────────────────

test("the /g/ regex does not leak lastIndex between calls", () => {
  // A module-level /g/ regex carries lastIndex across .exec() runs, so every other
  // call silently returns the wrong answer. This pins the explicit reset.
  for (let i = 0; i < 6; i++) {
    assert.equal(deceptiveLinkHost("paypal.com", "https://evil.com"), "evil.com", `flipped on call ${i}`);
    assert.equal(deceptiveLinkHost("here", "https://evil.com"), null, `false positive on call ${i}`);
  }
});

test("real bridged labels from our rooms behave", () => {
  // Twitter/X display names carry @handles with no dot → no claim at all.
  assert.equal(deceptiveLinkHost("Dylan Burns 🦀 (@DylanBurns1776)", "https://twitter.com/DylanBurns1776"), null);
  assert.equal(deceptiveLinkHost("Lindsey Graham (@LindseyGrahamSC)", "https://x.com/LindseyGrahamSC/status/1"), null);
  // A truncated URL used as its own label is honest.
  assert.equal(
    deceptiveLinkHost("www.micahbird.com/p/how-to-fix...", "https://www.micahbird.com/p/how-to-fix-webrtc/"),
    null
  );
  // Archive links genuinely go somewhere other than the outlet they name — worth surfacing.
  assert.equal(deceptiveLinkHost("nytimes.com", "https://archive.ph/abc"), "archive.ph");
});
