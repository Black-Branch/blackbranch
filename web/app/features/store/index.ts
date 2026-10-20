// The store feature's PUBLIC API — the only thing outside this folder may import.
//
// The pattern every module under app/features/ follows: features are optional
// and self-registering; the test of done is "delete the folder and the app
// still builds".
//
// The rule check-structure.mjs enforces: anything outside app/features/store/
// imports THIS file, never a file inside the folder. That is what makes the
// feature replaceable — StoreContent/StoreSpend can be rewritten, split or
// renamed without touching a single caller, because no caller can name them.
//
// The store's edges are genuinely clean: one external entry point, and
// everything below it is internal. `app/lib/coins.ts` deliberately is NOT
// here — it is not store internals, it is the shared price/vocabulary table
// used across the app. Features that CHARGE a price legitimately depend on the
// price list; that is shared vocabulary, not coupling.
//
// The store is a PAGE of the account card, so the card renders the content
// directly; there is no modal.

export { default as StoreContent } from "./StoreContent";
