// Tests for the display-name / chat-message sanitizer.
//
// Every path into site.users.display_name must sanitize, not just one: a name
// written unsanitized (the Matrix reconcile is a second path) renders as
// `username` in chat, history, pins, votes, the mod log and the ban list. The
// sanitizer is applied at the source in matrixProfile.getMatrixProfile as
// well, and these pin the properties that depends on.
//
// Run: node --test app/lib/sanitize.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDisplayName, sanitizeChatMessage } from "./sanitize.ts";

test("strips bidi overrides — the impersonation payload from the finding", () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE makes the rest render reversed, so a name can
  // be made to read as someone else's in chat and the mod log.
  const out = sanitizeDisplayName("‮roteredoM");
  assert.equal(out, "roteredoM");
  assert.ok(!/[‪-‮⁦-⁩]/.test(out));
});

test("strips zero-width padding used to clone another user's name", () => {
  // "ad​min" renders identically to "admin" but is a different string, so
  // it slips past any exact-match uniqueness check.
  assert.equal(sanitizeDisplayName("ad​min"), "admin");
  assert.equal(sanitizeDisplayName("a﻿b‍c"), "abc");
});

test("caps length at 32 — the 400-char payload cannot persist", () => {
  // migrate-v18/v50 declare display_name TEXT with no length constraint, so the
  // cap is enforced here or nowhere.
  const out = sanitizeDisplayName("x".repeat(400));
  assert.equal(out.length, 32);
});

test("collapses whitespace and trims", () => {
  assert.equal(sanitizeDisplayName("  a   b  "), "a b");
  assert.equal(sanitizeDisplayName("a\t\tb"), "a b");
});

test("a name of nothing but invisibles collapses to empty", () => {
  // matrixProfile turns "" into null so the reconcile COALESCE keeps the
  // existing good value rather than blanking it.
  assert.equal(sanitizeDisplayName("​​‮"), "");
  assert.equal(sanitizeDisplayName("   "), "");
});

test("ordinary names pass through untouched", () => {
  for (const n of ["casey", "Rosalind", "user_123", "名前", "Ünïcodé"]) {
    assert.equal(sanitizeDisplayName(n), n);
  }
});

test("the shared /g regex is not stateful across calls", () => {
  // INVISIBLE_RE is a module-level /g regex shared by both exported functions.
  // String.replace resets lastIndex, but this pins it — a future refactor to
  // .test() would silently start skipping every other call.
  const payload = "a​b";
  for (let i = 0; i < 5; i++) assert.equal(sanitizeDisplayName(payload), "ab");
  for (let i = 0; i < 5; i++) assert.equal(sanitizeChatMessage(payload), "ab");
});

test("sanitizeChatMessage strips the same invisibles but keeps its own limits", () => {
  assert.equal(sanitizeChatMessage("hi‮there"), "hithere");
  assert.equal(sanitizeChatMessage("line\nbreak"), "line break");
  assert.equal(sanitizeChatMessage("y".repeat(600)).length, 500);
});

test("an optional cap overrides the 500 default without changing it for other callers", () => {
  // chat/send/route.ts passes charLimit + 1 so its own > charLimit check can
  // still see an overlong message as over, rather than trimmed down to look
  // exactly at the limit — otherwise a message at a limit that equals the
  // sanitizer's default would be silently cut, never rejected.
  assert.equal(sanitizeChatMessage("z".repeat(300), 201).length, 201);
  assert.equal(sanitizeChatMessage("short", 201), "short");
  // Omitted entirely, the default stays 500 — every other caller is unaffected.
  assert.equal(sanitizeChatMessage("y".repeat(600)).length, 500);
});

test("idempotent — sanitizing twice equals sanitizing once", () => {
  for (const n of ["‮evil", "  spaced  out ", "z".repeat(50)]) {
    assert.equal(sanitizeDisplayName(sanitizeDisplayName(n)), sanitizeDisplayName(n));
  }
});

// ── every untrusted overlay-bound field must go through the sanitizer ─────────
//
// The donation route stamps a donor-supplied displayName + message onto the
// on-stream overlay and the donation card; trim+slice alone would let an RTL
// override or zero-width chars reach the overlay. These pin that the sanitizer
// stays wired — a static guard, because the route drags in Stripe + the pg pool
// and can't be unit-imported here (same pattern as money-policy /
// chatIdentity).
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the donate route sanitizes both donor-supplied fields", () => {
  const src = readFileSync(
    join(process.cwd(), "app", "api", "billing", "donate", "route.ts"), "utf8"
  ).split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  assert.match(src, /sanitizeDisplayName\(body\??\.displayName\)/,
    "the donor displayName is no longer run through sanitizeDisplayName");
  // Takes a second argument: sanitizing at the flat default (500) would let a
  // top-tier ($25+, also capped at 500) overflow get silently cut to exactly
  // 500 and never measure as over `maxMessage`.
  assert.match(src, /sanitizeChatMessage\(body\??\.message,\s*maxMessage \+ 1\)/,
    "the donor message is no longer run through sanitizeChatMessage");
  // The naive trim+slice that let bidi/control chars through must not come back.
  assert.doesNotMatch(src, /body\??\.displayName[^;]*\.trim\(\)\.slice/,
    "the raw trim+slice on displayName is back — bidi/control chars can reach the overlay");
});
