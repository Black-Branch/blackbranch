// Where a wallet's points CAME FROM — attribution of one commingled balance to
// the four things that can put points into it.
//
// The question this exists to answer: **how much of a given balance is backed
// by real money?** Points can be bought with a card, and that is the material
// difference from Twitch channel points, which cannot — and channel points'
// unpurchasability is most of why Twitch Predictions sit clear of gambling law.
// Nothing here enforces a policy. It measures, so a policy can be chosen
// against real numbers instead of guessed at.
//
// This file is PURE and dependency-free ON PURPOSE: it does integer
// arithmetic that must not lose or invent points, and a rounding bug in a
// proportional drain is exactly the kind that looks right in an example and
// is wrong in aggregate. Purity is what lets the fold run against synthetic
// ledgers with no pool — property-tested over random ledgers
// (coinProvenance.test.ts), not just examples.
//
// THE INVARIANT, which every policy must satisfy and every test asserts:
//   sum(split) - debt === balance, no bucket is ever negative, and debt > 0
//   only when every bucket is 0.
// The base is trustworthy: site.coin_wallets.balance reconciles exactly to
// SUM(delta) over site.coin_ledger, so a fold over the ledger has the same
// total by construction — and any disagreement is therefore a bug in HERE,
// which is what makes the invariant a real test rather than a tautology.
//
// `.ts` extension on relative imports: node --test loads this module directly
// and does no extension inference (app/lib/testDom.ts says why).
import type { LedgerKind } from "./coins.ts";

/** The four origins of points. Only ONE of them is backed by money.
 *
 *  `granted` is deliberately NOT folded into `earned`. Admin grants can be the
 *  overwhelming majority of all points in existence, sitting in a couple of
 *  owner wallets — so calling them "earned" would make any earned-only rule
 *  meaningless, and calling them "purchased" would be false. They are their own
 *  thing and any policy has to say what it thinks of them ON PURPOSE.
 *
 *  `winnings` (LEGACY — there is no market) is market value
 *  returned ABOVE the stake it drew from — points the house minted, not points
 *  anyone put in. Tracked separately because "winnings from a wager partly
 *  funded by purchased points" is a question someone may need to answer, and
 *  folding it back into `purchased` or `earned` would answer it silently and
 *  probably wrongly. */
// @parked same consumer as DRAIN_POLICIES below — the report iterates the
// buckets to print the split; inside this module the type is what is used.
export const PROVENANCE_BUCKETS = ["purchased", "earned", "granted", "winnings"] as const;
export type ProvenanceBucket = (typeof PROVENANCE_BUCKETS)[number];

/** Points by origin. Always non-negative; NOT always the wallet balance on its
 *  own — see `attributionBalance` below. Sums to the balance only when the
 *  wallet owes nothing (`debt === 0`). */
export type Split = Record<ProvenanceBucket, number>;

/** What a DEBIT takes from a commingled balance. This is the whole policy
 *  question, and it is a choice rather than a fact — the points in a wallet are
 *  fungible, so "which points did you spend" has no physical answer.
 *
 *  - `pro-rata` — every debit drains all four pools in proportion to their
 *    current share. Order-independent and ungameable by timing, and it is how
 *    commingled funds are generally treated when no tracing is possible. The
 *    recommended default.
 *  - `earned-first` — drains earned, then granted, then winnings, then
 *    purchased. CONSERVATIVE: the remaining balance skews purchased, so it
 *    OVER-states how much real money is still in the wallet. Hardest to argue
 *    against, harshest on the user.
 *  - `purchased-first` — the mirror. GENEROUS, and gameable: buy 5,000, spend
 *    5,000, and what is left looks clean while the value was still extracted.
 *    Included so that gap is visible in the report rather than theoretical.
 *
 *  - (legacy) `stake` — what a MARKET BUY takes: winnings, then earned, and
 *    only then the pools a stake is not supposed to reach. Unlike the three
 *    above it is not a hypothetical the report explores; it is half of the
 *    shipped rule (see PRODUCT_DRAIN). STAKE_TAIL_IS_NOT_DEAD explains the tail.
 *
 *  FIFO is deliberately absent. It needs per-lot tracking that none of these
 *  do, and it is gameable in the same direction as `purchased-first` whenever
 *  purchases come early — which, here, they do. The signature takes a policy
 *  name so adding it later is additive. */
export type DrainPolicy = "pro-rata" | "earned-first" | "purchased-first" | "stake";

