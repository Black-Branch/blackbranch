// Link-label phishing guard.
//
// A link paints arbitrary label text over the real href: `[paypal.com](https://evil.com)`
// shows "paypal.com" but goes to evil.com. The protocol is https-only at every call
// site, so this is not XSS — it is deception. When the label itself NAMES a domain
// whose host differs from the href's host, we surface the true destination so the
// trick is visible. Labels that aren't domain-like ("here", "docs", "this link") are
// left clean — no false alarms.
//
// Shared by renderText.tsx and the HTML path, so both apply the SAME guard. An HTML <a>
// is a strictly stronger spoof primitive than the markdown link this was written
// for — the label can be styled, and can contain elements — so leaving the HTML
// renderer with its own copy (or none) would reopen the hole through the wider door.
// Living in a `.ts` module also makes it directly testable: `node --test` only globs
// `app/**/*.test.ts`, so nothing inside renderText.tsx could ever be unit-tested.
//
// Callers must pass a label that has already been through `stripBidiControls`.
// A bidi override inside the label reverses how the domain READS without changing
// the bytes, so checking the raw label walks straight past the trick this exists to
// catch. Pinned by app/lib/bidi.test.ts.

/** A domain-ish run of labels: `foo.com`, `a.b.co.uk`. Global — we scan every match. */
const LABEL_DOMAIN_RE = /((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;

const norm = (h: string) => h.replace(/^www\./, "");

/**
 * The host a link REALLY goes to, when the label claims a different one.
 * Returns null when the label makes no domain claim, or the claim is honest.
 */
export function deceptiveLinkHost(label: string, href: string): string | null {
  let hrefHost: string;
  try {
    hrefHost = new URL(href).hostname.toLowerCase();
  } catch {
    return null; // unparseable href — nothing to compare against
  }
  const hh = norm(hrefHost);

  // Scan EVERY domain-like token, not just the first. Taking only the first match
  // let a spoof hide behind an honest one: `[bsky.app — really paypal.com](https://evil.com)`
  // would clear the check on "bsky.app" alone if that were also the href host.
  LABEL_DOMAIN_RE.lastIndex = 0; // /g/ regexes carry lastIndex between calls
  for (let m = LABEL_DOMAIN_RE.exec(label); m; m = LABEL_DOMAIN_RE.exec(label)) {
    const claim = m[1]!;
    // Carve-out for a PARENTHESIZED handle: "(@natalie.sh)".
    //
    // Bluesky handles genuinely are domains, and every bridged Bluesky/X embed in
    // our rooms carries one — `<a href="https://bsky.app/…">midwest emo fan
    // (@natalie.sh)</a>`. Warning on those would put a phishing badge on
    // essentially every Bluesky link, and an alarm that cries wolf on ordinary
    // content is worse than none: people learn to look past it, including on the
    // real attack.
    //
    // The parentheses are REQUIRED, and that is a security property, not a
    // formatting detail. Skipping any claim preceded by "@" would silently
    // disable the guard for `security@paypal.com` — the canonical phishing-label
    // shape — in markdown links too:
    // `[security@paypal.com](https://evil.example)` would render unflagged.
    // `Name (@handle)` is the shape mautrix actually emits, and the parens
    // visibly frame the token as an identity rather than a destination.
    const isParenthesizedHandle =
      m.index >= 2 &&
      label[m.index - 1] === "@" &&
      label[m.index - 2] === "(" &&
      label[m.index + claim.length] === ")";
    if (isParenthesizedHandle) continue;

    const lh = norm(claim.toLowerCase());
    // Honest if the claimed domain IS the href host, a parent of it, or a subdomain.
    const honest = hh === lh || hh.endsWith("." + lh) || lh.endsWith("." + hh);
    if (!honest) return hrefHost; // the real place this link actually goes
  }
  // Every claim in the label matched the href (or there were none) → not deceptive.
  return null;
}

/**
 * The host to show beside a markdown link whose LABEL says nothing about it.
 *
 * THIS EXISTS BECAUSE MULTI-WORD LABELS EXIST. A single-token label is usually
 * the URL itself or one word, and the only real risk is a label that CLAIMS a
 * domain and goes somewhere else — which is `deceptiveLinkHost`'s job, and
 * which warns in amber.
 *
 * A friendly multi-word label makes no claim at all: "click here for the thing"
 * is not deceptive by that test, and yet the reader has no idea where it goes.
 * So the destination is visible for every markdown link, not only the
 * alarming ones.
 *
 * Returns null when the label already makes the destination obvious — repeating
 * it would be noise, and a chip that appears on everything is a chip nobody
 * reads, which is the same failure mode the parenthesized-handle carve-out above
 * exists to avoid.
 *
 * Callers must pass a label that has already been through `stripBidiControls`,
 * for exactly the reason `deceptiveLinkHost` does — and must call this only when
 * that guard returned null, so a deceptive link shows the WARNING rather than a
 * neutral chip.
 */
export function linkDestinationHost(label: string, href: string): string | null {
  let host: string;
  try {
    host = new URL(href).hostname.toLowerCase();
  } catch {
    return null;
  }
  const h = norm(host);
  if (!h) return null;

  // Already obvious: the label mentions the host (or a parent/child of it).
  // `deceptiveLinkHost` has already established that any domain claim here is
  // HONEST, so a match means the reader can see the destination.
  LABEL_DOMAIN_RE.lastIndex = 0;
  for (let m = LABEL_DOMAIN_RE.exec(label); m; m = LABEL_DOMAIN_RE.exec(label)) {
    const claim = norm(m[1]!.toLowerCase());
    if (claim === h || h.endsWith("." + claim) || claim.endsWith("." + h)) return null;
  }
  return h;
}
