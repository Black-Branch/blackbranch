// The outbound platform message id has to reach stream-api BEFORE the echo of
// that same message does, or the exact-id suppression it enables never gets a
// chance to run and the duplicate renders anyway.
//
// That makes WHERE registerEchoCopy is called an invariant, not a style choice,
// and it is a fragile one: moving the call a few lines down — out of the
// per-target map and under the `await Promise.all` that follows it — is a
// natural-looking tidy-up that reads better and silently reintroduces the bug.
// Nothing at runtime would complain; the ids would still be registered, just
// late, and only for the fast platform in a fan-out with a slow one.
//
// A fast platform's send API answers in a fraction of a second and its echo
// follows soon after, while a slower platform's send in the same fan-out can
// take seconds. Batching after Promise.all therefore registers the fast id
// after its echo has already been rendered.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const ROUTE = join(process.cwd(), "app/api/chat/send/route.ts");
const src = stripComments(readFileSync(ROUTE, "utf8"));

test("the fan-out registers each platform id as that send resolves", () => {
  const register = src.indexOf("registerEchoCopy(siteMsgId");
  const settle = src.indexOf("await Promise.all(");
  assert.ok(register > 0, "the fan-out no longer registers echo copies at all");
  assert.ok(settle > 0, "precondition: the fan-out still uses Promise.all");
  // Promise.all(...) OPENS before the map callbacks are written, so the
  // registration sitting after that index is what proves it is INSIDE the map
  // rather than after the barrier. The closing check below is the other half.
  assert.ok(register > settle, "registration moved above the fan-out");

  const tail = src.slice(src.indexOf("const results = await Promise.all("));
  const closes = tail.indexOf("\n    );");
  assert.ok(closes > 0, "could not find the end of the Promise.all call");
  assert.ok(
    tail.indexOf("registerEchoCopy(siteMsgId") < closes,
    "registerEchoCopy moved OUT of the per-target callback and under the barrier — " +
      "the Twitch id now waits for the slowest platform in the fan-out, which is the bug"
  );
});

test("the single-destination path registers its id too", () => {
  assert.match(
    src,
    /void registerEchoCopy\(singleSiteMsgId, copy\)/,
    "a send to one explicit platform gets no exact-id suppression"
  );
});

test("the sender's own platform ids are armed before the fan-out", () => {
  // This is what covers YouTube, whose send-API id and ingest id are different
  // id spaces — see stream-api/echo-dedup.test.js. Without senderPlatformIds
  // reaching /chat/native, YouTube echoes fall back to the 20s text guess.
  const arm = src.indexOf("senderPlatformIds,");
  const send = src.indexOf("const results = await Promise.all(");
  assert.ok(arm > 0, "senderPlatformIds is no longer sent to /chat/native");
  assert.ok(arm < send, "the identity must be armed BEFORE any platform send goes out");
  assert.match(
    src,
    /SELECT DISTINCT provider, provider_account_id FROM site\.accounts/,
    "the account ids are no longer selected, so senderPlatformIds is empty"
  );
});

test("stream.place keeps the record URI its send returns", () => {
  // Discarding it breaks two things at once: no exact-id echo match, and no
  // platform-copies row, so a site-side delete could not reach the copy.
  const chat = stripComments(readFileSync(join(process.cwd(), "app/lib/platformChat.ts"), "utf8"));
  assert.match(chat, /const created = await agent\.com\.atproto\.repo\.createRecord\(/);
  assert.match(chat, /const uri = created\?\.data\?\.uri;/);
  assert.doesNotMatch(
    chat,
    /createRecord\(\{[\s\S]*?\}\);\s*return \{ ok: true \};/,
    "createRecord's result is being thrown away again"
  );
});

// ── Vacuity anchor (END of file) ────────────────────────────────────────────
// Every assertion above measures POSITIONS in `src`. A truncated read shifts or
// erases them, and the two `doesNotMatch`/ordering checks would pass over the
// hole rather than fail. This proves the read reached the real end of the route.
test("VACUITY ANCHOR: the route source was read whole", () => {
  assert.ok(src.length > 20_000, `route.ts read back as ${src.length} bytes — truncated`);
  assert.match(
    src.trimEnd().slice(-400),
    /\}\s*$/,
    "the scan did not reach the end of app/api/chat/send/route.ts"
  );
  assert.ok(
    src.includes("export async function POST"),
    "the scan lost the route handler itself"
  );
});
