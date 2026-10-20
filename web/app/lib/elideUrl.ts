// Shortening a bare URL for display.
//
// Rendered whole with `break-all`, a 200-character tracking URL shreds across
// several lines of chat and buries the conversation around it.
//
// THE SECURITY CONSTRAINT IS THE WHOLE DESIGN. The moment visible text stops
// equalling the href, this is a display string that can misrepresent where a
// link goes. Three rules follow, and none of them is a style preference.
//
//   1. THE HOST IS NEVER TRUNCATED — not even when it alone exceeds the budget.
//      A cut host is precisely the misrepresentation risk: `verylongevil.com`
//      shortened to `verylong…` could be anything at all. A long line is a worse
//      READING experience; a truncated host is a worse SECURITY one, and that
//      trade is not close.
//
//   2. ELIDE THE TAIL, NEVER THE MIDDLE. Middle-elision keeps the end visible,
//      which is often the informative part — and it is also how
//      `evil.com/…/paypal.com/login` ends up on screen with a trusted-looking
//      domain as the LAST thing a reader's eye lands on. Cutting from the tail
//      guarantees the only domain-shaped token near the front is the real host,
//      and anything that could impersonate stays behind the ellipsis.
//
//   3. `http://` STAYS VISIBLE, `https://` DOES NOT. Hiding the scheme buys
//      eight characters on the overwhelmingly common case; showing it on the
//      insecure one turns saved space into a signal. Never the reverse.
//
// The full (tracking-stripped) href remains on `title` and is
// what the copy affordance yields, so nothing is actually lost — only moved
// out of the way.

/** Total visible characters to aim for. Roughly one line of chat at default size. */
// @test-only elideUrl.test.ts asserts against the budget rather than a magic number.
export const URL_DISPLAY_BUDGET = 48;

export type ElidedUrl = {
  /** What to render. */
  display: string;
  /** Was anything hidden? Drives the copy affordance — there is no point
   *  offering "copy the full link" when the full link is already on screen. */
  elided: boolean;
};

/**
 * A display string for `href`, at most ~`budget` characters, with the host
 * intact.
 *
 * Returns the href unchanged when it already fits or cannot be parsed — an
 * unparseable string is not a URL that can be safely shortened, and guessing at
 * its structure is how a host gets cut in half.
 */
export function elideUrl(href: string, budget: number = URL_DISPLAY_BUDGET): ElidedUrl {
  const raw = String(href);

  let u: URL | null;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }

  // Userinfo is ALWAYS elided out of the display, even under budget.
  // `https://youtube.com@evil.example/x` is the classic trusted@evil spoof: a
  // browser goes to evil.example, and everything before the `@` is costume.
  // The display below is built from the PARSED host, so what the reader sees
  // is where the click goes — and `elided: true` surfaces the copy affordance,
  // which yields the untouched href.
  const hasUserinfo = u !== null && (u.username !== "" || u.password !== "");

  if (!hasUserinfo && raw.length <= budget) return { display: raw, elided: false };
  if (u === null) {
    // NOT a fallback truncation. Cutting a string that could not be parsed risks
    // cutting inside the host, which rule 1 forbids. Show it whole and let
    // `break-all` deal with it.
    return { display: raw, elided: false };
  }

  // Rule 3: the scheme is dropped only when it is the safe, expected one.
  const scheme = u.protocol === "https:" ? "" : `${u.protocol}//`;
  // `host`, not `hostname` — a non-default port is part of where this goes.
  // `www.` is NOT stripped here: this string is what a reader checks the
  // destination against, and quietly editing it is the habit that makes the
  // whole display untrustworthy.
  const host = u.host;
  const head = scheme + host;

  // Everything after the host, as the author wrote it — found CASE-INSENSITIVELY,
  // because `u.host` is lowercased by the parser and `raw` is not: a missed
  // indexOf would slice mid-host and render duplicated fragments like
  // `example.comAMPLE.COM/…`. An IDN host (punycoded by the parser, so never
  // findable in `raw`) falls back to the parsed parts.
  // A userinfo URL never searches `raw` at all: `evil.example@evil.example`
  // would find the COSTUME copy first and splice the userinfo back in.
  const idx = hasUserinfo ? -1 : raw.toLowerCase().indexOf(host);
  const rest = idx >= 0 ? raw.slice(idx + host.length) : u.pathname + u.search + u.hash;
  if (!rest || rest === "/") return { display: head, elided: raw !== head };

  // Rule 1: if the host alone is already over budget, it still goes out whole.
  const room = budget - head.length - 1; // -1 for the ellipsis
  if (room <= 1) return { display: head + "…", elided: true };

  // Rule 2: keep the FRONT of the path, drop the tail.
  if (rest.length <= room) return { display: head + rest, elided: hasUserinfo };
  return { display: head + rest.slice(0, room) + "…", elided: true };
}
