import { currencySymbol } from "./currency.ts";
// The site currency's client-safe helpers: the payment range, the sticker sizing, the peg
// conversion and the ledger vocabulary.
//
// Names: code and routes say "points"; the tables keep their `coin_*` names; what a VIEWER
// reads is the install's own word, from currency.ts (a fresh install: "points"). No string
// here names the currency.
//
// Transparent 1:1 peg (a product decision, not an implementation detail):
// 1 point = 1¢ USD, always shown WITH its dollar equivalent. No bundles, no
// markup, no obscured exchange rate — the anti-dark-pattern stance is the brand.

/** The ONE payment range, in cents, for tips AND Qorm purchases — $1 to
 *  $1,000 both ways (Qorm-for-all-income spec, D4). Imported by
 *  /api/billing/donate, /api/billing/points, /api/billing/paypal/order and
 *  TipForm; there is deliberately no second copy anywhere (the old
 *  COIN_MIN/MAX_PURCHASE $2–$500 and the tip routes' own MIN/MAX_CENTS were
 *  deleted, not aliased). */
export const PAY_MIN_CENTS = 100;
export const PAY_MAX_CENTS = 100_000;

/** First-paint prices for the two chat spends. SSR VALUES ONLY, exactly like
 *  STICKER_BASE_COINS: the live price comes from
 *  useItemPrice("highlight" | "tts") and moves with E. Never charge from these. */
export const HIGHLIGHT_PRICE = 50;
export const TTS_PRICE = 150;

/** Extra badge slot (base_slots +1, server caps base at 2 — see badges/buy-slot). */
/** A SIZE BASELINE, NOT A PRICE. The cumulative Qorm on a sticker drives
 *  its rendered scale (stickerBoostScale below), and an unboosted sticker
 *  starts from this number. It is deliberately NOT the sticker's price:
 *    - the price lives in site.store_prices and moves between streams,
 *      and a moving price would silently resize every sticker in history;
 *    - this value is MIRRORED in stream-api, which sizes the OBS overlay with
 *      no shared import — a live price here would desync web from the stream.
 *  Do not turn it into a price. */
export const STICKER_BASE_COINS = 10;

/** Sticker boost: re-post an existing sticker at the bottom of the feed,
 *  bigger, for an extra spend (the amount is the viewer's, floored at the
 *  `sticker_boost` row in site.store_prices — a FLOOR on a variable amount,
 *  not a fixed price: the viewer chooses the boost spend and is charged
 *  exactly that). Size scales with the CUMULATIVE total
 *  EVER spent on that sticker — the original send counts as the starting
 *  balance (STICKER_BASE_COINS above), plus every boost since — saturating at
 *  STICKER_BOOST_CAP. That cap is a SIZE
 *  ceiling only, never a spend limit; boosting past it still charges in full,
 *  it just stops growing. The SIZE constants mirror `stream-api`'s copies
 *  (the OBS overlay needs the size too) — keep both in sync, no shared import
 *  across the two codebases. The floor is NOT mirrored: it lives in the table
 *  and only the web app charges. */
export const STICKER_BOOST_CAP = 250;
const STICKER_BASE_SCALE = 1;
// A fully-boosted sticker reaches BASE_SCALE + this fraction of the range.
// This ALSO sizes the OBS overlay sticker — glance at the overlay after
// changing so a max-boost doesn't overflow the on-stream layout. Tunable knob;
// dial down if too large.
const STICKER_MAX_SCALE = 4.0;
// Unboosted sticker height, in `em` of the chat font — the chat row renders the
// sticker <img> at `STICKER_BASE_EM * stickerBoostScale(cumulative) em` as an
// EXPLICIT height (not max-height). Explicit height is what makes sticker size
// deterministic: it does not collapse to whatever the emote's intrinsic 4x
// pixels happen to be (which varies per emote and would silently cap boost
// growth). Scales with the chat font via `em`, so a bigger chat text → bigger
// stickers. Tunable knob.
export const STICKER_BASE_EM = 4.2;

