// "Does this message mention me?" — read off m.mentions.user_ids.
//
// The fixtures are REAL event content from a homeserver, not invented shapes:
// a fix tested only against an invented fixture can ship green and match zero
// real senders.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/matrixMentions.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mentionsMe } from "./matrixMentions.ts";

// REAL: mautrix-discord relaying a Discord user who mentioned another Discord
// user. The bridge fills m.mentions in, so no HTML parsing is needed.
const BRIDGED = {
  body: "Varane (Discord) Oh the argument that DSA candidates seem to bring universaly when asked about hasan appearnces is \"he has the reach, I just wanna reach the voters\" right?",
  format: "org.matrix.custom.html",
  msgtype: "m.text",
  "m.mentions": { user_ids: ["@discord_410292665704513550:site.test"] },
  formatted_body: "<a href=\"https://matrix.to/#/@discord_410292665704513550:site.test\">Varane (Discord)</a> Oh the argument…",
};

// REAL: a site member replying to a bridged sender — our composer adds the
// replied-to user to m.mentions, which is why replies count as mentions.
const NATIVE_REPLY = {
  body: "> <@discord_909686453515214899:site.test> explain more?\n\nthis bar",
  format: "org.matrix.custom.html",
  msgtype: "m.text",
  "m.mentions": { user_ids: ["@discord_909686453515214899:site.test"] },
  "m.relates_to": { "m.in_reply_to": { event_id: "$cywkeK86aZA3yO_NAxE8d0mvIO7TC5SL6mAzAuRlkTM" } },
};

const PLAIN = { body: "no one in particular", msgtype: "m.text" };

test("a bridged mention names the user it names", () => {
  assert.equal(mentionsMe(BRIDGED, null, "@discord_410292665704513550:site.test"), true);
  assert.equal(mentionsMe(BRIDGED, null, "@casey:site.test"), false);
});

test("a Discord user mentioning a SITE account names the real account", () => {
  // Verified on the server: bridged senders produced m.mentions entries of
  // "@casey:site.test" twice — the bridge resolves a linked Discord user to
  // their Matrix id rather than to a ghost.
  const bridgedAtOwner = { ...BRIDGED, "m.mentions": { user_ids: ["@casey:site.test"] } };
  assert.equal(mentionsMe(bridgedAtOwner, null, "@casey:site.test"), true);
});

test("a reply to you is a mention of you", () => {
  assert.equal(mentionsMe(NATIVE_REPLY, null, "@discord_909686453515214899:site.test"), true);
});

test("a message with no mentions mentions nobody", () => {
  assert.equal(mentionsMe(PLAIN, null, "@casey:site.test"), false);
  assert.equal(mentionsMe(null, null, "@casey:site.test"), false);
  assert.equal(mentionsMe(undefined, undefined, "@casey:site.test"), false);
});

test("an EDIT decides: its replacement content is what the reader sees", () => {
  // The edited content carries the full replacement mention set, so an edit can
  // both add and remove a mention.
  const added = { msgtype: "m.text", body: "hey @casey", "m.mentions": { user_ids: ["@casey:site.test"] } };
  assert.equal(mentionsMe(PLAIN, added, "@casey:site.test"), true);

  const removed = { msgtype: "m.text", body: "never mind", "m.mentions": { user_ids: [] } };
  assert.equal(mentionsMe(BRIDGED, removed, "@discord_410292665704513550:site.test"), false);
});

test("a malformed m.mentions never throws", () => {
  assert.equal(mentionsMe({ "m.mentions": "nonsense" }, null, "@a:b"), false);
  assert.equal(mentionsMe({ "m.mentions": { user_ids: "nope" } }, null, "@a:b"), false);
  assert.equal(mentionsMe({ "m.mentions": { user_ids: [1, null] } }, null, "@a:b"), false);
});

test("an empty user id never matches", () => {
  assert.equal(mentionsMe({ "m.mentions": { user_ids: [""] } }, null, ""), false);
});
