// "No unique username for donations from re-named users (it ruins the joke sometimes)."
//
// A signed-in tipper can type any name into the tip page's name box. The live card
// carried it (stream-api buildEventCard: username = the donor name the webhook sends),
// but chat HISTORY — every page load, every viewer who arrived later, the chat after a
// restart — replaced it with the account's live name, COALESCE(display_name, matrix_id).
// Measured on the code before this fix:
//   typed "Your Mom", account display name "Casey"  → history showed "Casey"
//   typed "Your Mom", account with no display name  → history showed "@casey:site.test",
//                                                     which the row renders as "casey" —
//                                                     the unique username
// After: "Your Mom" in both, live and read back. Anonymous stays Anonymous.
//
// Run: node --test app/lib/eventCardName.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceText.mjs";
import { eventCardName, liveCardActor, historyCardFields } from "./eventCardName.ts";
import { normalizeUsername } from "./chatMsg.ts";

const ME = "@casey:site.test";

/** The live donation card stream-api broadcasts (alert.js buildEventCard, kind donation). */
const liveTip = (donor: string, anonymous = false) => ({
  system: "donation", username: anonymous ? "Anonymous" : donor, donorMatrixId: anonymous ? null : ME,
  matrixId: anonymous ? null : ME, anonymous, amount: 500, currency: "usd", message: "",
  usernameColor: "#ff8800", usernameStyle: null,
});

/** The history row for that card: matrix_id is what persistEventCard stored, username the account's live name. */
const historyRow = (displayName: string | null, anonymous = false) => ({
  matrix_id: anonymous ? null : ME,
  username: anonymous ? null : (displayName ?? ME),
  username_color: "#ff8800",
  username_style: null,
});

/** What a viewer reads on the row: the shown name as the chat row renders it. */
const shown = (card: { username: string }, actor: { username?: string }) => normalizeUsername(actor.username ?? card.username);

test("original path: the live tip card carries the typed name", () => {
  assert.equal(normalizeUsername(liveTip("Your Mom").username), "Your Mom");
});

test("restart: read back from history, a typed tip name stays — over the account's display name", () => {
  const card = liveTip("Your Mom");
  assert.equal(shown(card, liveCardActor("donation", card, historyRow("Casey"))), "Your Mom",
    "history replaced the typed tip name with the account's display name");
});

test("restart: read back from history, a typed tip name stays — never the unique username", () => {
  const card = liveTip("Your Mom");
  const name = shown(card, liveCardActor("donation", card, historyRow(null)));
  assert.notEqual(name, "casey", "history showed the unique username on a tip given under another name");
  assert.equal(name, "Your Mom");
});

test("retry: the live card and the history read of the same tip show the same name", () => {
  for (const display of ["Casey", null]) {
    const card = liveTip("Your Mom");
    const live = normalizeUsername(card.username);
    const back = shown(card, liveCardActor("donation", card, historyRow(display)));
    assert.equal(back, live, `the name changed between the live card and the read-back (display name ${display})`);
  }
});

test("Anonymous stays Anonymous, with no account behind it", () => {
  const card = liveTip("Your Mom", true);
  const actor = liveCardActor("donation", card, historyRow(null, true));
  assert.deepEqual(actor, {}, "an anonymous tip read back gained an identity");
  assert.equal(shown(card, actor), "Anonymous");
});

test("a tip under the account's own name still wears it: badges key, colour and style are live", () => {
  const actor = liveCardActor("donation", liveTip("Casey"), { ...historyRow("Casey"), username_color: "#00ff00" });
  assert.equal(actor.matrixId, ME);
  assert.equal(actor.usernameColor, "#00ff00");
  // Recorded as the account's: a later rename keeps it dressed.
  const recorded = liveCardActor("donation", { ...liveTip("Casey"), tipIdentity: "account" }, historyRow("Renamed"));
  assert.equal(recorded.matrixId, ME);
});

// ADR 0145 — a typed name that is not the account's reads back PLAIN, whatever the row's
// matrix_id (kept for the money record and a moderator's reach) and whatever an older card's
// event_json carried (cards before the fix stored the account's id, colour and style on them).
const IDENTITY_KEYS = ["matrixId", "donorMatrixId", "payerMatrixId", "canonicalId", "publicId", "usernameColor", "usernameStyle"];
function assertPlain(obj: Record<string, unknown>, where: string) {
  for (const k of IDENTITY_KEYS) assert.ok(obj[k] == null, `${where} carries ${k}=${JSON.stringify(obj[k])}`);
  assert.ok(!JSON.stringify(obj).includes(ME), `${where} carries the account id`);
}

test("restart: a plain tip read back from history wears no account — recorded, or from before the fix", () => {
  const recorded = { system: "donation", username: "Your Mom", donorMatrixId: null, matrixId: null, tipIdentity: "plain", anonymous: false, amount: 500 };
  const legacy = { ...liveTip("Your Mom"), canonicalId: "c0ffee" }; // stored with the account's id + colour
  for (const [name, card] of [["recorded", recorded], ["legacy", legacy]] as const) {
    const out = historyCardFields("donation", card, historyRow("Casey"), false);
    assertPlain(out, `${name} history JSON`);
    assert.equal(normalizeUsername(String(out.username)), "Your Mom");
    // A moderator's copy is plain on screen too (they reach the sender through the card's row,
    // modCardSender.ts); only a stored canonical reaches them, as for every card.
    const mod = historyCardFields("donation", card, historyRow("Casey"), true);
    for (const k of ["matrixId", "donorMatrixId", "usernameColor", "usernameStyle"]) assert.ok(mod[k] == null, `mod copy carries ${k}`);
  }
});

test("history: an account card's JSON keeps its account; a non-mod never gets a stored canonical", () => {
  const card = { ...liveTip("Casey"), tipIdentity: "account", canonicalId: "c0ffee" };
  const pub = historyCardFields("donation", card, historyRow("Casey"), false);
  assert.equal(pub.matrixId, ME);
  assert.equal(pub.canonicalId, undefined);
  assert.equal(historyCardFields("donation", card, historyRow("Casey"), true).canonicalId, "c0ffee");
});

test("every other card keeps the account's live name (a rename shows on old subs, like on chat lines)", () => {
  const sub = { system: "sub", username: "Old Name", matrixId: ME };
  assert.equal(liveCardActor("sub", sub, historyRow("New Name")).username, "New Name");
  assert.equal(eventCardName("gift", "Old Name", "New Name"), "New Name");
  // A tip with no name stored falls back to the account, then to Anonymous.
  assert.equal(eventCardName("donation", "", "Casey"), "Casey");
  assert.equal(eventCardName("donation", null, null), "Anonymous");
});

test("history builds a card's fields with historyCardFields (liveCardActor inside), not by hand", () => {
  const raw = readFileSync(new URL("../api/chat/history/route.ts", import.meta.url), "utf8");
  const src = stripComments(raw);
  const last = raw.trimEnd().split("\n").slice(-1)[0]!.trim();
  assert.ok(last.length > 0 && src.trimEnd().endsWith(last), "the scan lost the end of the history route");
  assert.match(src, /\.\.\.historyCardFields\(r\.event_kind, card, r, isMod\)/, "history does not build the card's fields with historyCardFields");
  assert.doesNotMatch(src, /username: r\.username, usernameColor: r\.username_color/, "history still sets a card's name from the account by hand");
});