/** 1 (unboosted, i.e. cumulativeCoins === STICKER_BASE_COINS) → STICKER_MAX_SCALE
 *  as the cumulative total climbs to the cap, then holds there. Pure function
 *  shared by chat-row rendering and the OBS overlay hint so cap math and
 *  visual size can't drift apart. */
export function stickerBoostScale(cumulativeCoins: number): number {
  const t = Math.max(0, Math.min(1, cumulativeCoins / STICKER_BOOST_CAP));
  return STICKER_BASE_SCALE + t * (STICKER_MAX_SCALE - STICKER_BASE_SCALE);
}

/** The Qorm a tip of `cents` pays, at the peg (1 Qorm per USD cent — the
 *  same transparent 1:1 rate the top-up box uses). ONE place for the
 *  conversion the tip-form copy and
 *  the thank-you line both need, so a tipper never sees two different numbers
 *  for the same tip. `Math.round` absorbs float noise from `dollars * 100`
 *  (e.g. 12.34 * 100 === 1233.9999999999998); `Math.max(0, …)` keeps a
 *  mid-edit negative/invalid box from ever rendering a negative Qorm figure. */
export function pointsForCents(cents: number): number {
  return Math.max(0, Math.round(cents));
}

/** "1,475q" — the number and its glyph (currency.ts: the install's `currency.symbol`). One letter
 *  sits right after the number, the way "34¢" would; a longer mark ("pts") gets a no-break space.
 *
 *  Not `¢`: a quantity written "34¢" says the thing being counted is
 *  denominated in US cents — and points are not: a virtual currency that only ever
 *  leaves a wallet through the store. `¢` is still correct where the number really IS dollars —
 *  the admin price prompts that state the 1 point = 1¢ PURCHASE peg. Do not sweep those. */
export function formatCoinsShort(coins: number): string {
  const sym = currencySymbol();
  return `${Math.round(coins).toLocaleString()}${sym.length > 1 ? "\u00a0" : ""}${sym}`;
}

/**
 * The parenthetical beside a wallet total: how much of it the holder earned
 * (as opposed to bought) — "1,475q (475q)".
 *
 * ALWAYS RENDERED. Omitting it when the two are equal would hide it from every
 * user who has never bought Qorm — i.e. almost everyone, and exactly the
 * people for whom "all of this was earned" is the useful fact. A number that
 * appears and vanishes depending on purchase history cannot be learned; one
 * that is always there can.
 *
 * `null` means UNKNOWN, not zero, and renders as "…". useCoinBalance
 * deliberately blanks the split whenever the balance moves through a path that
 * cannot know the new one (a spend, an earn) — showing a guess there would put a
 * quietly wrong number inside the total it belongs to. It refills within one
 * round trip; holding the slot is what stops the layout jumping meanwhile.
 *
 * ONE function, two callers (the store header and the profile card row), for
 * the same reason the badge gap is one custom property: two copies of a display
 * rule drift.
 */
export function earnedParenthetical(earned: number | null): string {
  return ` (${earned === null ? "…" : formatCoinsShort(earned)})`;
}

// ── Ledger vocabulary ────────────────────────────────────────────────────────
// The ONE list. Types are DERIVED from the arrays, not declared alongside them,
// so a kind cannot exist in the type but be missing from the enumeration that
// tests and labels iterate.
//
// This lives in coins.ts rather than coinsServer.ts because client components
// (the Qorm history tab) need it and coinsServer imports the pg pool. coins.ts
// is the shared price/vocabulary table — see this file's header.

