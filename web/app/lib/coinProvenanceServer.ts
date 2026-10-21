// Server side of coinProvenance.ts: read a wallet's ledger and fold it.
//
// READ-ONLY, and deliberately so. This module exists to MEASURE how much of the
// currency in circulation is backed by real money; it writes nothing, holds no
// state, and adds no column to the currency tables. That is the whole reason it
// is safe to add to a live economy — coinsServer.ts is the one file where a bug
// mints currency, and this does not touch it.
//
// Derived on read rather than materialised: a ledger of tens of thousands of
// rows folds in milliseconds, and a materialised split would be a second
// writer that can drift from the ledger it summarises. If this ever needs to be
// fast, materialise it THEN, with the fold already proven.
import type { PoolClient } from "pg";
import pool from "../../lib/db.ts";
import {
  attribute, attributionBalance,
  type Attribution, type DrainPolicyFor, type LedgerEntry,
} from "./coinProvenance.ts";

/** Anything that can run the fold's query — the pool, or a transaction's
 *  client when the answer has to be consistent with a lock the caller holds.
 *  No caller passes one (see attributeWallet's docblock below); kept
 *  for the next write that needs it. */
type Queryable = Pick<PoolClient, "query">;

function toEntry(r: { kind: string; delta: string | number }): LedgerEntry {
  // delta is BIGINT, so pg hands it back as a string. Number() is safe at these
  // magnitudes (the largest single row is the 100M grant, ~2^27) but the cast
  // is stated rather than implied — an unconverted string would make `+` a
  // concatenation and produce nonsense that still type-checks as a number.
  return { kind: r.kind as LedgerEntry["kind"], delta: Number(r.delta) };
}

export type WalletAttribution = Attribution & { matrixId: string; balance: number };

/** `id ASC` IS THE CONTRACT, not a preference — stated once, used by both
 *  queries below. `attribute` folds oldest-first: the ordered policies and
 *  every restoring credit depend on it.
 *
 *  This is the OPPOSITE of `coin_ledger_matrix_idx` (matrix_id, id DESC), the
 *  index the currency history tab reads through — so an "obvious" reuse of that
 *  query silently produces a plausible, wrong answer. */
const ONE_WALLET_SQL =
  `SELECT kind, delta FROM site.coin_ledger WHERE matrix_id = $1 ORDER BY id ASC`;

/** One wallet, folded. The only caller is `app/api/points/balance/route.ts`,
 *  which passes no client and gates nothing — the result just feeds the
 *  wallet's earned parenthetical, display only.
 *
 *  The `client` parameter has no current caller. It stays because any future
 *  write that gates on the split must fold on the transaction's client after
 *  the wallet row is locked — the race that guards against (another request
 *  moving the balance between the check and the debit) is still real.
 *
 *  Derived on read, never materialised — see this file's header. The largest
 *  wallets are on the order of a thousand rows. */
export async function attributeWallet(
  matrixId: string,
  policy: DrainPolicyFor,
  client?: Queryable
): Promise<WalletAttribution> {
  const { rows } = await (client ?? pool).query<{ kind: string; delta: string | number }>(
    ONE_WALLET_SQL, [matrixId]
  );
  const a = attribute(rows.map(toEntry), policy);
  return { matrixId, balance: attributionBalance(a), ...a };
}

/** Every wallet, folded. One query for the whole ledger rather than N+1: the
 *  ledger is small and grouping in JS keeps the ORDER BY id ASC contract in one
 *  place instead of once per wallet. */
//
// Takes `DrainPolicyFor`, not `DrainPolicy`. The PRODUCT policy is a function
// of the ledger kind (a market_buy drains differently from a store spend), and
// the narrower type would let provenance-report print only the three
// UNIFORM policies — none of which the product uses. `attribute` accepts both.
//
// @parked consumed by scripts/provenance-report.ts (outside check-orphans'
// app/ scan). There is deliberately no per-wallet variant — if an admin
// surface or an enforcement rule ever needs one it is four lines, and a
// speculative second entry point is the shape this gate catches.
export async function attributeAllWallets(policy: DrainPolicyFor): Promise<WalletAttribution[]> {
  // `id ASC` IS THE CONTRACT, not a preference. `attribute` folds
  // oldest-first: the ordered policies and every restoring credit depend on it.
  // Note this is the OPPOSITE of `coin_ledger_matrix_idx` (matrix_id, id DESC),
  // the index the currency history tab reads through — so an "obvious" reuse of
  // that query silently produces a plausible, wrong answer.
  const { rows } = await pool.query<{ matrix_id: string; kind: string; delta: string | number }>(
    `SELECT matrix_id, kind, delta FROM site.coin_ledger ORDER BY matrix_id, id ASC`
  );
  const byWallet = new Map<string, LedgerEntry[]>();
  for (const r of rows) {
    const list = byWallet.get(r.matrix_id);
    if (list) list.push(toEntry(r));
    else byWallet.set(r.matrix_id, [toEntry(r)]);
  }
  return [...byWallet].map(([matrixId, entries]) => {
    const a = attribute(entries, policy);
    return { matrixId, balance: attributionBalance(a), ...a };
  });
}
