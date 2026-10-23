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
import { eventCardName, liveCardActor } from "./eventCardName.ts";
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

test("the account's identity still comes along: badges key, colour and style are live", () => {
  const actor = liveCardActor("donation", liveTip("Your Mom"), { ...historyRow("Casey"), username_color: "#00ff00" });
  assert.equal(actor.matrixId, ME);
  assert.equal(actor.usernameColor, "#00ff00");
});

test("every other card keeps the account's live name (a rename shows on old subs, like on chat lines)", () => {
  const sub = { system: "sub", username: "Old Name", matrixId: ME };
  assert.equal(liveCardActor("sub", sub, historyRow("New Name")).username, "New Name");
  assert.equal(eventCardName("gift", "Old Name", "New Name"), "New Name");
  // A tip with no name stored falls back to the account, then to Anonymous.
  assert.equal(eventCardName("donation", "", "Casey"), "Casey");
  assert.equal(eventCardName("donation", null, null), "Anonymous");
});

test("history builds a card's identity with liveCardActor, not by hand", () => {
  const raw = readFileSync(new URL("../api/chat/history/route.ts", import.meta.url), "utf8");
  const src = stripComments(raw);
  const last = raw.trimEnd().split("\n").slice(-1)[0]!.trim();
  assert.ok(last.length > 0 && src.trimEnd().endsWith(last), "the scan lost the end of the history route");
  assert.match(src, /liveCardActor\(r\.event_kind, card, r\)/, "history does not build the card's identity with liveCardActor");
  assert.doesNotMatch(src, /username: r\.username, usernameColor: r\.username_color/, "history still sets a card's name from the account by hand");
});
