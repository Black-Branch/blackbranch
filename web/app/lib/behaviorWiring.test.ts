// Behavior wiring: the settings reach the chat rows, tab dots, sound and text they govern.
// Source scans (the components cannot render under node --test).
// Run: node --test app/lib/behaviorWiring.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
const msgSrc = read("app", "features", "chat", "ChatMessage.tsx");
const css = read("app", "globals.css");
const sidebar = read("app", "features", "chat", "ChatSidebar.tsx");
const win = read("app", "features", "chat", "ChatWindow.tsx");

test("row tints are classes, not Tailwind colours, so the switches can hide them", () => {
  const rowBg = msgSrc.slice(msgSrc.indexOf("const rowBg"), msgSrc.indexOf("const eventBgColor"));
  // Every applicable tint is added (not an either/or chain), so a switched-off
  // higher tint reveals the lower one instead of nothing.
  assert.match(rowBg, /\[highlight && "chat-row-mention", !isEventRow && score > 0 && "chat-row-up", own && "chat-row-own"\]\.filter\(Boolean\)\.join\(" "\)/);
  assert.doesNotMatch(rowBg, /rgba\(240,180,100|rgba\(153,193,241/, "a tint is still a Tailwind class the switch cannot reach");
  // The reply line's "to you" colour follows the mention switch too.
  assert.doesNotMatch(msgSrc, /#f0b464/);
  assert.match(msgSrc, /highlight \? "chat-reply-me"/);
});

test("the CSS paints each tint only while its switch is on, AFTER the alternating stripe", () => {
  const alt = css.indexOf(".alt-rows .chat-msg-alt");
  for (const [sel, name] of [
    [/html:not\(\.chat-mention-hl-off\) \.chat-msg-row\.chat-row-mention \{ background:/, "mention"],
    [/html:not\(\.chat-upvote-hl-off\) \.chat-msg-row\.chat-row-up \{ background:/, "upvote"],
    [/html\.chat-own-tint \.chat-msg-row\.chat-row-own \{ background:/, "own"],
    [/html:not\(\.chat-mention-hl-off\) \.chat-reply-me \{ color:/, "reply-me"],
  ] as const) {
    const m = sel.exec(css);
    assert.ok(m, `${name} rule missing`);
    assert.ok(m.index > alt, `${name} rule sits before the alternating stripe, which would paint over it`);
  }
  const at = (re: RegExp) => re.exec(css)?.index ?? -1;
  const own = at(/\.chat-row-own \{/), up = at(/\.chat-row-up \{/), men = at(/\.chat-msg-row\.chat-row-mention \{/);
  assert.ok(own < up && up < men, "the winner order must be own < upvote < mention (last wins)");
});

test("both chat lists tell each row whether it is yours", () => {
  for (const [name, src] of [["ChatSidebar", sidebar], ["ChatWindow", win]] as const) {
    assert.match(src, /own=\{row\.isOwn \|\| row\.isOwnStream\}/, name);
  }
  assert.match(msgSrc, /\n\s+own\?: boolean;/);
});

test("Community's mention mark follows the mention switch", () => {
  const row = read("app", "components", "MatrixMessageRow.tsx");
  assert.match(row, /mentioned \? "chat-row-mention-mx"/);
  assert.doesNotMatch(row, /border-amber-400/);
  assert.match(css, /html:not\(\.chat-mention-hl-off\) \.chat-row-mention-mx \{/);
});

test("Unread dots off hides the blue dots, never the red mention counts", () => {
  const chrome = read("app", "components", "chrome", "chrome.css");
  assert.match(chrome, /\.chat-dots-off \.chrome-tab-dot \{ display: none; \}/);
  const parts = read("app", "features", "community", "parts.tsx");
  const dot = parts.slice(parts.indexOf("function UnreadDot"));
  assert.match(dot, /data-unread-dot=\{highlight > 0 \? undefined : ""\}/, "the blue dot carries no hook");
  assert.match(css, /\.chat-dots-off \[data-unread-dot\] \{ display: none; \}/);
});

test("the swear mask reaches only plain text pieces, and only when switched on", () => {
  const rt = read("app", "lib", "renderText.tsx");
  assert.match(rt, /opts\?: \{ still\?: boolean; mask\?: boolean \}/);
  assert.match(rt, /renderTextRun\(opts\?\.mask \? maskProfanity\(seg\.text\) : seg\.text,/);
  // Plain text and a [label](url) LABEL (its href is separate) — never a URL, emote or mention.
  assert.match(rt, /\{opts\?\.mask \? maskProfanity\(label\) : label\}/);
  assert.equal((rt.match(/maskProfanity\(/g) ?? []).length, 2, "masked somewhere other than text and link labels");
  assert.match(msgSrc, /renderText\(msg\.message, emotes, msg\.emotes, directory, \{ still: stillEmotes, mask: maskSwears \}\)/);
  // Read ONCE per list and passed down (like stillEmotes) — a hook per row would
  // put one window listener per message on the page.
  assert.doesNotMatch(msgSrc, /chatStyle_profanityFilter/);
  assert.match(msgSrc, /\n\s+maskSwears\?: boolean;/);
  for (const [name, src] of [["ChatSidebar", sidebar], ["ChatWindow", win]] as const) {
    assert.match(src, /useSetting\("chatStyle_profanityFilter"\)/, name);
    assert.match(src, /maskSwears=\{maskSwears\}/, name);
  }
});

test("every other path that shows chat text masks too", () => {
  const ev = read("app", "components", "chatEventBody.tsx");
  assert.equal((ev.match(/renderText\([^)]*\{ mask \}\)/g) ?? []).length, 3, "tip / event / TTS text");
  assert.match(msgSrc, /eventBody\(msg, emotes, indicatorColor, maskSwears\)/);
  const red = read("app", "components", "RedactedText.tsx");
  assert.equal((red.match(/\{ still: stillEmotes, mask \}/g) ?? []).length, 3, "supporter message: visible + opened text");
  assert.match(red, /mask \? maskProfanity\(r\.text\) : r\.text/, "the quoted reply of a supporter message");
  assert.match(msgSrc, /mask=\{maskSwears\}\n\s+\/>/, "RedactedText is not given the mask");
  assert.match(msgSrc, /<RedactedQuote text=\{snippet\(msg\.reply_to_text\)\} mask=\{maskSwears\} \/>/);
  const pin = read("app", "components", "PinnedBanner.tsx");
  assert.match(pin, /renderText\(pin\.message, emotes, pin\.emotes, undefined, \{ mask: maskSwears \}\)/);
});

test("the mention sound runs from the site chat through the gate, never the /chat window", () => {
  const hook = read("app", "lib", "useMentionSound.ts");
  assert.match(hook, /createMentionGate\(\)/);
  assert.match(hook, /playMentionSound\(/);
  assert.match(hook, /useSetting\("chatStyle_mentionSound"\)/);
  // Fed the whole buffer, not the rendered rows (frozen while scrolled up).
  assert.match(sidebar, /useMentionSound\(messages, alertsMe\)/); // whole buffer; alertsMe drops hidden senders (half B)
  assert.match(hook, /live: !!m\._anim/, "the gate is not told which messages arrived live");
  // Never in the /chat window: it doubles as an OBS dock, where a ping would go out on stream.
  assert.doesNotMatch(win, /useMentionSound/);
});

test("vacuity: files read to their end", () => {
  assert.ok(css.length > 20000 && msgSrc.length > 20000 && sidebar.length > 20000 && win.length > 5000);
});
