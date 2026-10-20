// Whether this install's PayPal is the SANDBOX, as the server last said (useBillingAvailability,
// useStripe.ts; /donate's page.tsx for its first paint). The PayPal SDK loader reads it to add
// PayPal's sandbox-only `buyer-country=US` (Venmo is US-only, and the sandbox needs it to present a
// US buyer). PayPal rejects that parameter on live, so anything but an explicit sandbox answer is
// live. Module state on purpose, the shape setStripePublishableKey (stripeClient.ts) uses: the SDK
// is one shared script per page, so its URL is one shared answer.

let sandbox = false;

export function setPaypalSandbox(value: boolean): void {
  sandbox = value === true;
}

export function paypalSandbox(): boolean {
  return sandbox;
}
