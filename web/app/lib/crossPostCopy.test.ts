// Decision 1's copy: linking (private) and posting (on by default) explained
// SEPARATELY, in the same words wherever they are said, and the moment of linking
// says what now happens to the person's messages and where to change it.
//
// Run: node --test app/lib/crossPostCopy.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
import { LINKING_IS_PRIVATE, POSTING_IS_SEPARATE, linkedBanner, refusalNoteForms, refusalState } from "./crossPostCopy.ts";

// The full sentence is the first (longest) form.
const refusalNote = (p: string, r: string) => refusalNoteForms(p, r)[0]!;

const squash = (s: string) => s.replace(/\s+/g, " ");

test("the sentence pair, verbatim (the legal page carries the same words)", () => {
  assert.equal(LINKING_IS_PRIVATE,
    "Linking an account is private: the link itself is shown only where you choose to show it.");
  assert.equal(POSTING_IS_SEPARATE,
    "Posting is separate: while an account is linked, your messages here are also posted to that platform unless you pick a different destination in the chat box, and a message posted there carries your name there.");
});

test("the linking panel says both, as two separate paragraphs, from the one source", () => {
  const panel = stripComments(readFileSync(new URL("../components/AccountLinkPanel.tsx", import.meta.url), "utf8"));
  const a = panel.indexOf("{LINKING_IS_PRIVATE}");
  const b = panel.indexOf("{POSTING_IS_SEPARATE}");
  assert.ok(a > 0 && b > a, "linking first, posting second");
  assert.match(panel.slice(a, b), /<\/p>\s*<p>/, "two paragraphs — the two things are never run together");
  assert.doesNotMatch(panel, /Linking is private by default|The link shows when you show it/,
    "the old copy, which folded posting into 'the link shows when you show it', is gone");
  // END anchor.
  assert.match(panel.trimEnd(), /\n\}$/);
});

test("About carries the same two sentences, word for word", () => {
  const about = squash(stripComments(readFileSync(new URL("../about/page.tsx", import.meta.url), "utf8")));
  assert.ok(about.includes(LINKING_IS_PRIVATE), "About lost the linking sentence");
  assert.ok(about.includes(POSTING_IS_SEPARATE), "About lost the posting sentence");
  assert.doesNotMatch(about, /when you ask it to/, "the old 'only when you ask it to' claim contradicts the default");
});

test("at the moment of linking: messages will also post there, and where to change it", () => {
  const msg = linkedBanner("kick", { crossPost: true, storedDest: null, pending: false });
  assert.match(msg, /^Kick linked\. Your messages here will now also be posted to Kick/);
  assert.match(msg, /Send-to button in the chat box/);
  assert.equal(linkedBanner("kick", { crossPost: true, storedDest: "all", pending: false }), msg, "'all' includes the new platform");
});

test("at the moment of linking, a person who picked one destination is told it stays put", () => {
  const msg = linkedBanner("kick", { crossPost: true, storedDest: "twitch", pending: false });
  assert.match(msg, /set to send to Twitch only, so nothing goes to Kick until you pick it \(or All\)/);
  assert.match(linkedBanner("kick", { crossPost: true, storedDest: "native", pending: false }), /only, so nothing goes to Kick/);
});

test("a platform the site cannot post to says nothing about posting; pending identity still says so", () => {
  assert.equal(linkedBanner("youtube", { crossPost: false, storedDest: null, pending: false }), "YouTube linked.");
  assert.match(linkedBanner("kick", { crossPost: true, storedDest: null, pending: true }), /connect the first time you chat there/);
});

test("the panel's OAuth banner uses it, with the chat box's real stored destination", () => {
  const panel = stripComments(readFileSync(new URL("../components/AccountLinkPanel.tsx", import.meta.url), "utf8"));
  assert.match(panel, /msg: linkedBanner\(linkedParam, \{\s*crossPost: canCrossPost\(linkedParam\),\s*storedDest: wsGet\("chatTargetDest"\),/);
});

// ── Refusal notes ───────────────────────────────────────────────────────
// A persistent refusal is explained ONCE, with the fix in the same sentence.

test("refusalNote: the platform's state and the fix, in one calm sentence", () => {
  assert.equal(refusalNote("kick", "followers-only"),
    "Kick is followers-only. Follow on Kick to post there, or change Send to.");
  assert.equal(refusalNote("twitch", "subscribers-only"),
    "Twitch is subscribers-only. Subscribe on Twitch to post there, or change Send to.");
  assert.equal(refusalNote("kick", "you're banned there"),
    "You're banned on Kick, so your messages post here only. Change Send to to stop trying Kick.");
  assert.equal(refusalNote("twitch", "needs a verified email"),
    "Twitch won't take your messages (needs a verified email). Fix it on Twitch to post there, or change Send to.");
  for (const r of ["followers-only", "subscribers-only", "you're banned there", "channel suspended"]) {
    assert.doesNotMatch(refusalNote("kick", r), /not sent|error|failed/i, "the line IS posted here — never 'not sent'");
  }
});

test("refusalNoteForms: the full sentence plus shorter forms for a narrow composer, each with the fix", () => {
  assert.deepEqual(refusalNoteForms("kick", "followers-only"), [
    "Kick is followers-only. Follow on Kick to post there, or change Send to.",
    "Kick is followers-only — tap Send to",
    "Follow on Kick",
  ]);
  assert.deepEqual(refusalNoteForms("twitch", "subscribers-only"), [
    "Twitch is subscribers-only. Subscribe on Twitch to post there, or change Send to.",
    "Twitch is subscribers-only — tap Send to",
    "Subscribe on Twitch",
  ]);
  assert.deepEqual(refusalNoteForms("kick", "you're banned there"), [
    "You're banned on Kick, so your messages post here only. Change Send to to stop trying Kick.",
    "Banned on Kick — change Send to",
    "Banned on Kick",
  ]);
  assert.deepEqual(refusalNoteForms("twitch", "needs a verified email"), [
    "Twitch won't take your messages (needs a verified email). Fix it on Twitch to post there, or change Send to.",
    "Twitch refused — tap Send to",
    "Fix it on Twitch",
  ]);
  for (const r of ["followers-only", "subscribers-only", "you're banned there", "channel suspended"]) {
    const forms = refusalNoteForms("streamplace", r);
    assert.match(forms[0]!, /Send to/, "the long form is the full sentence, fix included");
    for (let i = 1; i < forms.length; i++) assert.ok(forms[i]!.length < forms[i - 1]!.length, "each form is shorter than the last");
  }
});

test("refusalState: what the Send-to menu shows beside the platform", () => {
  assert.equal(refusalState("followers-only"), "followers-only");
  assert.equal(refusalState("you're banned there"), "banned");
  assert.equal(refusalState("needs a verified phone"), "needs a verified phone");
});
