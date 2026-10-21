// The support feature's PUBLIC API.
//
// TipForm — the one-time-tip form. SupportContent's donation section and the
// standalone /donate page render it. Keeping it behind this index (rather than
// a direct file import) is what lets both surfaces share one mechanism instead
// of drifting into copies.
//
// TipPayButton — the split card/PayPal/Venmo button. TipForm renders it with
// purpose="points" when its own Announce switch is off (a quiet Qorm
// purchase); every other TipForm mount is a tip.

export { TipForm } from "./TipForm";
export type { TipDraft } from "./TipForm";
export { TipPayButton } from "./TipPayButton";
export { checkoutRequestFor } from "./tipCheckout";
// The PayPal subscribe button (subscription sources S3) and the words for a viewer's
// subscriptions, one line per service — SupportContent's Supporter section renders both.
export { PayPalSubscribeButton } from "./PayPalSubscribeButton";
export { recordLine, isLiveRecord, elsewhereWarning } from "./subscriptionLines";
export type { SubscriptionRecordView } from "./subscriptionLines";
