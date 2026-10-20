'use strict';
// Fund-the-Night: the pure math core.
//
// A stream night is `durationSec` long. The first `seedSec` of it is
// pre-funded free territory — it carries no price, nobody buys it. Everything
// from `seedSec` to `durationSec` is SELLABLE, and gets tiled into hour-long
// (3600s) blocks (the last one may be partial). The night has one price —
// `nightPriceCents` — and that price is spread across the sellable blocks by
// a weight curve that rises toward the end of the night (`makeWeights`): later
// hours cost more per second than earlier ones, because a donation late in
// the night is worth more to the schedule than one made at the top.
//
// `convertCents` is the other half: given a pile of donation cents and a
// FRONTIER (how far into the night is currently funded), walk forward block
// by block, buying seconds at each block's rate, until either the money or
// the night runs out. Money left when the frontier reaches `durationSec` is
// `overflowCents` — there's nothing further to price, so timer.js is left to
// decide what an encore looks like. `extendBlocks` builds that encore: more
// hour blocks, priced flat at whatever the final real block was charging per
// second. `drainOverflow` is `convertCents` under a second name — a
// deliberate alias, kept only so callers spending fresh cents read differently
// from callers spending money that already overflowed.
//
// PURE ON PURPOSE. No I/O, no Date, no randomness — every input this module
// needs (durations, cents, a frontier) is a plain number handed in by the
// caller. That is what makes it possible to hand-verify every case in the
// test file. timer.js wires it in, where `now` and the DB live.
//
// Money bookkeeping is integer cents in and integer cents out at the layout
// boundary (`layoutBlocks` sums to EXACTLY `priceCents`, via largest-remainder
// rounding — no cent is silently dropped or invented). `convertCents` itself
// walks in exact rational terms where a block is spent whole (subtracting the
// block's own integer `cents`, never a recomputed rate*len that could drift by
// half a cent) and only touches floating per-second rates for a PARTIAL
// block — then rounds the returned `seconds` at the very end: fractional
// seconds exist only in the walk, never in what's reported.

const HOUR_SEC = 3600;
const KNEE_T = 0.6; // ramp position where the curve's slope changes
const W_START = 0.8;
const W_KNEE = 1.0;
const W_END = 1.7;

/**
 * The per-block price-weight curve: 0.8 at the top of the night, rising
 * linearly to 1.0 at 60% of the way through the ramp, then rising faster
 * (1.0→1.7) across the last 40%. `n=1` is a degenerate single-block night —
 * there's no ramp to walk, so it's just `[1]`. `n=0` — no sellable territory
 * at all — is `[]`: the contract is an array of length `n`, always.
 *
 * @param {number} n block count
 * @returns {number[]}
 */
function makeWeights(n) {
  if (n === 0) return [];
  if (n === 1) return [1];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out[i] = t <= KNEE_T
      ? W_START + (W_KNEE - W_START) * (t / KNEE_T)
      : W_KNEE + (W_END - W_KNEE) * ((t - KNEE_T) / (1 - KNEE_T));
  }
  return out;
}

/**
 * The whole night's price: a $24/h floor over the TOTAL duration (seed
 * territory included — the floor prices the whole night, not just the
 * sellable part), or the amount still required to hit the day's target,
 * whichever is larger.
 *
 * @param {number} durationSec
 * @param {number} requiredCentsPerDay falsy (0/undefined) when there's no
 *   snapshot to require against
 * @returns {number} integer cents
 */
function nightPriceCents(durationSec, requiredCentsPerDay) {
  const floorCents = Math.round(2400 * durationSec / HOUR_SEC);
  return Math.max(floorCents, requiredCentsPerDay || 0);
}

/**
 * Tiles `[seedSec, durationSec)` into hour blocks (the last may be partial)
 * and distributes `priceCents` across them proportional to
 * `weight × (lenSec/3600)` — a partial last block counts for less of the
 * curve, not the full hour's weight. Distribution uses largest-remainder
 * rounding so the integer `cents` on every block sum to EXACTLY `priceCents`;
 * plain per-block rounding would drift the total by a cent or two.
 *
 * @param {number} durationSec
 * @param {number} seedSec free territory before the first sellable second
 * @param {number} priceCents whole-night price to distribute
 * @returns {{startSec: number, lenSec: number, cents: number}[]}
 */
