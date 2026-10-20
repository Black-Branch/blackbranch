// The app has ONE Twitch app-credential pair, and one place that mints a token
// from it.
//
// Run: node --test --experimental-strip-types app/lib/twitchCreds.test.ts
//
// WHY THIS IS A GUARD AND NOT A CODE REVIEW. A second pair in the web env (a
// TWITCH_CLIENT_ID/SECRET beside TWITCH_OAUTH_CLIENT_ID/SECRET) used by only a
// couple of files can go invalid — `id.twitch.tv/oauth2/token` answers
// `{"status":400,"message":"invalid client"}` — and both kinds of call site
// swallow their errors by design: the emote route returns {} per provider so
// one dead provider can't nuke the manifest, and the homepage returns nulls so
// a Twitch outage can't blank the page. So the failure is **completely
// silent**: the site serves 0 Twitch emotes and no Twitch title/viewer/follower
// count, with nothing logged anywhere.
//
// The lesson is not "check the secret". It is that a SECOND credential pair has
// no way to announce that it died, because the working pair keeps every visible
// feature alive. So there is one pair, and this test is what keeps it at one.
//
// Comments are stripped first (see testSource.ts) — the header above names the
// dead variables, and a scan that reads comments tests the explanation instead
// of the code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { INSTANCE_KEYS } from "./instanceSchema.generated.mjs";

const APP = join(import.meta.dirname, "..");

/** The dead pair. Nothing may read either one again. */
const RETIRED = ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"];

/** The one file allowed to exchange credentials for an app access token. */
const TOKEN_MINTER = "lib/twitch.ts";

function sourceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(join(dir, entry.name), here));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (entry.name.includes(".test.")) continue;
    out.push(here);
  }
  return out;
}

const read = (rel: string) => stripComments(readFileSync(join(APP, rel), "utf8"));

test("no file reads the retired TWITCH_CLIENT_ID/SECRET pair", () => {
  const offenders: string[] = [];
  for (const rel of sourceFiles(APP)) {
    const src = read(rel);
    // Anchored on the `TWITCH_` boundary so TWITCH_OAUTH_CLIENT_ID — the pair
    // that works — does not match: it is not a substring of either name.
    if (RETIRED.some((name) => src.includes(name))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "these read the dead Twitch credential pair. Use twitchAppToken() from app/lib/twitch.ts, " +
      "which mints from TWITCH_OAUTH_CLIENT_ID/SECRET — the pair the rest of the app already uses."
  );
});

test("only app/lib/twitch.ts exchanges credentials for an app token", () => {
  // Scoped on "id.twitch.tv" too, not "client_credentials" alone:
  // `client_credentials` is the generic OAuth2 grant-type name, not a Twitch
  // marker — paypalClient.ts legitimately runs the SAME grant against
  // api-m.paypal.com, and a bare substring match would read that as a second
  // Twitch minter. Twitch's own token endpoint is the thing that actually
  // identifies a Twitch minter, so requiring both is what keeps this guard
  // about Twitch and not about OAuth2 in general.
  const minters = sourceFiles(APP).filter((rel) => {
    const src = read(rel);
    return src.includes("client_credentials") && src.includes("id.twitch.tv");
  });
  assert.deepEqual(
    minters,
    [TOKEN_MINTER],
    "a second token minter means a second cache and a second thing that can silently expire — " +
      "import twitchAppToken() instead."
  );
});

// Legitimate non-minter reasons a file may say "id.twitch.tv": the PER-USER
// OAuth link flow (authorization_code grant — a different person connecting
// their own Twitch account, not the app minting its own token) and revoking a
// user's own grant. Neither exchanges the APP's own credentials for an
// app-level token, which is the one thing this file polices.
const ALLOWED_ID_TWITCH_TV: readonly string[] = [
  // Per-user OAuth config (authorize + token URLs) for the generic
  // multi-platform account-link flow — authorization_code grant, not
  // client_credentials; see app/api/auth/link/[platform]/callback/route.ts.
  "lib/platformOAuth.ts",
  // Revokes a user's own OAuth grant on unlink — never mints anything.
  "lib/platformRevoke.ts",
];

test("id.twitch.tv appears in NO file under app/ except the one token minter and the known non-minter OAuth plumbing", () => {
  // This is the recall the test above trades away by requiring BOTH
  // "client_credentials" AND "id.twitch.tv": a future second minter that got
  // Twitch's token endpoint from a shared constant or a generic OAuth helper
  // (rather than spelling out the grant type itself) would contain
  // "id.twitch.tv" and NOT "client_credentials", and slip through it silently
  // — which is exactly the completely-silent failure mode this whole file
  // exists to catch (see the header). This assertion closes it from the other
  // side: whatever a new minter looks like, it either names the endpoint
  // directly (and this catches it, forcing it onto ALLOWED_ID_TWITCH_TV with a
  // reason or onto twitch.ts instead) or it goes through twitch.ts already.
  //
  // A bare "appears nowhere else" is WRONG: Twitch's OAuth *token* URL is
  // also `id.twitch.tv/oauth2/token` for the ordinary per-user
  // authorization_code flow (platformOAuth.ts's tokenUrl), and
  // revoke/authorize live on the same host — none of that is a second app
  // minter, and without the allowlist this assertion would be red against code
  // that is not the problem.
  const files = sourceFiles(APP);
  // Vacuity anchor: the scan must cover a real slice of the tree, and the
  // known-good minter must itself contain the literal — otherwise a bug that
  // made the scan see nothing would still report success.
  assert.ok(files.length > 100, `expected the scan to cover a nontrivial part of app/, found ${files.length} files`);
  assert.ok(
    read(TOKEN_MINTER).includes("id.twitch.tv"),
    "vacuity anchor: the minter itself must contain the literal, or this scan proves nothing"
  );

  const known = new Set([TOKEN_MINTER, ...ALLOWED_ID_TWITCH_TV]);
  const offenders = files.filter((rel) => !known.has(rel) && read(rel).includes("id.twitch.tv"));
  assert.deepEqual(
    offenders,
    [],
    "an UNLISTED file references Twitch's token endpoint directly — either it's a second app-token " +
      "minter (route it through twitch.ts instead) or a new legitimate non-minter use that belongs " +
      "on ALLOWED_ID_TWITCH_TV, with a reason"
  );
});

test("the minter reads the OAuth pair — the guard above is vacuous otherwise", () => {
  // The pair is read through the settings layer (twitch.clientId /
  // twitch.clientSecret), whose CANONICAL env names are the OAuth pair — so both halves are
  // pinned: the minter asks for those keys, and those keys mean the OAuth pair first.
  const src = read(TOKEN_MINTER);
  assert.ok(src.includes('instanceString("twitch.clientId")'), "twitch.ts must read twitch.clientId");
  assert.ok(src.includes('instanceString("twitch.clientSecret")'), "twitch.ts must read twitch.clientSecret");
  const id = INSTANCE_KEYS.find((e) => e.key === "twitch.clientId");
  const secret = INSTANCE_KEYS.find((e) => e.key === "twitch.clientSecret");
  assert.equal(id?.env[0], "TWITCH_OAUTH_CLIENT_ID", "twitch.clientId must mean the OAuth app first");
  assert.equal(secret?.env[0], "TWITCH_OAUTH_CLIENT_SECRET", "twitch.clientSecret must mean the OAuth app first");
});
