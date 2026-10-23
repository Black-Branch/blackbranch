// What a pin stores: the name and text of the message at the moment it was pinned
// (site.pinned_messages.username / .message, both NOT NULL).
//
// A site chat row's name came from COALESCE(display_name, matrix_id). An event card
// with no account behind it (a guest's tip, a Ko-fi or YouTube alert card) has
// matrix_id NULL, so the name was NULL and the pin's INSERT failed: pinning such a
// card answered 500. Its text was often empty too (a tip with no message), which
// pinned a banner with nothing in it. This builds both from the card itself.
//
// Shared by the mod pin (api/chat/pin) and the crowd auto-pin (api/chat/vote): two
// copies of one snapshot rule is how one of them stays broken.

import { eventCardName } from "./eventCardName.ts";

/** One row of the pin route's source query. Platform lines carry no event columns. */
export type PinSourceRow = {
  username: string | null;
  message: string | null;
  emotes: Record<string, string> | null;
  event_kind?: string | null;
  event_json?: unknown;
};

export type PinSnapshot = { username: string; message: string; emotes: Record<string, string> | null };

type Card = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function money(cents: unknown, currency: unknown): string {
  const c = num(cents);
  if (c <= 0) return "";
  const cur = text(currency).toUpperCase() || "USD";
  return cur === "USD" ? `$${(c / 100).toFixed(2)}` : `${(c / 100).toFixed(2)} ${cur}`;
}

/** A line of text for a card that carries no message of its own. */
function cardSummary(kind: string, card: Card): string {
  switch (kind) {
    case "donation": {
      const amt = money(card.amount, card.currency);
      return amt ? `tipped ${amt}` : "sent a tip";
    }
    case "alert": {
      const label = text(card.label);
      const amt = text(card.amountText);
      return [label, amt].filter(Boolean).join(" ") || "sent support";
    }
    case "gift": {
      const n = Math.max(1, num(card.count) || 1);
      return `gifted ${n === 1 ? "1 sub" : `${n} subs`}`;
    }
    case "sub":
      return "subscribed";
    case "sticker":
    case "sticker_boost":
      return text(card.emoteName) ? `sent ${text(card.emoteName)}` : "sent a sticker";
    case "sound":
      return text(card.label) ? `played ${text(card.label)}` : "played a sound";
    default:
      return text(card.label);
  }
}

export function pinSnapshotFrom(row: PinSourceRow): PinSnapshot {
  const kind = row.event_kind ?? null;
  if (!kind) {
    return { username: row.username ?? "", message: row.message ?? "", emotes: row.emotes ?? null };
  }
  let card: Card = {};
  try {
    const raw = typeof row.event_json === "string" ? JSON.parse(row.event_json) : row.event_json;
    if (raw && typeof raw === "object") card = raw as Card;
  } catch { /* an unreadable payload still pins, under the fallbacks below */ }
  const own = text(row.message) || text(card.message);
  return {
    username: eventCardName(kind, card.username, row.username),
    message: own || cardSummary(kind, card),
    emotes: row.emotes ?? null,
  };
}
