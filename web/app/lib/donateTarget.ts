// Where "Donate" goes. Pure, no imports — the server reads the inputs.
//
// A payment provider on (Stripe or PayPal) → the site's own tip page. Otherwise the outside donate
// link the streamer set (`site.donateUrl`), and only an https one. Otherwise nowhere: the button is
// hidden (and stream-ingest's !dono answers that donations aren't set up here) — never a button
// that leads to "Billing isn't configured".

/** The site's own tip page. */
const OWN_DONATE_PAGE = "/donate";

/** An https address, or null — anything else (http, javascript:, a bare word) is not a link. */
export function httpsLink(raw: string | null | undefined): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** The Donate button's address: the site's own page, the outside link, or null for no button. */
export function donateTarget(input: { providerOn: boolean; donateUrl: string | null | undefined }): string | null {
  if (input.providerOn) return OWN_DONATE_PAGE;
  return httpsLink(input.donateUrl);
}
