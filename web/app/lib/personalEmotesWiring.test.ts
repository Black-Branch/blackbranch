// Pins the personal-emote wiring that greps can't see drift in:
//   1. chat/send resolves AFTER the encrypted early-return, and the encrypted
//      /chat/native body never carries emotes (plaintext-key leak).
//   2. All three non-encrypted native bodies attach the map.
//   3. platformOAuth requests the exact scope userEmotesCore checks for.
// Comment-stripped scans with tail anchors (repo standard).
// Run: node --test app/lib/personalEmotesWiring.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { EMOTE_SCOPE } from "./userEmotesCore.ts";

// This file runs as an ES module (node --test reparses .ts as ESM), so
// `__dirname` isn't defined — same fix as keyboardLiftWiring.test.ts /
// userMenuWiring.test.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));

const sendSrc = stripComments(readFileSync(join(__dirname, "../api/chat/send/route.ts"), "utf8"));

test("the scan sees the whole send route, tail included", () => {
  assert.match(sendSrc, /return new Response\("OK"\);\s*\}\s*$/,
    "lost the END of chat/send/route.ts — every assertion below is vacuous");
});

test("resolution sits BELOW the encrypted early-return", () => {
  const enc = sendSrc.indexOf("body.encrypted === true");
  const resolve = sendSrc.indexOf("const personalEmotes");
  const encReturn = sendSrc.indexOf("encrypted: true });");
  assert.ok(enc !== -1 && resolve !== -1 && encReturn !== -1, "anchors missing");
  assert.ok(resolve > encReturn, "personalEmotes is computed before the encrypted branch returns");
});

test("the encrypted native body carries no emote map", () => {
  const enc = sendSrc.indexOf("body.encrypted === true");
  const encEnd = sendSrc.indexOf("encrypted: true });");
  const block = sendSrc.slice(enc, encEnd);
  assert.ok(!block.includes("personalEmotes"), "encrypted send must never attach personal emotes");
});

test("exactly three native bodies attach the map (allSend, single, plain)", () => {
  const attach = sendSrc.split("...(personalEmotes ? { emotes: personalEmotes } : {})").length - 1;
  assert.equal(attach, 3);
  const fetches = sendSrc.split("`/chat/native`").length - 1;
  assert.equal(fetches, 4, "route no longer has four native call sites — re-derive this test");
});

const oauthSrc = stripComments(readFileSync(join(__dirname, "platformOAuth.ts"), "utf8"));

test("platformOAuth requests the exact scope userEmotesCore checks", () => {
  assert.ok(oauthSrc.includes(`"${EMOTE_SCOPE}"`),
    `twitch scopes must contain the literal "${EMOTE_SCOPE}"`);
});

const histSrc = stripComments(readFileSync(join(__dirname, "../api/chat/history/route.ts"), "utf8"));

test("history's native subquery selects the stored map (v114)", () => {
  assert.match(histSrc, /m\.emotes/, "nativeSub still selects NULL::jsonb AS emotes");
});
