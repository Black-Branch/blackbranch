// The name a persisted event card (a tip, a gift, a sub, a coin spend) shows when it
// is read back: chat history, a pin.
//
// A tip is the one card whose name is the giver's CHOICE for that tip. The tip page
// has a name box; a signed-in tipper can type any name there (a joke name is common),
// and when they leave it blank their site display name of the moment is used
// (tipDisplayNameServer.ts). The live card carries that name. Read back, history used
// to replace it with the account's live name, COALESCE(display_name, matrix_id): the
// typed name was lost, and an account with no display name showed its unique
// username instead. So a tip keeps the name it was given; Anonymous stays Anonymous
// (an anonymous tip is stored with no account at all, so nothing can reveal it).
//
// Every other kind is the account's action, not a named gift, and keeps the live name
// (a person who renames shows the new name on their old subs, like on their chat lines).

/** True for a card whose shown name is the one stored on the card. */
function cardKeepsItsName(kind: string | null | undefined): boolean {
  return kind === "donation";
}

/**
 * The name to show for a persisted card.
 * @param kind     the card's kind (site.chat_messages.event_kind)
 * @param stored   the name written on the card when it was posted (event_json.username)
 * @param liveName the account's name now — display name, else the matrix id — or null
 *                 for a card with no account behind it
 */
export function eventCardName(kind: string | null | undefined, stored: unknown, liveName: string | null | undefined): string {
  const onCard = typeof stored === "string" && stored.trim() ? stored : "";
  if (cardKeepsItsName(kind) && onCard) return onCard;
  return liveName || onCard || "Anonymous";
}

/** A persisted card's row as chat history reads it: the account (matrix_id, NULL for a
 *  card with none — an anonymous or guest tip, a platform alert) and its live name/look. */
type CardRow = { matrix_id: string | null; username: string | null; username_color?: string | null; username_style?: unknown };

/**
 * The identity fields a card read back from history wears. A card with an account
 * wears its live badges key, colour and style; its NAME follows eventCardName (a tip
 * keeps its own). A card with no account keeps everything its payload carries.
 */
export function liveCardActor(kind: string | null | undefined, card: Record<string, unknown>, r: CardRow) {
  if (r.matrix_id == null) return {};
  return {
    matrixId: r.matrix_id,
    username: eventCardName(kind, card.username, r.username),
    usernameColor: r.username_color ?? null,
    usernameStyle: r.username_style ?? null,
  };
}
