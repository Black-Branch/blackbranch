// The words a failed coin spend shows, decided HONESTLY. Pure, out of from StoreSpend.tsx / useStickerSend.ts so the money
// copy is testable under `node --test`.
//
// The one rule (chatEventDelivery.ts's contract, client-side edition):
// "nothing was charged" is only sayable when the server ANSWERED with a
// refusal — a 4xx, or a route-specific error code that proves the pre-debit
// path. An unclassifiable 5xx may have crashed AFTER the debit and before the
// refund, so it gets the unconfirmed copy with its mod-refund escape hatch,
// never a promise about the money.

import { currencyName } from "./currency.ts";

type SpendErrorBody = {
  error?: string;
  retryAfterSeconds?: number;
  price?: number;
};

const UNCONFIRMED_COPY =
  "Couldn't confirm that went through — if it never happened, ask a mod for a refund.";

/** Copy for a non-2xx from the generic store spend routes (StoreSpend). */
export function storeSpendFailureCopy(status: number, d: SpendErrorBody): string {
  if (status === 402) return `Not enough ${currencyName()}.`;
  if (status === 429) return `Easy — try again in ${d.retryAfterSeconds ?? "a few"}s.`;
  if (d.error === "blocked") return "That text is blocked by the word filter.";
  if (d.error === "already_unlocked" || d.error === "already_owned") return "You already own that.";
  // (No `tts_disabled` branch: there is no paid-TTS route, so nothing returns
  // that code. Cheer TTS refuses via the cheer flow's own copy.)
  if (d.error === "stream_offline") return "That one only works while the stream is live.";
  if (d.error === "sound_unavailable") return "That clip isn't available right now.";
  // Truthful floor for the guard's 409 — the full refresh-and-rearm flow lives
  // with the caller; this stops the generic copy from
  // hiding WHAT went wrong.
  if (d.error === "price_changed")
    return `Price just changed to ${typeof d.price === "number" ? d.price.toLocaleString() : "a new amount"} — nothing was charged.`;
  if (d.error === "bad_spend") return "That purchase wasn't understood — nothing was charged.";
  if (d.error === "not_spoken") return "Nothing to read aloud — a link or emotes alone don't have words. You were refunded.";
  // unconfirmed ≠ failed: the spend may have gone through and was NOT
  // refunded — "nothing was charged" would be a lie (see chatEventDelivery.ts).
  if (typeof d.error === "string" && d.error.endsWith("_unconfirmed")) return UNCONFIRMED_COPY;
  // Any other 5xx is unclassifiable: the crash may sit after the debit.
  if (status >= 500) return UNCONFIRMED_COPY;
  // A 4xx the server answered: the route refused (and refunds on refusal), so
  // the claim is provable here — and only here.
  return "Something went wrong — nothing was charged.";
}

/** Copy for a non-2xx from the sticker send (useStickerSend). */
export function stickerSendFailureCopy(status: number, d: SpendErrorBody): string {
  if (status === 402) return `Not enough ${currencyName()} for a sticker — top up in the store.`;
  if (status === 429) return `Sticker cooldown — try again in ${d.retryAfterSeconds ?? "a few"}s.`;
  // 409: the price moved between the render and the tap — the caller refreshes
  // the table; the copy says the number so the viewer decides.
  if (status === 409) return `Sticker price just changed to ${d.price ?? "a new price"} — nothing was charged.`;
  // Only the route's OWN code proves the pre-debit 503 (price table missing).
  // A bare 503 can be minted by infrastructure with the debit already taken.
  if (d.error === "price_unavailable") return "Sticker price is unavailable right now — nothing was charged.";
  // unconfirmed ≠ failed (see chatEventDelivery.ts).
  if (typeof d.error === "string" && d.error.endsWith("_unconfirmed"))
    return "Couldn't confirm that went through — if the sticker never appeared, ask a mod for a refund.";
  if (status >= 500)
    return "Couldn't confirm that went through — if the sticker never appeared, ask a mod for a refund.";
  return "Couldn't send the sticker — nothing was charged.";
}
