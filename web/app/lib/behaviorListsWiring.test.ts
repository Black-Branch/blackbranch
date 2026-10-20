// Behavior lists wiring: the lists and flags reach the chat rows, the unread dots and the sound.
// Source scans (the components cannot render under node --test).
// Run: node --test app/lib/behaviorListsWiring.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
const sidebar = read("app", "features", "chat", "ChatSidebar.tsx");
const win = read("app", "features", "chat", "ChatWindow.tsx");
const deriv = read("app", "lib", "useChatRowDerivations.ts");
const msgSrc = read("app", "features", "chat", "ChatMessage.tsx");
const css = read("app", "globals.css");

test("both chat lists drop hidden people (and bots when asked) before the rows are built", () => {
  for (const [name, src] of [["ChatSidebar", sidebar], ["ChatWindow", win]] as const) {
    assert.match(src, /const shown = useShownMessages\(rendered\);/, name);
    assert.match(src, /useChatRowDerivations\(\{[^}]*rendered: shown/, `${name} builds rows from the unfiltered list`);
  }
  const hook = read("app", "lib", "useShownMessages.ts");
  assert.match(hook, /hiddenMatcher\(lists\)/);
  assert.match(hook, /useSetting\("chatStyle_hideBots"\) === "1"/);
  // Paid / system cards are never hidden.
  assert.match(hook, /\(m: ChatMsg\) => !m\.system && \(isHidden\(m\) \|\| \(hideBots && !!m\.isBot\)\)/);
  assert.match(hook, /list\.filter\(\(m\) => !hides\(m\)\)/, "the filter and the predicate disagree");
});

test("the mention sound never hears a hidden person or a hidden bot", () => {
  assert.match(sidebar, /const alertsMe = useCallback\(\(m: ChatMsg\) => !hidesMessage\(m\) && mentionsMe\(m\)/);
  assert.match(sidebar, /useMentionSound\(messages, alertsMe\)/);
});

test("highlighted words highlight a row (and so ping), never your own message", () => {
  assert.match(deriv, /words\?: readonly string\[\];/);
  assert.match(deriv, /const wordHit = useMemo\(\(\) => wordsMatcher\(words \?\? \[\]\), \[words\]\);/);
  assert.match(deriv, /\|\| wordHit\(msg\.message\)/);
  for (const [name, src] of [["ChatSidebar", sidebar], ["ChatWindow", win]] as const) {
    assert.match(src, /words: lists\.words/, name);
  }
});

test("a hidden person or hidden bot never lights the Live dot", () => {
  assert.match(sidebar, /const onLiveBatch = useCallback\(\(batch: readonly ChatMsg\[\]\) => \{\s*if \(batch\.some\(\(m\) => !hidesMessage\(m\)\)\) markLiveUnseen\(\);/);
  assert.match(sidebar, /onMessageReceived: onLiveBatch,/);
  const hook = read("app", "lib", "useChatMessages.ts");
  assert.match(hook, /onMessageReceivedRef\.current\?\.\(batch\);/, "the batch never reaches the callback");
});

test("the Community dot never lights for an ignored sender", () => {
  const split = read("app", "lib", "useChatSplitView.ts");
  assert.match(split, /isIgnoredSender\(/);
});

test("the site chat publishes its directory for the Behavior menu's + field", () => {
  assert.match(sidebar, /publishLiveDirectory\(directory, \{ matrixId: userId \?\? null, canonicalId: canonicalId \?\? null, ownIds: \[\.\.\.ownIds\] \}\)/);
  assert.match(sidebar, /useHiddenIgnoreSync\(\);/);
  const sync = read("app", "lib", "useHiddenIgnoreSync.ts");
  assert.match(sync, /!accountListsLoaded\(\)\) return;/, "the sync could run on the empty placeholder and un-ignore everyone");
});

test("first-time chatters get a tag the switch can hide", () => {
  assert.match(msgSrc, /\{msg\.isFirst && firstTag && <span className="chat-first-tag"[^>]*>new<\/span>\}/);
  assert.match(read("app", "features", "chat", "ChatOverlay.tsx"), /<ChatMessage\s+firstTag=\{false\}/, "the tag would go out on stream");
  assert.match(css, /\.chat-first-off \.chat-first-tag \{ display: none; \}/);
  assert.match(css, /\.chat-first-tag \{/);
});

test("vacuity: files read to their end", () => {
  assert.ok(sidebar.length > 20000 && win.length > 5000 && deriv.length > 1000 && css.length > 20000);
});

test("the name card offers Hide / Show again, never on your own messages", () => {
  const card = read("app", "components", "UserCard.tsx");
  // Your own lines on any platform are told apart by your own public ids (ownIdentity.ts); until
  // they have loaded, only a site row (checked by Matrix id) is offered Hide.
  assert.match(card, /const hideTarget = isOwnMessage \|\| \(!!msg\.publicId && ownIds\.has\(msg\.publicId\)\)\s*\? null\s*: ownIdsKnown \|\| \(msg\.matrixId && ownMatrixId\) \? personOfMessage\(msg\) : null;/,
    "a platform row (maybe your own Twitch line) is offered Hide before your own ids are known");
  // The /chat window publishes the viewer too, so its name cards can check.
  assert.match(win, /publishLiveDirectory\(directory, \{ matrixId: me\.matrixId \?\? null, canonicalId: me\.canonicalId \?\? null, ownIds: \[\.\.\.ownIds\] \}\)/);
  assert.match(card, /!isOwnMessage && \(msg\.matrixId \|\| hideTarget \|\| canReport\)/);
  assert.match(card, /\{isHiddenHere \? "Show again" : "Hide"\}/);
});

test("/ignore and /unignore are everyone's commands and run the store", () => {
  const spec = read("app", "lib", "commands", "spec.ts");
  assert.match(spec, /name: "ignore", desc: "[^"]+", scope: "all", run: "ignore"/);
  assert.match(spec, /name: "unignore", desc: "[^"]+", scope: "all", run: "unignore"/);
  const run = read("app", "lib", "commands", "run.ts");
  assert.match(run, /const r = await hidePerson\(who, liveViewer\(\)\);/);
  assert.match(run, /await unhidePerson\(person\.id\)/);
});

test("a reply to a hidden person keeps their name, not their quoted words", () => {
  assert.match(msgSrc, /\{msg\.reply_to_text && !quoteHidden && \(/);
  for (const [name, src] of [["ChatSidebar", sidebar], ["ChatWindow", win]] as const) {
    assert.match(src, /quoteHidden=\{!!row\.msg\.reply_to_username && hiddenNames\.has\(row\.msg\.reply_to_username\.toLowerCase\(\)\)\}/, name);
  }
});

test("the store never saves lists it has not read, and re-reads before every change", () => {
  const st = read("app", "lib", "behaviorStore.ts");
  const change = st.slice(st.indexOf("async function change("), st.indexOf("export type HideResult"));
  assert.match(change, /^async function change[^{]*\{\s*if \(!\(await fetchLists\(\)\)\) return false;/,
    "a change is applied before the CURRENT lists were read — a failed or stale load would be PUT over the account");
  assert.match(st, /loading \?\?= fetchLists\(\)\.then\(\(ok\) => \{ if \(!ok\) loading = null; return ok; \}\);/,
    "a failed load is cached for the life of the page");
  assert.match(st, /visibilitychange[\s\S]{0,160}fetchLists\(\)/, "a tab coming back does not re-read");
  assert.doesNotMatch(st, /\nfunction save\(/, "the old blind save is back");
});

test("a reply to a hidden person offers no jump, preview or spoken quote", () => {
  assert.match(msgSrc, /return onReplyJump && !quoteHidden \? \(/);
});
