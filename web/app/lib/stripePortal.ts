// Stripe's customer portal: telling "the streamer never saved the portal's settings" apart from any
// other refusal. billingPortal.sessions.create needs the account's DEFAULT configuration, which
// exists only once the portal settings were saved in Stripe (per mode, live or test).

/** What /api/billing/portal answers (409) when the portal was never saved; the panel reads it. */
export const PORTAL_NOT_SET_UP = "portal_not_set_up";

/** Stripe's own refusal for a never-saved portal. */
export function isPortalNotSetUp(e: unknown): boolean {
  const err = e as { type?: string; message?: string } | null;
  return err?.type === "StripeInvalidRequestError"
    && /default configuration has not been created|saving your customer portal settings/i.test(err.message ?? "");
}
