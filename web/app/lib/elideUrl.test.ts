// URL eliding.
//
// The readability half is easy. The tests that matter are the ones that pin the
// SECURITY half: once visible text stops equalling the href, this display can
// misrepresent a destination.
//
// Run: node --test app/lib/elideUrl.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { elideUrl, URL_DISPLAY_BUDGET as B } from "./elideUrl.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const long = (n: number) => "x".repeat(n);

// ── Rule 1: the host is never truncated ──────────────────────────────────────

test("a host longer than the whole budget still renders WHOLE", () => {
  // The rule that costs something, which is why it needs a test. A cut host
  // is the misrepresentation risk itself: `verylongevil.com` shortened to
  // `verylong…` could be anything. A long line is a worse reading experience; a
  // truncated host is a worse security one.
  const host = "a-really-quite-extraordinarily-long-hostname-indeed.example.com";
  assert.ok(host.length > B, "precondition: this host alone exceeds the budget");
  const { display } = elideUrl(`https://${host}/some/path/here`);
  assert.ok(display.startsWith(host), `the host was cut: ${display}`);
  assert.ok(display.includes(host), "the full host must survive intact");
});

test("the host is intact for every elided URL, whatever the budget", () => {
  // Property-style: no budget setting may ever produce a display whose host is
  // partial. This is the assertion that would catch a "clever" future tweak.
  // Asserts the host appears WHOLE, not that the display starts with it — at a
  // budget the URL already fits under, it is returned untouched and still
  // carries its `https://`.
  const host = "sub.example.co.uk";
  for (let budget = 1; budget <= 60; budget++) {
    const { display } = elideUrl(`https://${host}/a/b/c/d/e/f/g?q=1`, budget);
    assert.ok(display.includes(host),
      `budget ${budget} produced ${JSON.stringify(display)} — host not intact`);
    // …and nothing may precede it except the scheme.
    const before = display.slice(0, display.indexOf(host));
    assert.match(before, /^(https?:\/\/)?$/,
      `budget ${budget}: unexpected text before the host in ${JSON.stringify(display)}`);
  }
});

// ── Rule 2: elide the tail, never the middle ─────────────────────────────────

test("a domain buried in the path cannot end up as the last thing shown", () => {
  // Why tail-elision, not middle-elision. Middle-elision would render
  // `evil.test/…/paypal.com/login` — a trusted-looking domain as the final token
  // a reader's eye lands on. Cutting from the tail keeps the only domain-shaped
  // token near the front the REAL host.
  const { display, elided } = elideUrl(
    "https://evil.test/redirect/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/paypal.com/login"
  );
  assert.ok(elided, "precondition: this URL is long enough to elide");
  assert.ok(display.startsWith("evil.test"), "the real host must lead");
  assert.ok(!display.includes("paypal.com"),
    `the impersonating token survived the elision: ${display}`);
  assert.ok(display.endsWith("…"), "the cut must be visible");
});