/** How `attribute` decides a policy: one name for the WHOLE fold, or a
 *  function of the debit's kind.
 *
 *  Both shapes are load-bearing and neither replaces the other. A uniform name
 *  is what the report needs — "the whole ledger under earned-first" is only a
 *  meaningful comparison if the policy really was uniform. A function is what
 *  SHIPS, because the real rule is not uniform: a store spend and a market buy
 *  (legacy — the market is gone) took from different pools on purpose. */
export type DrainPolicyFor = DrainPolicy | ((kind: LedgerKind) => DrainPolicy);

// @parked consumed by scripts/provenance-report.ts, which check-orphans does
// not walk (it scans app/ only) — the report iterates every policy so the
// choice can be made against the spread on real data rather than argued.
export const DRAIN_POLICIES: readonly DrainPolicy[] = ["pro-rata", "earned-first", "purchased-first"];

// Priority order for the ordered policies. pro-rata has no order by definition.
//
// STAKE_TAIL_IS_NOT_DEAD. `stake` lists granted and purchased after the two
// earned pools, and that tail looks unreachable: under the earned-only stake
// rule the trade route refused any stake that `earnedBalance()` could not
// cover, so winnings + earned always sufficed. This is LEGACY — there is no
// market and no new `market_buy` rows — but the rule is kept for the HISTORY.
// Every `market_buy` written before that rule was funded from a commingled
// balance; a policy that could not drain those rows would leave
// `splitTotal(split) !== balance` when the fold replays them — and that
// invariant is the thing every test and every caller relies on. Deleting the
// tail turns a correct fold into a silently wrong one for exactly the wallets
// that traded earliest.
const DRAIN_ORDER: Record<Exclude<DrainPolicy, "pro-rata">, readonly ProvenanceBucket[]> = {
  "earned-first": ["earned", "granted", "winnings", "purchased"],
  "purchased-first": ["purchased", "winnings", "granted", "earned"],
  stake: ["winnings", "earned", "granted", "purchased"],
};

/** What a debit of this kind takes — the SHIPPED rule, as opposed to the
 *  uniform policies above, which exist so the report can explore hypotheticals.
 *
 *  A store spend drains PURCHASED first, so bought points leave through the
 *  store and the earned pool survives to be shown as earned. `market_buy` is
 *  LEGACY — nothing writes that kind — but rows exist, and they drained the
 *  `stake` order (winnings, then earned).
 *  The rule is kept so the fold replays history exactly: STAKE_TAIL_IS_NOT_DEAD
 *  above explains why deleting a historical branch corrupts the wallets that
 *  traded earliest. Winnings drain before earned in `stake` because winnings
 *  were the most restricted pool — house-minted, never bought — so draining
 *  them first left the holder with the most flexible balance remaining; a
 *  mutation swapping that order is caught only by the test that pins it. */
export function PRODUCT_DRAIN(kind: LedgerKind): DrainPolicy {
  return kind === "market_buy" ? "stake" : "purchased-first";
}

/** What a RESTORING credit hands back — a partial sell, payout, void or refund
 *  returning provenance to the spendable balance.
 *
 *  Deliberately a constant rather than a lookup on either kind. It is NOT the
 *  credit's own policy (a market_sell is not a market_buy) and NOT the matching
 *  debit's, because at the wallet level there is no matching debit: a partial
 *  sell reverses "some position", and the module measures a balance rather than
 *  keeping an audit trail per trade — its header says so.
 *
 *  It is `purchased-first` because that is the CONSERVATIVE direction. A
 *  restore hands the least-stakeable provenance back to the spendable balance
 *  first, so a partial exit could never inflate what a wallet was allowed to stake. The
 *  mirror choice (stake order) would return earned points first and raise
 *  `earnedBalance`, which is the one number in this module that must never be
 *  generous by accident.
 *
 *  It only ever DIFFERS from the stake order for positions opened before the
 *  earned-only rule, and no new market_buy rows exist — the fold replays the
 *  old ones unchanged. A mutation swapping them passes every test except the
 *  historical case. */
const RESTORE_POLICY: DrainPolicy = "purchased-first";

/** The EARNED part of a balance: `earned + winnings`.
 *
 *  This is the parenthetical beside every wallet total — "1,475q (475q)".
 *  `winnings` are legacy market returns the house minted, never
 *  money, so they count as earned rather than bought. `granted` is excluded:
 *  the owner wallets hold grants that are an exemption from cost,
 *  not value in the economy.
 *
 *  A named function for the same reason `moneyBacked` is one: a DEFINITION
 *  lives in one place and is revised in one place. */
