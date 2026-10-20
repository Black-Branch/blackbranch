// Where the `/` command palette stops owning the keyboard.
//
// Suppressing the emote/@mention overlay for the whole line once it starts with
// "/" breaks two things at once: the routing commands (`/t /k /s /y` …), whose
// ONLY job is to carry a chat message, could not complete an emote; and because
// a free-text argument offers no command suggestions by construction, Tab would
// be declined by the palette, declined by the suppressed overlay, and fall
// through to the browser, which moves focus out of the textarea.
//
// The rule these pin: the palette owns the keys while the caret is completing a
// command TOKEN (the command name, a sub-command, a typed argument); once the
// caret is inside a `rest: true` text argument it is in PROSE, and prose belongs
// to the emote overlay.
//
// Run: node --test app/lib/commandFreeText.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
// The command tree reads the install plugin's commands through `@owner/commands`, which testTsx's
// loader resolves (bare node cannot) — so the parser is imported after it.
import "./testTsx.ts";

const { parseCommandLine, currentArg } = await import("./commands/parse.ts");

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Comments are not source — this file's prose names every symbol it asserts on,
// and so does the code under test.

const chatInput = stripComments(readFileSync(join(webRoot, "app/features/chat/ChatInput.tsx"), "utf8"));

/** The predicate ChatInput computes as `cmdFreeText`, evaluated on a real line. */
function inFreeText(line: string): boolean {
  const arg = currentArg(parseCommandLine(line, line.length));
  return !!arg && arg.kind === "text" && arg.rest === true;
}

test("the message tail of a routing command is free text", () => {
  // THE case: `/r catJAM`. The tail is a message, not a command token.
  assert.equal(inFreeText("/r hello cat"), true, "mid-word in the message body");
  assert.equal(inFreeText("/r "), true, "the empty message, right after the space");
  assert.equal(inFreeText("/redact some words her"), true);
});

test("a command token is NOT free text — the palette keeps the keys there", () => {
  // Getting this backwards would hand Tab to the emote overlay while the user is
  // half-way through typing a command name, so `/ba` + Tab would stop completing
  // `/ban`. The palette must still win here.
  assert.equal(inFreeText("/r"), false, "still typing the command name");
  assert.equal(inFreeText("/ba"), false);
  assert.equal(inFreeText("/timer "), false, "choosing a sub-command");
  assert.equal(inFreeText("/ban ali"), false, "a `user` argument completes from the palette");
});

test("a ban reason is free text, but the username before it is not", () => {
  // One line, two owners, switching at the space. This is the case that proves
  // the rule is per-CARET and not per-line.
  assert.equal(inFreeText("/ban ali"), false);
  assert.equal(inFreeText("/ban alice being ru"), true);
});

test("an ordinary message is never in command mode at all", () => {
  const p = parseCommandLine("hello cat", 9);
  assert.equal(p.isCommand, false);
  assert.equal(inFreeText("hello cat"), false, "no command, so no free-text ARG either");
});

test("the emote overlay is suppressed by cmdOwnsKeys, not by isCommand", () => {
  // The regression site. `suppress: showingCommandHints` is what killed emote
  // completion for every slash command; the distinction is the whole fix.
  assert.match(chatInput, /const cmdOwnsKeys = showingCommandHints && !cmdFreeText/,
    "the narrower predicate must exist");
  assert.match(chatInput, /suppress: cmdOwnsKeys/,
    "the emote hook must be suppressed by it");
  assert.ok(!/suppress: showingCommandHints/.test(chatInput),
    "suppressing on the broad predicate is the bug");
  assert.match(chatInput, /if \(cmdOwnsKeys\) \{/,
    "and the palette's key block must be gated on it too, so Escape reaches the overlay");
});

test("Tab can never blur the composer while a command is being typed", () => {
  // Ordering is load-bearing: the guard must sit AFTER both completion
  // handlers. In front of them it would swallow the very completion Tab exists
  // for, and the tests above would still pass — so assert the position.
  const guard = chatInput.indexOf('e.key === "Tab" && parsedCmd.isCommand');
  const overlay = chatInput.indexOf("if (handleOverlayKeyDown(e)) return;");
  const palette = chatInput.indexOf("if (cmdOwnsKeys) {");
  assert.ok(guard !== -1, "the fall-through Tab guard must exist");
  assert.ok(palette !== -1 && palette < guard, "it must run after the command palette");
  assert.ok(overlay !== -1 && overlay < guard, "and after the emote overlay");
  assert.match(chatInput.slice(guard, guard + 120), /preventDefault\(\)/,
    "and must actually swallow the key");
});

test("the two overlays never render into the same slot at once", () => {
  // Both are `absolute bottom-full` above the composer. Now that emote matches
  // can appear WHILE a command line is being typed, showing both stacks two
  // panels in one place.
  assert.match(chatInput, /showingCommandHints && overlayMatches\.length === 0 && \(/,
    "the palette must yield while the completion list has matches");
});
