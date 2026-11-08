// Ticket #193: `/dm <name>` completes from EVERY account (the server's lookup), not from the people
// in chat. dmNameToken says when the caret is in that name; personSuggestions turns the server's
// people into palette rows. The palette marks the matched part (CommandPalette + MatchText).
// Run: node --test app/lib/commands/dmCompletion.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import "../testTsx.ts";

const { parseCommandLine, dmNameToken, personSuggestions } = await import("./parse.ts");

test("the caret in /dm's (or /message's) name gives the typed name; anywhere else, null", () => {
  assert.equal(dmNameToken(parseCommandLine("/dm fre")), "fre");
  assert.equal(dmNameToken(parseCommandLine("/message @kat")), "@kat");
  assert.equal(dmNameToken(parseCommandLine("/dm ")), "", "a fresh name: nothing typed yet");
  assert.equal(dmNameToken(parseCommandLine("/dm casey hel")), null, "in the message: not a name");
  assert.equal(dmNameToken(parseCommandLine("/ban fre")), null, "another command's user keeps the chat's names");
  assert.equal(dmNameToken(parseCommandLine("hello")), null);
});

test("the server's people become rows: the username goes in, the display name beside it", () => {
  assert.deepEqual(personSuggestions([
    { matrixId: "@jonfreeholder:site.test", username: "jonfreeholder", displayName: "Jon" },
    { matrixId: "@freeda:site.test", username: "freeda", displayName: null },
    { matrixId: "@robin:site.test", username: "robin", displayName: "robin" },
  ]), [
    { value: "jonfreeholder", label: "jonfreeholder", desc: "Jon", kind: "user" },
    { value: "freeda", label: "freeda", desc: "", kind: "user" },
    { value: "robin", label: "robin", desc: "", kind: "user" },
  ]);
});

test("two accounts sharing a username (another server's) complete to their full ids, so the pick names one person", () => {
  assert.deepEqual(personSuggestions([
    { matrixId: "@lane:site.test", username: "lane", displayName: null },
    { matrixId: "@lane:other.example", username: "lane", displayName: "Lane" },
  ]).map((s) => s.value), ["@lane:site.test", "@lane:other.example"]);
});

test("ChatInput completes /dm from the lookup, not from the chat's names", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("../testSource.ts");
  const src = stripComments(readFileSync(new URL("../../features/chat/ChatInput.tsx", import.meta.url), "utf8"));
  assert.match(src, /const dmToken = matrixId \? dmNameToken\(parsedCmd\) : null;\s*const dmSearch = useDmNameSearch\(dmToken\);/);
  assert.match(src, /: dmToken !== null \? personSuggestions\(dmSearch\.people\)\s*: suggestFor\(parsedCmd, viewer, mentionCandidates\.map\(\(p\) => p\.name\)\)\)/);
});