function layoutBlocks(durationSec, seedSec, priceCents) {
  const sellableLen = durationSec - seedSec;
  const n = Math.max(0, Math.ceil(sellableLen / HOUR_SEC));
  const weights = makeWeights(n);

  const starts = new Array(n);
  const lens = new Array(n);
  const weighted = new Array(n);
  let totalWeighted = 0;
  for (let i = 0; i < n; i++) {
    const startSec = seedSec + i * HOUR_SEC;
    const lenSec = Math.min(HOUR_SEC, durationSec - startSec);
    starts[i] = startSec;
    lens[i] = lenSec;
    weighted[i] = weights[i] * (lenSec / HOUR_SEC);
    totalWeighted += weighted[i];
  }

  // Largest-remainder rounding: floor every share, then hand the leftover
  // whole cents to the blocks whose fractional share was closest to rounding
  // up, biggest fraction first.
  const raw = weighted.map((w) => (totalWeighted > 0 ? (w / totalWeighted) * priceCents : 0));
  const cents = raw.map(Math.floor);
  const assigned = cents.reduce((a, b) => a + b, 0);
  let leftover = priceCents - assigned;
  const byFracDesc = raw
    .map((r, i) => ({ i, frac: r - cents[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < byFracDesc.length && leftover > 0; k++, leftover--) {
    cents[byFracDesc[k].i] += 1;
  }

  const blocks = new Array(n);
  for (let i = 0; i < n; i++) {
    blocks[i] = { startSec: starts[i], lenSec: lens[i], cents: cents[i] };
  }
  return blocks;
}

/**
 * Walks forward from `frontierSec`, buying seconds at each block's
 * `cents/lenSec` rate until `cents` runs out or the blocks run out (at
 * `durationSec`). A block consumed in full is paid for with its own integer
 * `cents` (never a recomputed rate×len, which can drift a fraction of a
 * cent); only a PARTIAL final block touches the floating per-second rate,
 * and only the returned `seconds` gets rounded — the walk itself stays exact.
 * Money left over once the frontier reaches `durationSec` is `overflowCents`.
 *
 * INVARIANT: `frontierSec` must be at or after `blocks[0].startSec` — the
 * timer always starts the frontier at `seedSec`, which IS the first sellable
 * block's start, so a lower frontier is a caller bug (it would silently price
 * the free seed region), not a real state, and this throws rather than
 * pricing it. INVARIANT: `blocks` must not extend past `durationSec` — a
 * caller that grows `blocks` with `extendBlocks(blocks, addSec)` must widen
 * `durationSec` by that same `addSec`, or the walk would silently stop short
 * and hand back the money as overflow with the added time unpriced.
 *
 * @param {number} cents donation cents to spend
 * @param {number} frontierSec where funded time currently ends
 * @param {{startSec:number, lenSec:number, cents:number}[]} blocks
 * @param {number} durationSec
 * @returns {{seconds: number, overflowCents: number}}
 */
function convertCents(cents, frontierSec, blocks, durationSec) {
  if (blocks.length && frontierSec < blocks[0].startSec) {
    throw new Error('convertCents: frontierSec below first sellable block');
  }
  if (blocks.length) {
    const last = blocks[blocks.length - 1];
    if (last.startSec + last.lenSec > durationSec) {
      throw new Error('convertCents: blocks extend past durationSec — widen durationSec to match extendBlocks');
    }
  }

  let remaining = cents;
  let consumed = 0;
  let frontier = frontierSec;

  for (const block of blocks) {
    if (remaining <= 0) break;
    // durationSec is now guaranteed >= the last block's end (checked above),
    // so this is never actually a clamp in practice — it's kept as the
    // explicit statement of the invariant the walk relies on.
    const blockEnd = Math.min(block.startSec + block.lenSec, durationSec);
    if (blockEnd <= frontier) continue; // already funded past this block

    const startInBlock = Math.max(frontier, block.startSec);
    const availSec = blockEnd - startInBlock;
    const full = availSec === block.lenSec;
    const rate = block.cents / block.lenSec; // cents per second
    const costForAvail = full ? block.cents : rate * availSec;

    if (remaining >= costForAvail) {
      frontier = blockEnd;
      consumed += costForAvail;
      remaining -= costForAvail;
    } else {
      const secBought = remaining / rate;
      frontier = startInBlock + secBought;
      consumed += remaining;
      remaining = 0;
    }
  }

  const overflowCents = remaining;
  // Never lose a cent: what got spent plus what's left over must reconstruct
  // the input, within floating-point tolerance.
  if (Math.abs(consumed + overflowCents - cents) > 1e-6) {
    throw new Error(
      `night-math: convertCents lost cents — consumed ${consumed} + overflow ${overflowCents} !== input ${cents}`
    );
  }

  return { seconds: Math.round(frontier - frontierSec), overflowCents };
}

/**
 * `convertCents` under a second name for overflow-spending call sites — the
 * math is identical (money is money), but "drain the overflow" and "convert
 * fresh cents" are different intents at the call site, so they get different
 * names. Deliberate duplication-by-alias.
 */
const drainOverflow = convertCents;

/**
 * Appends more hour blocks (the last may be partial) after the end of
 * `blocks`, priced flat at the FINAL existing block's per-second rate — a
 * flat-rate encore once the night's own priced schedule has run out.
 *
 * @param {{startSec:number, lenSec:number, cents:number}[]} blocks
 * @param {number} addSec total seconds to append
 * @returns {{startSec:number, lenSec:number, cents:number}[]}
 */
function extendBlocks(blocks, addSec) {
  if (!blocks.length) {
    throw new Error('extendBlocks: no existing blocks to price from');
  }
  const last = blocks[blocks.length - 1];
  const rate = last.cents / last.lenSec;
  const out = blocks.slice();

  let start = last.startSec + last.lenSec;
  let remaining = addSec;
  while (remaining > 0) {
    const lenSec = Math.min(HOUR_SEC, remaining);
    out.push({ startSec: start, lenSec, cents: Math.round(rate * lenSec) });
    start += lenSec;
    remaining -= lenSec;
  }
  return out;
}

module.exports = {
  makeWeights,
  nightPriceCents,
  layoutBlocks,
  convertCents,
  extendBlocks,
  drainOverflow,
};
