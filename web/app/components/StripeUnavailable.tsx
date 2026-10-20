"use client";

// Shown in place of Stripe's embedded checkout when js.stripe.com never loaded.
//
// Without it, a viewer whose browser blocks the script presses Donate and gets
// an empty box — no error, no spinner, nothing to press.
//
// The wording names the likely cause in the viewer's own terms rather than
// "failed to load Stripe.js", because the fix is theirs to make: it is almost
// always an ad blocker, a privacy filter or a DNS blocklist, not our outage.
export default function StripeUnavailable({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  /** True while a retry is in flight — the button must not look idle, and
   *  this block must stay on screen rather than flashing back to a spinner. */
  retrying: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="text-sm text-body">
        We couldn’t load the secure payment form.
      </p>
      <p className="text-xs text-secondary">
        An ad blocker, privacy filter or network blocklist is usually what stops it — it comes from
        Stripe, our payment provider, at <span className="text-body">js.stripe.com</span>. Allowing
        that address and trying again should fix it. Nothing has been charged.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="rounded-lg bg-raised px-4 py-2 text-sm font-medium text-heading hover:bg-control transition-colors disabled:opacity-60"
      >
        {retrying ? "Trying…" : "Try again"}
      </button>
    </div>
  );
}
