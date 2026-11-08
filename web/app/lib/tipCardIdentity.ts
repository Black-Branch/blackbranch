// Whether a tip card wears the tipper's account. The tip page's name box is prefilled with the
// account's name; left as it is (or blank) the card is the account's — badges, picture, name
// colour and style, the user-card click. A different typed name is the tipper's choice not to be
// that account in public, so the card is PLAIN: the typed name and nothing that ties it to them.
// Anonymous shows no name at all. ADR 0145.
//
// The money record is not touched: a plain card's payer travels as `payerMatrixId`, which
// stream-api puts on the ledger and the persisted row (refunds, statements, a moderator's reach)
// and never on the card (stream-api/alert.js donationPayer).
//
// Pure, no imports beyond chatMsg.ts: both billing paths and node --test load it directly.
import { normalizeUsername } from "./chatMsg.ts";

type Look = { username: string; usernameColor: string | null; usernameStyle: object | null };

function sameName(a: string, b: string): boolean {
  return normalizeUsername(a.trim()) === normalizeUsername(b.trim());
}

/**
 * The rule. `accountName` is the name the account shows (display name, else its localpart).
 * Fails toward plain: a rename between checkout and payment, or a failed lookup, is plain.
 * @test-only exported so tipCardIdentity.test.ts can drive the rule alone; callers use
 * tipCardIdentity / persistedTipWearsAccount, which apply it.
 */
export function tipWearsIdentity(a: { anonymous: boolean; matrixId: string | null; shownName: string | null | undefined; accountName: string | null | undefined }): boolean {
  if (a.anonymous || !a.matrixId || !a.accountName) return false;
  const shown = (a.shownName ?? "").trim();
  return shown === "" || sameName(shown, a.accountName);
}

/**
 * The identity fields of a donation card for /chat/event. `shownName` is the name recorded for
 * the tip (tipDisplayNameServer.ts); `identity` the account's look (chatIdentity.ts), null when
 * there is no account or it was not looked up.
 */
export function tipCardIdentity(a: { anonymous: boolean; matrixId: string | null; shownName: string | null; identity: Look | null }) {
  const wears = tipWearsIdentity({ anonymous: a.anonymous, matrixId: a.matrixId, shownName: a.shownName, accountName: a.identity?.username });
  const typed = (a.shownName ?? "").trim();
  if (wears && a.identity) {
    return {
      donor: typed || a.identity.username,
      donorMatrixId: a.matrixId,
      payerMatrixId: null,
      tipIdentity: "account" as const,
      anonymous: false,
      usernameColor: a.identity.usernameColor,
      usernameStyle: a.identity.usernameStyle,
    };
  }
  return {
    donor: a.anonymous ? "Anonymous" : typed || "Anonymous",
    donorMatrixId: null,
    payerMatrixId: a.anonymous ? null : a.matrixId,
    tipIdentity: "plain" as const,
    anonymous: a.anonymous,
    usernameColor: null,
    usernameStyle: null,
  };
}

/**
 * Whether a persisted tip card, read back (history, a pin), wears its row's account. The choice
 * stream-api recorded (`tipIdentity`) wins; a card from before it was recorded takes the same
 * rule against the account's name now — its row's matrix_id is there either way.
 * `accountName`: the account's name as the reader has it (display name, else the matrix id).
 */
export function persistedTipWearsAccount(card: Record<string, unknown>, account: { matrixId: string | null; accountName: string | null | undefined }): boolean {
  if (!account.matrixId || card.anonymous === true) return false;
  if (card.tipIdentity === "account") return true;
  if (card.tipIdentity === "plain") return false;
  const shown = typeof card.username === "string" ? card.username : "";
  return tipWearsIdentity({ anonymous: false, matrixId: account.matrixId, shownName: shown, accountName: account.accountName });
}
