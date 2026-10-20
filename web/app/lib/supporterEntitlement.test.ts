// Supporter ENTITLEMENT vs Supporter BILLING — the distinction gifted subs need.
//
// The bug this pins: a viewer holding a GIFTED Supporter subscription must be
// able to use redacted messages. The server gates /api/chat/send and
// /api/chat/decrypt on getActiveTier(), which counts gifts — but a CLIENT that
// treats `tier != null` (read straight off site.subscriptions) as "is a
// Supporter" never offers the option, because a gift recipient has no
// subscriptions row and reads as a stranger to their own perk.
//
// Two definitions of "Supporter", one per side of the wire, disagreeing. These
// tests pin the single definition and the reason the OTHER one still exists:
// billing needs "has their own Stripe subscription to manage", which is NOT the
// same question and must not be merged back in.
//
// Source-level assertions rather than mocking pg — same approach as
// lockdown.test.ts and encryptedExposure.test.ts, and for the same reason: what
// matters is which FUNCTION answers the question, and that is visible statically.
//
// Run: node --test app/lib/supporterEntitlement.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

// Comments are not source. This file's own prose names every symbol it
// asserts on, and so does the code under test — the rule is DOCUMENTED in
// comments right beside the lines that implement it, so a naive substring
// search passes on the comment alone (see encryptedExposure.test.ts and
// wsFrames for the same trap).

const meRoute = stripComments(read("app/api/me/route.ts"));
const entitlements = stripComments(read("app/lib/entitlements.ts"));
const chatInput = stripComments(read("app/features/chat/ChatInput.tsx"));
const badgesCtx = stripComments(read("app/lib/BadgesContext.tsx"));

test("the entitlement is computed by the SAME function the server gates on", () => {
  // The whole point. If /api/me ever recomputes "is a Supporter" from its own
  // SELECT again, client and server can drift apart a second time — and the
  // failure is silent in the direction that matters (a paying viewer quietly
  // loses a perk; nothing errors).
  assert.match(entitlements, /export async function getActiveTier/,
    "getActiveTier is the canonical entitlement answer");
  assert.match(meRoute, /import \{ getActiveTier \} from "@\/app\/lib\/entitlements"/,
    "/api/me must import the server's own entitlement function");
  assert.match(meRoute, /const supporter = \(await getActiveTier\([^)]*\)\) != null/,
    "/api/me must derive `supporter` from getActiveTier, not from its own query");
  assert.match(meRoute, /^\s*supporter,\s*$/m, "and must actually return it");
});

test("getActiveTier counts an unexpired GIFT, not just an own subscription", () => {
  // This is the property the bug turned on. Losing it re-breaks gifted subs
  // everywhere at once, including on the server side.
  assert.match(entitlements, /site\.gift_subscriptions/,
    "gift subscriptions must be consulted");
  assert.match(entitlements, /expires_at > now\(\)/,
    "and only while unexpired");
  const giftIdx = entitlements.indexOf("gift_active");
  const returnIdx = entitlements.indexOf('tier = "supporter"');
  assert.ok(giftIdx !== -1 && returnIdx !== -1 && giftIdx < returnIdx,
    "an active gift must resolve to a supporter tier");
});

test("BILLING keeps its own, narrower answer — a gift has nothing to manage", () => {
  // `tier` must NOT be widened to include gifts. SupportContent keys "Manage
  // subscription" off it, which opens the Stripe billing portal; a gift
  // recipient has no Stripe customer, so widening it hands them a button whose
  // only possible outcome is an error.
  assert.match(meRoute, /tier: subActive \? /,
    "tier stays derived from the viewer's OWN subscription status");
  assert.ok(
    !/tier: .*supporter\b.*giftExpires/.test(meRoute),
    "tier must not fold the gift in"
  );
  // Both answers ship, so a caller can ask the right question.
  assert.match(meRoute, /giftActive: Boolean\(giftExpires\)/,
    "the gift is still reported separately for the billing UI");
});

test("the composer's encrypt gate reads the ENTITLEMENT, never the billing tier", () => {
  // The regression site itself. `tier` here is what refused gifted Supporters.
  assert.match(chatInput, /const \{ isAdmin, supporter \} = useBadges\(\)/,
    "ChatInput must pull `supporter` from the badges context");
  assert.match(chatInput, /const canEncrypt = supporter === undefined \? null : supporter/,
    "canEncrypt must be derived from `supporter`");
  assert.ok(!/canEncrypt = tier/.test(chatInput),
    "canEncrypt must not be derived from the billing tier again");
});

test("an unknown answer stays UNKNOWN — a failed read must not read as 'no'", () => {
  // The tri-state is load-bearing, and it is the subtle one. `undefined` means
  // "/api/me has not answered yet"; false means "definitely not a Supporter".
  // Collapsing them makes a network blip PRUNE a Supporter's stored 🔒 send-to
  // choice back to plaintext — sendDestination.ts's shouldPrune exists entirely
  // for this, and it is fed from here.
  assert.match(badgesCtx, /supporter\?: boolean \| undefined/,
    "the context type must admit the not-yet-loaded state");
  assert.match(badgesCtx, /const \[supporter, setSupporter\] = useState<boolean \| undefined>\(undefined\)/,
    "and must start in it");
  // The .catch must not write a value — leaving it undefined is the safe read.
  const fetchBlock = badgesCtx.slice(
    badgesCtx.indexOf('getJson<{ isAdmin'),
    badgesCtx.indexOf("}, [refresh]);")
  );
  assert.ok(fetchBlock.length > 0, "the /api/me fetch block must be findable");
  const catchBlock = fetchBlock.slice(fetchBlock.indexOf(".catch("));
  assert.ok(!/setSupporter/.test(catchBlock),
    "a failed /api/me read must leave `supporter` undefined, not set it false");
});
