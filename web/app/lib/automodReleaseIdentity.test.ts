// A released message is a NORMAL message — it must carry the same identity.
//
// When a mod allows a held NATIVE message, `api/mod/automod/resolve/route.ts`
// re-publishes it by POSTing `/chat/native`, the same endpoint the ordinary send
// path uses. Two different call sites, one contract: whatever identity a real
// send puts in that body, the release has to put there too.
//
// A missing identity field in the release body hides itself:
//
//   • `/chat/native` resolves a missing `usernameColor` from site.users itself
//     (stream-api/chat.js), so the name keeps its COLOUR. A missing
//     `usernameStyle` (the equipped coin-store font/gradient) only drops the
//     font and gradient — it reads as a rendering quirk, not a missing field.
//   • Chat HISTORY re-joins site.users (`api/chat/history/route.ts`), so the
//     styling comes back on the next reload. Only the live frame is wrong.
//
// So the test does not pin one field. It is DERIVED: the identity keys the send
// route puts in a `/chat/native` body are read out of the source, and the
// release must carry every one of them. Adding an identity field to the send
// path fails this test until the release carries it too.
//
// Run: node --test app/lib/automodReleaseIdentity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEND_ROUTE = join(appDir, "api/chat/send/route.ts");
const RESOLVE_ROUTE = join(appDir, "api/mod/automod/resolve/route.ts");

// Comments come out FIRST. This file's own header names `usernameStyle`
// several times, and so does the prose above the query in the resolve route —
// a scan that reads comments would be satisfied by its own documentation.
const read = (p: string) => stripComments(readFileSync(p, "utf8"));

/**
 * Extract the top-level key names of every `JSON.stringify({ … })` body passed
 * to a `/chat/native` call in `src`.
 *
 * Depth-aware on purpose: `senderPlatformIds: { twitch: … }` is a nested object,
 * and a flat line-regex would report `twitch` as a body key. Handles shorthand
 * properties (`usernameColor,`) because that is how the send route writes them.
 */
function nativeBodyKeys(src: string): string[][] {
  const bodies: string[][] = [];
  const marker = "/chat/native";
  for (let at = src.indexOf(marker); at !== -1; at = src.indexOf(marker, at + 1)) {
    const start = src.indexOf("JSON.stringify({", at);
    if (start === -1) continue;
    // Walk from the object's opening brace to its match, tracking nesting so
    // only depth-1 keys are collected.
    let i = src.indexOf("{", start);
    let depth = 0;
    const keys: string[] = [];
    for (; i < src.length; i++) {
      // charAt, not `src[i]` — `noUncheckedIndexedAccess` types the index form
      // as possibly undefined, and this walk is always in bounds.
      const ch = src.charAt(i);
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") {
        depth--;
        if (depth === 0) break;
      } else if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
        // A key starts right after `{` or `,` (whitespace allowed between).
        const before = src.slice(0, i).replace(/\s+$/, "");
        const prev = before[before.length - 1];
        if (prev !== "{" && prev !== ",") continue;
        const m = /^([A-Za-z_$][\w$]*)\s*([,:])/.exec(src.slice(i));
        if (m) {
          keys.push(m[1]!);
          i += m[1]!.length;
        }
      }
    }
    bodies.push(keys);
  }
  return bodies;
}

/** The identity of the SPEAKER, as opposed to routing, threading or dedup. */
const isIdentityKey = (k: string) => /^username([A-Z]|$)/.test(k);

const sendBodies = nativeBodyKeys(read(SEND_ROUTE));
const resolveBodies = nativeBodyKeys(read(RESOLVE_ROUTE));

test("the send route's /chat/native bodies were actually found and parsed", () => {
  // The vacuity anchor for everything below. A truncated read, a renamed
  // endpoint or a broken brace-walk all land here as an empty extraction —
  // which would otherwise make the derived comparison pass by having nothing
  // to compare. Positive assertions, so a short read goes red.
  assert.ok(
    sendBodies.length >= 4,
    `expected at least 4 /chat/native call sites in the send route, parsed ${sendBodies.length}`
  );
  for (const keys of sendBodies) {
    assert.ok(keys.includes("matrixId"), `a parsed body has no matrixId: ${keys.join(", ")}`);
    assert.ok(keys.includes("message"), `a parsed body has no message: ${keys.join(", ")}`);
  }
});

test("the resolve route releases a native hold through /chat/native", () => {
  assert.equal(
    resolveBodies.length, 1,
    "expected exactly one /chat/native release in the resolve route"
  );
});

test("the native release carries every identity field a real send carries", () => {
  const expected = [...new Set(sendBodies.flat().filter(isIdentityKey))].sort();
  // Derived, not hardcoded — but it must not derive to nothing, or this test
  // would go green on a send route that had stopped sending identity at all.
  assert.ok(
    expected.includes("username") && expected.includes("usernameStyle"),
    `the send route names too few identity fields to be believable: ${expected.join(", ")}`
  );

  const released = resolveBodies[0]!.filter(isIdentityKey).sort();
  const missing = expected.filter((k) => !released.includes(k));
  assert.deepEqual(
    missing, [],
    `automod/resolve publishes an approved message without: ${missing.join(", ")} — ` +
      "an allowed message must look exactly like the one the sender typed"
  );
});

test("the release reads those fields fresh from site.users, not from the held row", () => {
  // The row froze `user_name` at hold time and never held the colour or style
  // at all, so the values have to come from a live lookup. Named columns, so
  // a `SELECT *` here would fail this too.
  const src = read(RESOLVE_ROUTE);
  const query = /SELECT([\s\S]{0,200}?)FROM site\.users/.exec(src);
  assert.ok(query, "the resolve route no longer reads site.users for the release");
  for (const col of ["display_name", "username_color", "username_style"]) {
    assert.ok(
      query[1]!.includes(col),
      `the release's site.users lookup does not select ${col}`
    );
  }
});