export function earnedBalance(split: Split): number {
  return split.earned + split.winnings;
}

/** Which bucket a CREDIT of this kind lands in, or null when the kind is a
 *  debit or needs the fold's context to place (market returns and refunds both
 *  restore what an earlier debit took — see attribute()).
 *
 *  Exhaustive over LedgerKind by type, not by convention: a new ledger kind
 *  fails to compile here rather than silently landing in the wrong bucket. That
 *  is the same trap `StoreContent.tsx`'s hand-duplicated kind list fell into —
 *  a switch TypeScript believed exhaustive against a stale local copy. */
const CREDIT_BUCKET: Record<LedgerKind, ProvenanceBucket | null> = {
  purchase: "purchased",
  earn_watch: "earned",
  earn_chat: "earned",
  // Participation earning — all earned, never money-backed (and, under the
  // legacy market's earned-only rule, all stakeable).
  earn_first: "earned",
  earn_vote: "earned",
  earn_upvote: "earned",
  // The clock perk's bonus row. Earned — but a lit
  // clock is bought with real support, so it keeps its own kind to stay
  // distinguishable from plain earning in the split (and, historically, was
  // the one earned kind a stricter market rule could have excluded).
  earn_bonus: "earned",
  admin_adjust: "granted",   // also the only kind that can be NEGATIVE
  spend: null,               // debit
  market_buy: null,          // debit
  refund: null,              // restores what a spend took
  market_sell: null,         // restores what a market_buy took, then winnings
  market_payout: null,       // "
  market_void: null,         // "
  tip: "purchased",               // money-backed, exactly like a purchase (D1)
  clawback_reversed: "purchased", // the money came back to us — so did the backing
  clawback: null,                 // debit — remembered NOWHERE (see attribute)
};

/** One ledger row, in the only shape this needs. Deliberately not the DB row
 *  type: this module must stay loadable under `node --test` with no pg. */
export type LedgerEntry = { kind: LedgerKind; delta: number };

export type Attribution = {
  /** The spendable balance, by origin. Sums to the wallet balance. */
  split: Split;
  /** Provenance that WAS sunk into open market positions — already debited
   *  from `split`, so NOT part of the balance. There is no market and no open
   *  positions; this bucket is retained so the fold replays historical rows
   *  unchanged. */
  atRiskInMarkets: Split;
  /** Provenance consumed by sinks (stickers, TTS, cheers…), lifetime. Kept so
   *  a refund can restore what the spend took rather than guessing. */
  spentOnSinks: Split;
  /** Total positive `admin_adjust` this wallet has EVER received. Lifetime, not
   *  current: a granted wallet that spent the lot is still a granted wallet.
   *  See isHouseWallet — this is what that reads. */
  grantsReceived: number;
  /** Points this wallet OWES — a refund/dispute clawback larger than the balance
   *  (the wallet goes below zero). While debt > 0 every
   *  bucket is 0; credits pay it off before landing anywhere. Invariant:
   *  splitTotal(split) - debt === balance. */
  debt: number;
};

/** Is this an OWNER wallet rather than a participant?
 *
 *  The owners' own points only make store prices meaningless for themselves; they are not
 *  circulation. That is the correct frame and it changes what every aggregate
 *  here means: if nearly all points "in circulation" is a couple of grants, a
 *  total that includes them describes nothing.
 *
 *  Keyed on HAVING BEEN GRANTED, not on `site.users.is_admin`/`is_mod`:
 *  is_mod covers ordinary participants holding small balances who would then
 *  be excluded from the community picture for entirely the wrong reason. The
 *  grant is the thing that makes cost meaningless, so the grant is what this
 *  reads.
 *
 *  KNOWN LIMIT: a small CORRECTIVE `admin_adjust` (fixing a bug for one user)
 *  would misclassify that user as an owner. Grants and corrections are the
 *  same ledger kind, and no magnitude threshold is used because any number
 *  would be invented. If corrective adjustments ever start happening, split
 *  the kind (`admin_grant` vs `admin_correct`) rather than guessing at a
 *  cutoff — and until then the report NAMES every wallet it excludes, so a
 *  misclassification shows up on the next run instead of silently moving the
 *  totals. */
// @parked consumed by scripts/provenance-report.ts, outside check-orphans'
// app/ scan — it is what splits circulation from owner wallets there.
export function isHouseWallet(a: Pick<Attribution, "grantsReceived">): boolean {
  return a.grantsReceived > 0;
}

