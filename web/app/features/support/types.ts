// The support feature's shared TYPES only — split out so TipPayButton.tsx and
// PayPalButton.tsx can depend on `TipDraft` without a type-only import cycle
// back through TipForm.tsx (which imports TipPayButton at runtime).
// check-structure.mjs treats a type-only cycle as a warning, not a failure —
// erased at build, no runtime loop — but there is no reason to carry one when
// a one-line split avoids it outright.
export type TipDraft = {
  amount: number; // dollars, already validated in the PAY_MIN/MAX_CENTS range
  message: string; // already within the reading tier for `amount`
  displayName: string; // "" when not given
  anonymous: boolean;
  /** "Announce on stream" (Qorm-for-all-income piece 3). true = a tip: it
   *  plays on stream and posts to the tip routes. false = a quiet Qorm
   *  purchase: message/displayName/anonymous are always ""/""/false, and the
   *  host posts to /api/billing/points (checkoutRequestFor, tipCheckout.ts). */
  announce: boolean;
};
