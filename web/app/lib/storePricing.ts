// Store prices are stored as STREAMS and rendered to Qorm. Pure and
// dependency-free: it decides what a viewer is charged, so it is
// property-tested rather than eyeballed.
//
// The anchor is E — the Qorm a median engaged viewer earns per stream (seeded
// at 45). Storing prices as streams and deriving Qorm is what decouples the
// earn-rate decision from the price-table decision: change how much a viewer
// earns and the whole table moves correctly, because what is held constant is
// how long they save for a thing.

/** @test-only the band is only read by dampen() below; exported so a test can
 *  pin the constant to the behaviour rather than restating 10% by hand. */
export const STORE_PRICE_DAMPING = 0.1;

/** Rounding is part of the PRICE, not presentation — a price of 1,263 reads as
 *  a computed artifact rather than a decision. Coarser steps as the number
 *  grows, so a 25-Qorm sticker and a 2,500-Qorm badge slot both look chosen.
 *  (Not exported: renderPrice() is the entry point.) */
function ladderStep(points: number): number {
  return points < 500 ? 25 : points <= 2_000 ? 50 : 100;
}

/** @test-only its only non-test callers, renderPrice and dampen, live in this
 *  same file — check-orphans's reference scan excludes same-file callers, so
 *  they don't count. Exported anyway so storePricing.test.ts can property-test
 *  the rounding ladder directly: the honest way to test integer arithmetic
 *  that decides what a viewer is charged, rather than trusting it by proxy
 *  through renderPrice/dampen. */
export function roundPrice(points: number): number {
  const step = ladderStep(points);
  // The floor matters: a free item is a different product, not a cheap one, and
  // a price that rounds to nothing silently stops being a purchase at all.
  return Math.max(step, Math.round(points / step) * step);
}

/** @parked consumed by storePricingServer.ts, which renders the stored table
 *  at the current E. */
export function renderPrice(baseStreams: number, e: number): number {
  return roundPrice(baseStreams * e);
}

/** One step toward `next`, bounded so a single recompute cannot lurch the
 *  store — and landing ON the rounding ladder, every time.
 *
 *  THE LADDER PART IS NOT COSMETIC. Clamping AFTER rounding would show viewers
 *  149, 2,475 and 45 for however many streams a transition took to converge.
 *  Those are computed artifacts — precisely what roundPrice exists to prevent —
 *  and a price only reads as chosen if it reads that way the whole way, not
 *  just at the destination.
 *
 *  The naive fix, roundPrice(clamp(...)), DEADLOCKS: from 150 toward 100 it
 *  yields 149, which rounds back to 150, which is no move, forever. So when the
 *  band contains no ladder value other than the current price, this takes
 *  exactly one ladder step instead. That is what guarantees progress.
 *
 *  The bound is the LARGER of ±10% and one ladder step, because neither alone
 *  works across the range: at 2,500 a lone 100-step is 4% per run (85 runs to
 *  double), while at 25 Qorm ±10% is 2.5 and the ladder has nothing finer than
 *  25. Cheap items therefore move a whole step or not at all — that is the
 *  honest floor of the ladder's resolution, not a compromise.
 *
 *  @parked consumed by planRecompute below and storePricingServer's recompute. */
export function dampen(prev: number | null, next: number): number {
  // The target is rounded FIRST. In production it already is (planRecompute
  // passes renderPrice's output), but the no-overshoot clamp below returns the
  // target itself when a step would pass it — so an off-ladder target would
  // leak straight through and defeat the whole point of this function.
  const target = roundPrice(next);

  // No previous price: take the target outright.
  if (prev === null || prev <= 0) return target;
  if (target === prev) return prev;

  // ONE mechanism, and it is `Math.max`. The move is bounded by ±10% OR one
  // ladder step, WHICHEVER IS LARGER — and that single choice is what makes
  // both ends of the range work AND guarantees progress:
  //
  //   · at 2,500 a lone 100-step would be 4% per run (85 runs to double), so
  //     the percentage has to win at the top;
  //   · at 25 Qorm ±10% is 2.5 and the ladder has nothing finer than 25, so
  //     the step has to win at the bottom — otherwise the price rounds
  //     straight back to where it started and stalls FOREVER.
  //
  // Measured over every price pair on the ladder from 25 to 20,000: with this
  // max(), 0 stall. Replace it with the bare percentage and 2,308 pairs stall
  // (25 → 50 is stuck at 25). A separate anti-stall branch or a no-overshoot
  // clamp is unreachable once this max() and the entry rounding are in place,
  // so neither is here looking load-bearing.
  //
  // Rounding can carry the result up to HALF A STEP beyond the ±10% bound
  // (2,500 → 2,800 rather than 2,750). Deliberate: half a step is a couple of
  // percent where it happens, and landing on the ladder matters more than the
  // bound being exact to the point.
  const maxMove = Math.max(prev * STORE_PRICE_DAMPING, ladderStep(prev));
  return roundPrice(Math.min(prev + maxMove, Math.max(prev - maxMove, target)));
}