function emptySplit(): Split {
  return { purchased: 0, earned: 0, granted: 0, winnings: 0 };
}

// @parked consumed by scripts/provenance-report.ts (its circulation and
// at-risk totals) — outside check-orphans' app/ scan, same reason moneyBacked
// below carries the tag. coinProvenanceServer.ts's two balance fields go
// through attributionBalance, which calls this internally, so check-orphans
// sees no app/-scanned external call site on its own.
export function splitTotal(s: Split): number {
  return s.purchased + s.earned + s.granted + s.winnings;
}

/** An Attribution's actual wallet balance — `splitTotal(split) - debt`, the
 *  invariant stated on `Attribution.debt` above. A wallet in debt has every
 *  split bucket at 0 (the fold pays debt off a credit before it lands in any
 *  bucket — see `attribute`'s loop), so `splitTotal(split)` alone reads 0 for
 *  a wallet that is actually negative. This is the ONLY correct way to read a
 *  balance off an Attribution; coinProvenanceServer.ts's attributeWallet and
 *  attributeAllWallets both compute WalletAttribution.balance through it. */
export function attributionBalance(a: Pick<Attribution, "split" | "debt">): number {
  return splitTotal(a.split) - a.debt;
}

/** Take `amount` out of `from`, per `policy`, and return what was taken.
 *
 *  THE ROUNDING IS THE DANGEROUS PART. Points are integral, so a proportional
 *  share is generally fractional, and naive rounding either loses points (the
 *  split stops summing to the balance) or invents it (worse). This uses
 *  LARGEST REMAINDER: floor every exact share, then hand the leftover units out
 *  one at a time by descending fractional part, skipping any pool that is
 *  already exhausted. The result takes EXACTLY min(amount, total(from)) units
 *  and never takes more from a pool than it holds — both asserted as properties.
 *
 *  Returns the taken split; the caller subtracts it. Taking more than exists is
 *  clamped rather than throwing: the wallet's own guard is what prevents an
 *  overdraft, and a historical ledger being replayed here should describe what
 *  happened, not re-litigate whether it was allowed.
 *
 *  @test-only exported so coinProvenance.test.ts can property-test it directly.
 *  Production reaches it only through applyLedger/restore in this file. It is
 *  exported anyway because "takes exactly min(amount, total) and never more from
 *  a pool than it holds" is the property the whole split rests on, and proving
 *  that through a caller proves it for one policy at a time. */
export function drain(from: Split, amount: number, policy: DrainPolicy): Split {
  const taken = emptySplit();
  const available = splitTotal(from);
  let want = Math.min(Math.max(0, Math.floor(amount)), available);
  if (want === 0) return taken;

  if (policy !== "pro-rata") {
    for (const bucket of DRAIN_ORDER[policy]) {
      if (want === 0) break;
      const take = Math.min(from[bucket], want);
      taken[bucket] = take;
      want -= take;
    }
    return taken;
  }

  // Pro-rata, largest remainder.
  const exact = PROVENANCE_BUCKETS.map((b) => ({
    bucket: b,
    // `available > 0` is guaranteed here: want > 0 and want <= available.
    share: (from[b] * want) / available,
  }));
  let handedOut = 0;
  for (const e of exact) {
    const floored = Math.min(Math.floor(e.share), from[e.bucket]);
    taken[e.bucket] = floored;
    handedOut += floored;
  }
  // Leftover units to the largest fractional parts first. A pool already at its
  // own ceiling is skipped, which is why this loops until the remainder is gone
  // rather than assuming one pass suffices.
  let remainder = want - handedOut;
  const byFraction = [...exact].sort((a, b) => (b.share % 1) - (a.share % 1));
  while (remainder > 0) {
    let placed = false;
    for (const e of byFraction) {
      if (remainder === 0) break;
      if (taken[e.bucket] < from[e.bucket]) {
        taken[e.bucket] += 1;
        remainder -= 1;
        placed = true;
      }
    }
    // Unreachable while want <= available, but a non-terminating loop in
    // currency code is not a risk worth leaving to an argument.
    if (!placed) break;
  }
  return taken;
}

function add(into: Split, other: Split): void {
  for (const b of PROVENANCE_BUCKETS) into[b] += other[b];
}

function subtract(from: Split, other: Split): void {
  for (const b of PROVENANCE_BUCKETS) from[b] -= other[b];
}