// @test-only enumerated by coins.test.ts to prove every LedgerKind has a
// label — the derived `LedgerKind` type is what StoreContent/coinsServer
// actually import; the array itself has no production reader.
export const LEDGER_KINDS = [
  "purchase", "earn_watch", "earn_chat", "spend", "refund", "admin_adjust",
  // LEGACY — there is no market. Rows with these kinds exist and the history
  // tab labels them; nothing writes them.
  "market_buy", "market_sell", "market_payout", "market_void",
  // Participation earning. Each source is its own kind so the split
  // stays measurable in the ledger — "where does earned Qorm come from" is a
  // question the history tab and the provenance report both need to answer.
  "earn_first", "earn_vote", "earn_upvote",
  // The clock perk: the 2x bonus is its OWN row,
  // ref-keyed to the base award it rode with — so history can say which Qorm
  // was the bonus, and provenance can carve it out without a migration.
  "earn_bonus",
  // Money-bought Qorm: a tip pays Qorm at the purchase peg;
  // a refund/dispute of money-bought Qorm takes it back (even below zero), and
  // a won dispute — or a refund attempt that itself failed/was canceled —
  // gives the clawback back.
  "tip", "clawback", "clawback_reversed",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

// @test-only same reason as LEDGER_KINDS above — enumerated by coins.test.ts,
// consumed elsewhere only via the derived `SpendSink` type.
// `tts` is Read aloud, 150 Qorm. Its sink name is shared with an earlier
// paid-voice-message product, so historical site.coin_ledger rows also
// carry sink='tts' — the Qorm history tab labels rows by looking the sink up
// here, and dropping an entry would render every past purchase as
// `undefined`, the defect the "every spend sink has a non-empty label" test
// exists to catch. `cheer` is a retired product kept for the same reason:
// historical rows carry it, and the history tab needs this entry to label
// them.
// A sink list is a VOCABULARY for reading the past, not a menu of what is on
// sale.
// (There is deliberately no paid-bot sink: no ledger row ever carried one.)
export const SPEND_SINKS = [
  "cheer", "highlight", "tts", "sticker", "sticker_boost", "badge", "badge_slot", "style",
  "sound",
] as const;
export type SpendSink = (typeof SPEND_SINKS)[number];

/** Human label for one ledger row. Exhaustive over LEDGER_KINDS by test. */
export function ledgerKindLabel(kind: LedgerKind, sink: SpendSink | null): string {
  switch (kind) {
    case "purchase":      return "Top-up";
    case "earn_watch":    return "Earned watching";
    case "earn_chat":     return "Earned chatting";
    case "earn_first":    return "First message of the stream";
    case "earn_vote":     return "Earned voting";
    case "earn_upvote":   return "Your message was upvoted";
    case "earn_bonus":    return "Clock bonus";
    case "spend":
      // `cheer` is retired but its 247 historical rows must keep their own
      // name — relabelling them as "Highlight" would rewrite what people
      // remember buying.
      return sink === "highlight" ? "Highlight"
        : sink === "tts" ? "Read aloud"
        : sink === "cheer" ? "Cheer"
        : `Spent — ${sink ?? "store"}`;
    case "refund":        return "Refund";
    case "admin_adjust":  return "Adjustment";
    case "market_buy":    return "Market — bought";
    case "market_sell":   return "Market — sold";
    case "market_payout": return "Market — payout";
    case "market_void":   return "Market — voided";
    case "tip":               return "Tip";
    case "clawback":          return "Refunded";
    // Not "Dispute won" — restoreClawback also fires for a Stripe refund
    // that later failed or was canceled (the money stayed with us, so the
    // clawback comes back), which is not a dispute. "Returned" is true for
    // both restoring causes.
    case "clawback_reversed": return "Returned";
  }
}

// ── Earning, as the viewer sees it ───────────────────────────────────────────

/** The credit kinds that are EARNING. Derived from LEDGER_KINDS by prefix
 *  rather than listed again, so a new `earn_*` kind joins the chip, the
 *  provenance bucket and the history tab together or not at all — a
 *  hand-maintained second list is how StoreContent's kind switch went stale
 *  against a type TypeScript still believed exhaustive. */
export type EarnKind = Extract<LedgerKind, `earn_${string}`>;
export const EARN_KINDS: readonly EarnKind[] =
  LEDGER_KINDS.filter((k): k is EarnKind => k.startsWith("earn_"));

/** One award as the SERVER reports it — the kind is still carried across the
 *  wire even though the chip no longer renders it, because the heartbeat groups
 *  by kind and the split is what makes "where does earned Qorm come from"
 *  answerable without re-reading the ledger. The chip sums them. */
export type EarnChipItem = { kind: EarnKind; points: number };