/** The product's own store: what an install starts with, in STREAMS, against PRODUCT_E. The app
 *  owns the seed, so an install made from a baseline without seed INSERTs gets the same store.
 *  storePricingServer.seedIfEmpty writes them, ONLY into an empty table (a deleted item is a
 *  decision, never resurrected). storePricingSeed.db.test.ts pins them to what the migration
 *  chain leaves on a replay. */
export const PRODUCT_STORE_PRICES: readonly { itemKey: string; baseStreams: number }[] = [
  { itemKey: "sticker", baseStreams: 0.55 },
  { itemKey: "sticker_boost", baseStreams: 0.55 },
  { itemKey: "highlight", baseStreams: 1.111 },
  { itemKey: "tts", baseStreams: 3.333 },
  { itemKey: "badge_slot", baseStreams: 55 },
];
/** Points a median engaged viewer earns per stream at the product's earn rules (30 watching +
 *  ~15 participation, measured) — the E every product price above is rendered at. */
export const PRODUCT_E = 45;

/** Bounds on one item's stored size, for the admin edit: a hundredth of a stream (a 1-point
 *  item at E = 45 rounds to the ladder's floor anyway) to a thousand streams. */
export const BASE_STREAMS_MIN = 0.01;
export const BASE_STREAMS_MAX = 1000;

export type PriceRow = { itemKey: string; baseStreams: number; price: number };
export type PriceChange = { itemKey: string; from: number; to: number };

/** What a new E would do to the table: the damped move for every row that
 *  actually moves, and nothing for the rest.
 *
 *  Pure, and the ONLY place the render-then-damp rule is spelled. Both the
 *  writer (recomputeStorePrices) and the preview run through here, so a dry run
 *  cannot disagree with the write it is previewing — which is the entire value
 *  of a dry run on something that changes what people are charged. */
export function planRecompute(rows: PriceRow[], e: number): PriceChange[] {
  // Same refusal as the writer, checked here too: a preview that happily showed
  // a store-wide giveaway would be a preview of something that cannot happen.
  if (!(e > 0)) throw new Error(`planRecompute: E must be positive, got ${e}`);
  const changes: PriceChange[] = [];
  for (const r of rows) {
    const to = dampen(r.price, renderPrice(r.baseStreams, e));
    if (to !== r.price) changes.push({ itemKey: r.itemKey, from: r.price, to });
  }
  return changes;
}

export type PriceGuard =
  | { ok: true; price: number }
  | { ok: false; status: 400 | 409 | 503; error: string; price: number | null };

/** THE GUARD THIS EXISTS FOR: a viewer is never charged a price they were not
 *  shown. Every spend route runs this before it debits.
 *
 *  It lives here, pure, because a route handler cannot be invoked under
 *  `node --test` (the "@/" alias has no resolver outside the bundler) — so the
 *  decision is tested behaviourally here and the routes are pinned to calling
 *  it by storeSpendGuard.test.ts.
 *
 *  A MISSING expectedPrice is a 400, never a charge at the current price:
 *  "charge whatever it costs now" is the dark pattern, and a client that forgot
 *  to send it is a bug that should be loud. */
export function priceGuard(expected: unknown, current: number | null): PriceGuard {
  if (typeof expected !== "number" || !Number.isFinite(expected) || expected <= 0) {
    return { ok: false, status: 400, error: "expected_price_required", price: current };
  }
  // An item with no row is a seeding bug, not a free item. 503 rather than 404:
  // the item exists in the product, the price is what is missing, and the
  // client should retry rather than conclude the feature is gone.
  if (current === null) {
    return { ok: false, status: 503, error: "price_unavailable", price: null };
  }
  if (expected !== current) {
    return { ok: false, status: 409, error: "price_changed", price: current };
  }
  return { ok: true, price: current };
}