/** Fold a wallet's ledger, oldest row first, into an attribution.
 *
 *  ORDER MATTERS and the caller owns it: rows must be ascending by
 *  `coin_ledger.id`. Under `pro-rata` the result is insensitive to the order of
 *  same-sign runs, but under the ordered policies it is not, and neither is the
 *  market-stake restoration under any policy. Passing rows in DESC order — the
 *  order `coin_ledger_matrix_idx` naturally serves — silently produces a
 *  plausible, wrong answer.
 *
 *  Market returns restore provenance to the pools the corresponding buys took
 *  it from, capped at what is still sunk; anything above that is `winnings`,
 *  because the house minted it. Refunds do the same against `spentOnSinks`.
 *  Both are approximations at the WALLET level rather than per-position — this
 *  measures a balance, not an audit trail for one trade. */
export function attribute(
  entries: readonly LedgerEntry[],
  policy: DrainPolicyFor
): Attribution {
  // A bare policy name folds every debit the same way — what the report does,
  // and what it needs: comparing "the whole ledger under earned-first" against
  // "the whole ledger under pro-rata" is only meaningful if the policy really
  // is uniform. PRODUCT_DRAIN is the other shape, and it is what ships.
  const policyFor: (kind: LedgerKind) => DrainPolicy =
    typeof policy === "function" ? policy : () => policy;
  const split = emptySplit();
  const atRiskInMarkets = emptySplit();
  const spentOnSinks = emptySplit();
  let grantsReceived = 0;
  let debt = 0;

  for (const e of entries) {
    const delta = Math.trunc(e.delta);
    if (delta === 0) continue;

    if (delta < 0) {
      const taken = drain(split, -delta, policyFor(e.kind));
      subtract(split, taken);
      // Whatever the split could not cover becomes DEBT — the wallet going
      // below zero. `drain` caps at what exists, so this is exactly the
      // shortfall.
      debt += -delta - splitTotal(taken);
      // Where the drained provenance is REMEMBERED, which is only about what
      // can later be restored:
      //   market_buy  → at risk, restorable by a sell/payout/void;
      //   spend       → a sink, restorable by a refund;
      //   admin_adjust with a negative delta, or clawback → remembered nowhere.
      // That last case is the reason this is a switch and not a ternary: a
      // clawback recorded as a sink spend would let a later, unrelated refund
      // restore provenance that was confiscated, inventing backing that no
      // longer exists.
      if (e.kind === "market_buy") add(atRiskInMarkets, taken);
      else if (e.kind === "spend") add(spentOnSinks, taken);
      continue;
    }

    // ── credits ──
    const bucket = CREDIT_BUCKET[e.kind];
    // grantsReceived counts the FULL positive admin_adjust delta (lifetime
    // received, per its docblock) — BEFORE the debt-payoff early exit below,
    // which can consume the entire credit and `continue` past it. A grant
    // that arrived while the wallet owed money still WAS received.
    if (bucket === "granted") grantsReceived += delta;

    // A wallet in debt pays it off first.
    let credit = delta;
    if (debt > 0) {
      const paid = Math.min(debt, credit);
      debt -= paid;
      credit -= paid;
      if (credit === 0) continue;
    }

    if (bucket !== null) {
      split[bucket] += credit;
      continue;
    }

    // A restoring credit: give back what the matching debit took, then treat
    // any excess as newly minted.
    const pool = e.kind === "refund" ? spentOnSinks : atRiskInMarkets;
    // A restoring credit uses RESTORE_POLICY, which is deliberately neither
    // the credit's own policy nor the matching debit's. See its definition.
    const restored = drain(pool, credit, RESTORE_POLICY);
    subtract(pool, restored);
    add(split, restored);
    const excess = credit - splitTotal(restored);
    if (excess > 0) split.winnings += excess;
  }

  return { split, atRiskInMarkets, spentOnSinks, grantsReceived, debt };
}

/** The headline: how much of this balance is backed by real money.
 *  `purchased` only — grants are not money the house received, and winnings are
 *  points the house minted.
 *
 *  Kept as a named function rather than an inlined `.purchased` because "backed
 *  by real money" is a DEFINITION, and a definition that lives in one place can
 *  be revised in one place. */
// @parked consumed by scripts/provenance-report.ts, which prints this as its
// headline figure — outside check-orphans' app/ scan, hence the tag.
export function moneyBacked(split: Split): number {
  return split.purchased;
}
