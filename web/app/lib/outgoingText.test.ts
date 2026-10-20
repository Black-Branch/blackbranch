// Run: node --test app/lib/outgoingText.test.ts
//
// The rules here are the difference between "a viewer's message reached Twitch"
// and "Twitch silently ate the first four characters of it", so each one is
// pinned against the real string that failed in production.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { isPlatformCommand, escapeLeadingCommand } from "./outgoingText.ts";

// Derived from the observable behaviour rather than imported: the escape is an
// implementation detail, and exporting it just to assert on it would make the
// test its only consumer.
const CMD_ESCAPE = escapeLeadingCommand(".").slice(0, -1);

const here = dirname(fileURLToPath(import.meta.url));

test("commands are kept off other platforms", () => {
  for (const cmd of ["!karma", "!rank hello", "/me waves", "/ban someone", "  !karma"]) {
    assert.ok(isPlatformCommand(cmd), `${cmd} would have been relayed`);
  }
});

test("a leading DOT is not a command — it is text, and must still be sent", () => {
  // The whole point of the split: suppressing `.` the way we suppress `!` would
  // silently drop decimals and ellipses, which is a bigger bug than the one
  // being fixed.
  for (const text of [".6% - .7% between them awaree", "...", ".6%-.7%", ".,.", ".hey"]) {
    assert.equal(isPlatformCommand(text), false, `${text} was treated as a command`);
  }
});

test("ordinary messages are neither suppressed nor escaped", () => {
  for (const text of ["hello", "5% of them", "a/b", "wow!", "e.g. this"]) {
    assert.equal(isPlatformCommand(text), false, `${text} was suppressed`);
    assert.equal(escapeLeadingCommand(text), text, `${text} was needlessly escaped`);
  }
});

test("the escape goes in FRONT and changes nothing else", () => {
  // A real message that Twitch truncated to "- .7% between…".
  const real = ".6% - .7% between them awaree";
  const out = escapeLeadingCommand(real);
  assert.equal(out, CMD_ESCAPE + real);
  assert.ok(out.startsWith(CMD_ESCAPE), "the escape is not first, so Twitch still parses a command");
  assert.equal(out.slice(CMD_ESCAPE.length), real, "the message text was altered");
});

test("the escape is a single default-ignorable TAG codepoint", () => {
  // A visible character here would put a stray glyph in front of every
  // dot-leading message on Twitch — worse than the truncation it replaces.
  const cps = [...CMD_ESCAPE];
  assert.equal(cps.length, 1, "the escape grew to more than one codepoint");
  assert.equal(CMD_ESCAPE.codePointAt(0), 0xe0000);
});

test("the dedup normaliser strips the escape, or the echo returns as a DUPLICATE", () => {
  // The escape only reaches Twitch; the arm side keys on the unescaped text. If
  // stream-api does not strip U+E0000-U+E007F from the key, every escaped
  // message bounces back as a second visible line — which is half the bug.
  const src = stripComments(readFileSync(join(here, "../../../stream-api/chat-dedup.js"), "utf8"));
  const norms = src.split("function ").filter((f) => f.startsWith("normText"));
  assert.equal(norms.length, 2, "expected normText and normTextWithPath");
  for (const fn of norms) {
    assert.match(
      fn, /E0000\}?-\\u\{?E007F/,
      "a normaliser does not strip the TAG block — escaped echoes will duplicate"
    );
  }
});

test("the send route keeps commands native and Twitch gets the escaped text", () => {
  const route = stripComments(readFileSync(join(here, "../api/chat/send/route.ts"), "utf8"));
  assert.match(route, /isPlatformCommand\(/, "the send route no longer suppresses command relay");

  const chat = stripComments(readFileSync(join(here, "./platformChat.ts"), "utf8"));
  assert.match(chat, /escapeLeadingCommand\(/, "Twitch is no longer given the escaped text");
});
