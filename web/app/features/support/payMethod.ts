// The tip method the split button (TipPayButton.tsx) starts from. Remembered
// per browser, not per account: a signed-out guest gets the same "starts where
// I left off" behaviour a signed-in tipper does, and the split button reads
// this BEFORE it knows whether anyone is signed in at all.
//
// Every access goes through safeLocalStorage's lsGet/lsSet, which already
// wrap every call in try/catch (private windows throw on `localStorage.*`,
// not just on access) and are SSR-safe (`typeof window` guarded) — a second,
// hand-rolled try/catch here would be a duplicate mechanism.
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";

export type PayMethod = "card" | "paypal" | "venmo";

const KEY = "bb_tipMethod";

/** The last method actually USED (never merely selected in the menu — see
 *  TipPayButton.tsx). Defaults to "card": an unset or unrecognised stored
 *  value reads exactly the same as a first-time visitor. */
export function readLastPayMethod(): PayMethod {
  const v = lsGet(KEY);
  return v === "card" || v === "paypal" || v === "venmo" ? v : "card";
}

export function rememberPayMethod(m: PayMethod): void {
  lsSet(KEY, m);
}
