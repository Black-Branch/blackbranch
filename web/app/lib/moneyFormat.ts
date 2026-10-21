// Money: the one currency this site charges in, and the one way an amount is written.
// Universal (client and server), no imports.
//
// Tips, point purchases and donations are charged in SITE_CURRENCY — every checkout route, the
// PayPal order and the PayPal capture check read it from here, so they cannot disagree. The points
// peg (1 point per cent) and the support bar are built on it; a currency setting is after the beta
// (report §J). The Supporter subscription is the exception: its price and currency come from the
// Stripe Price the install names (supporterPrice.ts), and a gift charges that.

/** Lower-case ISO 4217, as Stripe writes it. */
export const SITE_CURRENCY = "usd";

/** The same code as PayPal writes it ("USD"). */
export function paypalCurrencyCode(currency: string = SITE_CURRENCY): string {
  return currency.toUpperCase();
}

/** How many minor units the currency has after the point (2 for usd, 0 for jpy). */
function fractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** An amount in the currency's minor units (Stripe's unit_amount) as a person writes it:
 *  "$5", "$4.50", "€7", "¥500". A whole amount drops its ".00". An unknown code falls back to
 *  "5.00 XYZ" rather than throwing. */
export function formatPrice(minor: number, currency: string = SITE_CURRENCY): string {
  const digits = fractionDigits(currency);
  const value = minor / 10 ** digits;
  const whole = Number.isInteger(value);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

/** The currency's own sign ("$", "€"), for the prefix inside an amount box. */
export function currencySign(currency: string = SITE_CURRENCY): string {
  try {
    const part = new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() })
      .formatToParts(0).find((p) => p.type === "currency");
    return part?.value ?? currency.toUpperCase();
  } catch {
    return currency.toUpperCase();
  }
}
