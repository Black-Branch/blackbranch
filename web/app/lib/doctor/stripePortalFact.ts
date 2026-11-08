// The Doctor's Stripe row also needs the customer portal saved: billingPortal.sessions.create
// refuses without the account's default portal configuration, so every subscriber's "Manage
// subscription" (the one in-site way to cancel) fails until the streamer saves it once (A1-07).

type CheckFact = { ok: boolean | null; code: string; detail: string };
type ProviderFact = { on: boolean; test: CheckFact | null };

/** Asked only once the webhook passes, and only a portal NEVER saved replaces the row's verdict
 *  (a key that may not read it keeps the webhook's verdict: the site cannot know). */
export async function withStripePortal(stripe: ProviderFact, check: (test: string) => Promise<CheckFact>): Promise<ProviderFact> {
  if (!stripe.on || stripe.test?.ok !== true || stripe.test.code !== "accepted") return stripe;
  const portal = await check("stripe-portal");
  return portal.code === "no_portal" ? { ...stripe, test: portal } : stripe;
}
