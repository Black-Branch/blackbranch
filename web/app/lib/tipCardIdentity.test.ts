// A tip card wears the tipper's account — badges, picture, name colour and style, the user-card
// click — only when the name on it IS the account's own (the box left as prefilled, or blank).
// A typed name that differs gives a PLAIN card, so a joke or private name is not given away by
// identical styling. The money record keeps the payer (payerMatrixId → the ledger and the row).
//
// Run: node --test app/lib/tipCardIdentity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceText.mjs";
import { tipCardIdentity, tipWearsIdentity, persistedTipWearsAccount } from "./tipCardIdentity.ts";

const ME = "@casey:site.test";
const LOOK = { username: "Casey", usernameColor: "#ff8800", usernameStyle: { font: "pixel" } };

test("blank / own name: the card wears the account", () => {
  for (const shownName of ["Casey", "", null]) {
    const c = tipCardIdentity({ anonymous: false, matrixId: ME, shownName, identity: LOOK });
    assert.equal(c.donor, "Casey");
    assert.equal(c.donorMatrixId, ME);
    assert.equal(c.tipIdentity, "account");
    assert.equal(c.usernameColor, "#ff8800");
    assert.deepEqual(c.usernameStyle, { font: "pixel" });
    assert.equal(c.payerMatrixId, null);
  }
});

test("typed name: the card is plain — the typed name, no account, no colour, no style; the payer rides apart", () => {
  const c = tipCardIdentity({ anonymous: false, matrixId: ME, shownName: "Your Mom", identity: LOOK });
  assert.deepEqual(c, {
    donor: "Your Mom", donorMatrixId: null, payerMatrixId: ME, tipIdentity: "plain",
    anonymous: false, usernameColor: null, usernameStyle: null,
  });
});

test("anonymous: Anonymous, no account and no payer on the card payload — as before", () => {
  const c = tipCardIdentity({ anonymous: true, matrixId: ME, shownName: "Your Mom", identity: LOOK });
  assert.deepEqual(c, {
    donor: "Anonymous", donorMatrixId: null, payerMatrixId: null, tipIdentity: "plain",
    anonymous: true, usernameColor: null, usernameStyle: null,
  });
});

test("a guest (no account): the typed name, plain", () => {
  const c = tipCardIdentity({ anonymous: false, matrixId: null, shownName: "Gadget Fan", identity: null });
  assert.equal(c.donor, "Gadget Fan");
  assert.equal(c.donorMatrixId, null);
  assert.equal(c.payerMatrixId, null);
  assert.equal(c.tipIdentity, "plain");
  assert.equal(tipCardIdentity({ anonymous: false, matrixId: null, shownName: "", identity: null }).donor, "Anonymous");
});

test("a rename between checkout and payment, or a failed lookup, fails toward plain — never toward the account", () => {
  // The lookup degrades to the localpart when it fails (chatIdentity.ts); the stored name no longer matches.
  const failed = { username: "casey", usernameColor: null, usernameStyle: null };
  assert.equal(tipCardIdentity({ anonymous: false, matrixId: ME, shownName: "Casey", identity: failed }).tipIdentity, "plain");
  assert.equal(tipWearsIdentity({ anonymous: false, matrixId: ME, shownName: "Old Name", accountName: "New Name" }), false);
  // No identity at all for a signed-in tipper: nothing to wear.
  assert.equal(tipCardIdentity({ anonymous: false, matrixId: ME, shownName: "", identity: null }).tipIdentity, "plain");
});

test("read-back: a recorded choice wins over the account's name now", () => {
  const acct = { matrixId: ME, accountName: "Renamed" };
  assert.equal(persistedTipWearsAccount({ username: "Casey", tipIdentity: "account" }, acct), true, "a rename must not strip an account tip");
  assert.equal(persistedTipWearsAccount({ username: "Renamed", tipIdentity: "plain" }, acct), false);
  assert.equal(persistedTipWearsAccount({ username: "Casey", tipIdentity: "account", anonymous: true }, acct), false);
  assert.equal(persistedTipWearsAccount({ username: "Casey", tipIdentity: "account" }, { matrixId: null, accountName: null }), false);
});

test("read-back: a card from before the choice was recorded takes the same rule against the account's name now", () => {
  assert.equal(persistedTipWearsAccount({ username: "Your Mom" }, { matrixId: ME, accountName: "Casey" }), false);
  assert.equal(persistedTipWearsAccount({ username: "Casey" }, { matrixId: ME, accountName: "Casey" }), true);
  // No display name: history's name is the full matrix id, the card's the localpart.
  assert.equal(persistedTipWearsAccount({ username: "casey" }, { matrixId: ME, accountName: ME }), true);
  assert.equal(persistedTipWearsAccount({ username: "" }, { matrixId: ME, accountName: "Casey" }), true, "a blank name was the account's");
});

// Both money paths that announce a tip build its identity with the ONE helper — a second copy is
// how the PayPal path once shipped a round without the name rule (vault billing.md).
test("wiring: the Stripe webhook and the PayPal handlers both build the tip card with tipCardIdentity", () => {
  const files = ["../api/billing/webhook/route.ts", "./paypalWebhookHandlers.ts"];
  for (const f of files) {
    const raw = readFileSync(new URL(f, import.meta.url), "utf8");
    const src = stripComments(raw);
    const last = raw.trimEnd().split("\n").slice(-1)[0]!.trim();
    assert.ok(last.length > 0 && src.trimEnd().endsWith(last), `${f}: the scan lost the end of the file`);
    assert.match(src, /import \{[^}]*\btipCardIdentity\b[^}]*\} from "[^"]*tipCardIdentity(\.ts)?"/, `${f} does not import tipCardIdentity`);
    assert.match(src, /kind: "donation",[\s\S]{0,400}\.\.\.tipCardIdentity\(/, `${f} does not spread tipCardIdentity into the donation card`);
    assert.doesNotMatch(src, /donorMatrixId:/, `${f} sets donorMatrixId by hand`);
  }
});
