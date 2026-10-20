// Fund the Night: the credit line's rotation math — pure, DOM-less, so the
// web-served overlay (/overlay/credit, CreditOverlay.tsx) and its node test
// share one definition. Ported 1:1 from the rig's credit.html overlay: the
// frame arrives sorted biggest-weight first, each name dwells longer for a
// bigger share, and a 0.7s fade separates names.
//
// DWELL_MIN_MS / DWELL_MAX_MS mirror credit.html's constants by hand — the
// static overlay stays as the fallback source, and the two must agree or the
// same pool reads at two speeds depending on which source OBS is showing.
import type { Sponsor } from "./sponsorClock";

const DWELL_MIN_MS = 6000;
const DWELL_MAX_MS = 14000;
export const FADE_MS = 700;

/** Dwell for a share of the pool: linear from DWELL_MIN (0%) to DWELL_MAX (100%).
 *  Module-private: deriveCreditList is its caller; tests pin it through that. */
function dwellMsFor(weightPct: number): number {
  let pct = Number(weightPct);
  if (!Number.isFinite(pct)) pct = 0;
  pct = Math.max(0, Math.min(100, pct));
  return DWELL_MIN_MS + (DWELL_MAX_MS - DWELL_MIN_MS) * (pct / 100);
}

export type CreditEntry = {
  name: string;
  weightPct: number;
  clockRemainSec: number;
  dwellMs: number;
};

/**
 * A `sponsorState` pool -> the list the rotation cycles. Empty -> the overlay
 * renders nothing (credit.html's `visible: false` contract). Rows without a
 * name are dropped; malformed numbers read as 0 rather than NaN-ing a timer.
 */
export function deriveCreditList(sponsors: readonly Sponsor[] | null | undefined): CreditEntry[] {
  if (!Array.isArray(sponsors)) return [];
  const out: CreditEntry[] = [];
  for (const s of sponsors) {
    const name = String(s?.name ?? "").trim();
    if (!name) continue;
    const pct = Number(s?.weightPct);
    const clock = Number(s?.clockRemainSec);
    out.push({
      name,
      weightPct: Number.isFinite(pct) ? pct : 0,
      clockRemainSec: Number.isFinite(clock) && clock > 0 ? clock : 0,
      dwellMs: dwellMsFor(pct),
    });
  }
  return out;
}

/** Names the style lookup still needs, lower-cased and de-duplicated. */
export function namesNeedingStyle(list: readonly CreditEntry[], known: ReadonlySet<string>): string[] {
  const want = new Set<string>();
  for (const e of list) {
    const k = e.name.toLowerCase();
    if (!known.has(k)) want.add(k);
  }
  return [...want];
}
