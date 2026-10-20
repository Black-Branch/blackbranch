// Tracking-parameter stripping.
//
// STRIP ON DISPLAY, KEEP THE STORED LINK AS TYPED. The consequence is worth
// stating plainly because it is not the obvious reading:
//
//   • the DATABASE keeps the URL verbatim. Rewriting what somebody actually
//     wrote is unrecoverable, and a moderation review that shows a link the
//     sender did not send is worse than useless.
//   • DISPLAY, HREF and COPY all use the stripped URL. Stripping only the
//     visible text while the href kept its tracking params would be pure
//     theatre — the click still phones home — and the copy button would hand
//     over a different link than the one the reader followed.
//
// So: one stored record, one visible truth.
//
// THE FAILURE MODE THAT MATTERS IS A BROKEN LINK, NOT A SURVIVING PARAM. A
// tracking param that slips through costs a viewer some privacy they had
// already half-lost by clicking; a link that 404s because we removed something
// load-bearing costs the conversation the thing it was about. Every judgement
// call below therefore resolves toward KEEPING.

/**
 * Parameters that are pure attribution wherever they appear.
 *
 * Deliberately conservative: an entry earns its place by being meaningless to
 * the destination server's routing. Anything that might select CONTENT — `id`,
 * `ref`, `source`, `v`, `p`, `q` — is absent on purpose, however tracking-ish it
 * looks, because guessing wrong there breaks the link.
 */
const GLOBAL_TRACKING = new Set([
  // Google Analytics / Urchin
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_source_platform", "utm_creative_format", "utm_marketing_tactic",
  // ad-click identifiers
  "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "fbclid",
  "twclid", "ttclid", "yclid", "igshid", "igsh", "rdt_cid", "li_fat_id",
  // Share-attribution. Stripped EVERYWHERE, YouTube included: the link works
  // without it.
  "si",
  // email/campaign platforms
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "vero_id", "vero_conv",
  "oly_anon_id", "oly_enc_id", "mkt_tok", "trk", "trkCampaign",
  // misc analytics
  "_ga", "_gl", "ml_subscriber", "ml_subscriber_hash", "wickedid",
  "hsa_acc", "hsa_cam", "hsa_grp", "hsa_ad", "hsa_src", "hsa_tgt",
  "hsa_kw", "hsa_mt", "hsa_net", "hsa_ver",
]);

// There is deliberately no per-host keep-list: an empty mechanism idling is
// worse than none. If a real host exception ever appears, add one — and use
// linkGate's hostMatches for the host compare, not a local near-copy.

export type Stripped = {
  /** The URL to display, link to, and copy. */
  clean: string;
  /** Parameter names removed. Empty when nothing changed. */
  removed: string[];
};

/**
 * Remove pure-tracking query parameters from `href`.
 *
 * Returns the input unchanged when it cannot be parsed, when there is no query
 * string, or when nothing matched — including the SAME string, so callers can
 * compare by identity if they want to know whether anything happened.
 */
export function stripTracking(href: string): Stripped {
  const raw = String(href);
  // Cheap bail-out: no query, nothing to strip. This runs per rendered link.
  if (!raw.includes("?")) return { clean: raw, removed: [] };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Unparseable — leave it entirely alone rather than guessing at its shape.
    return { clean: raw, removed: [] };
  }

  const removed: string[] = [];
  for (const name of [...u.searchParams.keys()]) {
    const lower = name.toLowerCase();
    // `utm_*` is matched by prefix as well as by name — the list above cannot
    // enumerate every variant marketing tools invent, and the prefix is
    // unambiguous in a way a bare guess is not.
    if (GLOBAL_TRACKING.has(lower) || lower.startsWith("utm_")) {
      u.searchParams.delete(name);
      removed.push(name);
    }
  }

  if (removed.length === 0) return { clean: raw, removed: [] };

  // Rebuilt from the parsed URL, so a `?` with nothing left after it does not
  // survive as a dangling character. `searchParams` re-encodes, which can differ
  // cosmetically from what was typed — acceptable HERE precisely because the
  // stored copy is untouched and this string is only ever the display/click.
  if (![...u.searchParams.keys()].length) u.search = "";
  return { clean: u.toString(), removed };
}