test("what survives is a PREFIX of the original, never a stitched-together string", () => {
  // If the display is always a prefix (plus an ellipsis), it cannot assert
  // anything the URL does not — no reordering, no omitted middle.
  const href = "https://example.com/one/two/three/four/five/six/seven?a=1&b=2";
  const { display } = elideUrl(href);
  const shown = display.replace(/…$/, "");
  const withoutScheme = href.replace(/^https:\/\//, "");
  assert.ok(withoutScheme.startsWith(shown), `${JSON.stringify(shown)} is not a prefix of the href`);
});

// ── Rule 3: the scheme ───────────────────────────────────────────────────────

test("https is dropped, http is KEPT", () => {
  // Saving eight characters on the common case; spending them as a signal on the
  // insecure one. Never the reverse.
  const secure = elideUrl(`https://example.com/${long(80)}`);
  assert.ok(!secure.display.startsWith("https://"), "https:// is noise on every link");
  assert.ok(secure.display.startsWith("example.com"));

  const insecure = elideUrl(`http://example.com/${long(80)}`);
  assert.ok(insecure.display.startsWith("http://example.com"),
    "http:// must stay visible — hiding it hides the warning");
});

test("a non-default port survives, because it is part of the destination", () => {
  const { display } = elideUrl(`https://example.com:8443/${long(80)}`);
  assert.ok(display.startsWith("example.com:8443"), `port lost: ${display}`);
});

test("www. is not quietly stripped", () => {
  // This string is what a reader checks the destination against. Editing it,
  // even harmlessly, is the habit that makes the whole display untrustworthy.
  const { display } = elideUrl(`https://www.example.com/${long(80)}`);
  assert.ok(display.startsWith("www.example.com"), `www was stripped: ${display}`);
});

// ── Leaving things alone ─────────────────────────────────────────────────────

test("a URL that already fits is returned untouched and unflagged", () => {
  for (const href of [
    "https://a.test/x",
    "https://example.com/short",
    "http://example.com/p",
  ]) {
    const r = elideUrl(href);
    assert.equal(r.display, href, "a short URL must render exactly as typed");
    assert.equal(r.elided, false, "…and must not offer a copy affordance it does not need");
  }
});

test("an uppercase host never renders duplicated fragments", () => {
  // `u.host` is lowercased by the parser, `raw` is not, so a case-sensitive
  // `raw.indexOf(u.host)` misses and `-1 + host.length` slices mid-host —
  // `https://EXAMPLE.COM/<long>` would display as `example.comAMPLE.COM/…`, a
  // domain-shaped token right after the real host.
  const { display } = elideUrl("https://EXAMPLE.COM/" + "x".repeat(60));
  assert.ok(display.startsWith("example.com/x"), `garbled: ${display}`);
  assert.ok(!display.includes("AMPLE"), `host fragment duplicated: ${display}`);
});

test("an IDN host falls back to parsed parts — no doubled TLD", () => {
  // The parser punycodes the host, so it is never findable in `raw` at all.
  const { display } = elideUrl("https://müller-example.de/" + "x".repeat(60));
  assert.ok(display.startsWith("xn--mller-example-wob.de/x"), `garbled: ${display}`);
  assert.ok(!/\.dede/.test(display), `TLD doubled: ${display}`);
});

test("userinfo is always elided out of the display, even under budget", () => {
  // `https://youtube.com@evil.example/x` goes to evil.example; everything
  // before the `@` is costume. The display must show where the click GOES.
  const spoof = elideUrl("https://youtube.com@evil.example/watch");
  assert.equal(spoof.display, "evil.example/watch");
  assert.equal(spoof.elided, true, "hiding the userinfo must surface the copy affordance");
  // …even when the costume is a copy of the real host.
  const twin = elideUrl("https://evil.example@evil.example/x");
  assert.equal(twin.display, "evil.example/x");
  // A plain URL under budget is still returned untouched.
  assert.deepEqual(elideUrl("https://example.com/short"),
    { display: "https://example.com/short", elided: false });
});

test("an unparseable string is shown whole rather than cut blindly", () => {
  // NOT a fallback truncation. Cutting a string that could not be parsed risks
  // cutting inside the host, which rule 1 forbids.
  const junk = "https://" + long(80) + " not really a url";
  const r = elideUrl(junk);
  assert.equal(r.elided, false);
  assert.equal(r.display, junk);
});

test("a bare host with no path does not grow a pointless ellipsis", () => {
  const r = elideUrl("https://example.com/");
  assert.equal(r.display, "https://example.com/", "it already fits — leave it alone");
  assert.equal(r.elided, false);
});

// ── The flag drives the affordance ───────────────────────────────────────────

test("`elided` is true exactly when something was hidden", () => {
  const fits = elideUrl("https://example.com/x");
  assert.equal(fits.elided, false);
  assert.ok(!fits.display.endsWith("…"));

  const cut = elideUrl(`https://example.com/${long(120)}`);
  assert.equal(cut.elided, true, "the copy affordance must appear when text is hidden");
  assert.ok(cut.display.endsWith("…"));
  assert.ok(cut.display.length <= B + 2, `display overran the budget: ${cut.display.length}`);
});

test("the display stays near the budget for a spread of realistic URLs", () => {
  const urls = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&index=7&t=42s",
    "https://github.com/example-org/example-repo/blob/main/web/app/lib/renderText.tsx#L410",
    "https://en.wikipedia.org/wiki/Nikola_Tesla#Later_years_and_death",
    "https://store.example.com/p/12345?utm_source=twitter&utm_medium=social&utm_campaign=spring",
  ];
  for (const u of urls) {
    const { display } = elideUrl(u);
    assert.ok(display.length <= B + 2, `${display.length} chars for ${u}`);
    assert.ok(display.length > 10, "…and it must still say something useful");
  }
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("the bare-URL branch elides, keeps the full href on title, and gates the copy button", () => {
  const src = readFileSync(join(HERE, "renderText.tsx"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//"))
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  const url = src.slice(src.indexOf('if (seg.t === "url")'), src.indexOf('if (seg.t === "link")'));
  assert.ok(url.length > 100, "could not isolate the url branch — this guard is not guarding");

  // The branch elides the tracking-STRIPPED href (`cleanHref`), not the raw
  // one: display, hover and copy all show the same URL the click follows, while
  // the stored link stays as typed.
  assert.match(url, /const \{ display, elided \} = elideUrl\(cleanHref\)/,
    "the bare-URL branch no longer elides");
  assert.match(url, /\{display\}/, "…or renders the raw href again");
  assert.doesNotMatch(url, /\{(seg\.href|cleanHref)\}\s*<\/a>/,
    "the full href is being rendered as the link text again");

  // The full (stripped) href must stay reachable without a click.
  assert.match(url, /title=\{cleanHref\}/,
    "the full href is no longer on hover — eliding would then LOSE information");

  // The affordance is gated on the flag, not shown always. A copy button on
  // every link is noise, and noise is how an affordance stops being noticed.
  assert.match(url, /\{elided && <CopyLinkButton href=\{cleanHref\} \/>\}/,
    "the copy button is not gated on something actually being hidden");
});

test("the copy button hands over the FULL href, never the shortened display", () => {
  // The one way this feature could quietly break: copying what is on screen.
  const src = readFileSync(join(HERE, "renderText.tsx"), "utf8");
  const comp = src.slice(src.indexOf("function CopyLinkButton"), src.indexOf("export function renderText") > 0
    ? src.indexOf("export function renderText") : src.length);
  assert.match(comp, /copyText\(href\)/, "the copy button no longer copies the full href");
  assert.doesNotMatch(comp, /copyText\(display/, "it is copying the elided display text");
  // A chat row is itself clickable — copying must not also select the message.
  assert.match(comp, /stopPropagation/, "copying a link would also trigger the row's own click");
});
