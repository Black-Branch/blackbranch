// The account-link OAuth result must land where its banner can actually
// render.
//
// Run: node --test --experimental-strip-types app/lib/oauthBannerSurface.test.ts
//
// WHAT THIS PINS. /settings/accounts is a redirect-only stub that bounce()s to
// "/" and DROPS the query string, so link callbacks that redirect there with
// ?linked= / ?error=&platform= would never reach AccountLinkPanel's
// BannerReader (the ONLY consumer of those params): every "X linked
// successfully" / error banner would be unreachable. The rule has three legs,
// and losing any one of them silently re-breaks the other two, which is why
// this is a source pin and not a behavior test (the callback is a
// NextResponse redirect; the panel only mounts inside the card host):
//
//   1. the callbacks land on "/" with the params INTACT;
//   2. UserMenu (the card host, mounted on "/") auto-opens the Linked
//      accounts page when it sees them, so BannerReader mounts;
//   3. BannerReader strips the params against the CURRENT pathname — not a
//      hardcoded /settings/accounts, which would rewrite the URL to a
//      route the user is no longer on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

function read(...parts: string[]): { src: string; raw: string } {
  const raw = readFileSync(join(process.cwd(), ...parts), "utf8");
  return { src: stripComments(raw), raw };
}

test("both link callbacks land the OAuth result on / with the params intact", () => {
  for (const parts of [
    ["app", "api", "auth", "link", "[platform]", "callback", "route.ts"],
    ["app", "api", "auth", "link", "streamplace", "callback", "route.ts"],
  ]) {
    const { src, raw } = read(...parts);
    assert.match(src, /const SUCCESS_URL = `\$\{BASE_URL\}\/`;/,
      `${parts.join("/")}: the OAuth result must land on "/" — /settings/accounts is a ` +
      `redirect stub that drops the query string, which is the bug this test exists for`);
    assert.match(src, /\?linked=/, "the success redirect must carry ?linked=");
    assert.match(src, /\?error=\$\{reason\}&platform=/, "errors must carry ?error=&platform=");
    // Vacuity anchor: the success redirect is the LAST statement of each file.
    assert.match(raw.slice(-260), /NextResponse\.redirect\(\s*new URL\(`\$\{SUCCESS_URL\}\?linked=/,
      `${parts.join("/")}: tail changed — re-point this scan before trusting it`);
  }
});

test("UserMenu auto-opens Linked accounts when the OAuth params are present", () => {
  const { src, raw } = read("app", "components", "UserMenu.tsx");
  assert.match(src,
    /URLSearchParams\(window\.location\.search\)/,
    "UserMenu no longer reads the landing URL — nothing else mounts BannerReader");
  assert.match(src,
    /p\.get\("linked"\) \|\| \(p\.get\("error"\) && p\.get\("platform"\)\)/,
    "the open condition must key on linked OR error+platform — a bare ?error= " +
    "belongs to other flows (auth signin) and must not pop the card");
  const cond = src.indexOf('p.get("linked")');
  const opens = src.indexOf("open(PAGES.accounts)", cond);
  assert.ok(cond > 0 && opens > cond && opens - cond < 200,
    "the param check must OPEN the Linked accounts page");
  // Vacuity anchor on the tail of the component.
  assert.match(raw.slice(-120), /<\/>\s*\)\s*;\s*\}\s*$/,
    "UserMenu tail changed — re-point this scan before trusting it");
});

test("BannerReader strips params against the current pathname, not a dead route", () => {
  const { src, raw } = read("app", "components", "AccountLinkPanel.tsx");
  assert.doesNotMatch(src, /replaceState\([^)]*"\/settings\/accounts"/,
    "replaceState points at /settings/accounts again — that page is a bookmark " +
    "stub; stripping params must keep the user on the page they are on");
  assert.match(src, /replaceState\(window\.history\.state, "", window\.location\.pathname\)/,
    "BannerReader must strip the one-shot params in place — and PRESERVE " +
    "history.state (replaceState(null, …) wipes the Next router state " +
    "off the entry, and any armed back-sentinel mark with it)");
  assert.doesNotMatch(src, /replaceState\(null/,
    "a null state is a state WIPE, not a param strip");
  // Vacuity anchor on the tail of the component.
  assert.match(raw.slice(-80), /\)\s*;\s*\}\s*$/,
    "AccountLinkPanel tail changed — re-point this scan before trusting it");
});
