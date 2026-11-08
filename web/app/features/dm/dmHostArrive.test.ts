// An arrival for the conversation already open on screen (the Matrix tab's timeline) opens no
// window over it — Discord shows no banner for the conversation you are in.
// Run: node --test app/features/dm/dmHostArrive.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import "../../lib/testTsx.ts";

const { arriveInto, isBindable, keepsLine } = await import("./dmQueue.ts");

const empty = { current: null, queue: [] };
let n = 0;
const next = () => ++n;

test("arrival for the on-screen room opens no window", () => {
  const s = arriveInto(empty, { partner: "@casey:site.test", roomId: "!dm", invite: false }, "!dm", next);
  assert.equal(s, empty, "state unchanged");
});

test("a draft (no room yet) with someone who then writes first becomes their request — answered, and the window stays", () => {
  const draft = { current: { seq: 9, person: { matrixId: "@casey:site.test", username: "casey", displayName: null }, phase: "open" as const, incoming: false, accepted: true, draft: true }, queue: [] };
  assert.equal(isBindable(draft.current), true, "the draft held the box");
  const s = arriveInto(draft, { partner: "@casey:site.test", roomId: "!theirs", invite: true }, null, next);
  assert.equal(s.current?.seq, 9, "the same window, changed in place (never a new one, never closed)");
  assert.equal(s.current?.roomId, "!theirs");
  assert.equal(s.current?.invite, true);
  assert.equal(s.current?.draft, false);
  assert.equal(s.current?.incoming, true, "their request: Accept · Decline · Block");
  assert.equal(s.current?.accepted, false);
  // DmHost's release leaves the window open exactly when the convo is no longer bindable.
  assert.equal(isBindable(s.current!), false);
});

test("DmHost wires it: the box binds by isBindable, and its release closes the window only while still bindable", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("../../lib/testSource.ts");
  const host = stripComments(readFileSync(new URL("./DmHost.tsx", import.meta.url), "utf8"));
  assert.match(host, /const bindable = !!current && isBindable\(current\);/);
  assert.match(host, /onRelease: \(\) => \{ const now = currentRef\.current; if \(now\?\.seq === c\.seq && isBindable\(now\)\) closeHandle\.current\?\.\(\); \}/);
  // The bound box sends into the room on screen (never another); a draft (no room) makes one.
  assert.match(host, /const room = await roomForSending\(client, c\.person\.matrixId, shown\);/);
  // Accept / Reply hold the room to the strict rule before the box may hold it.
  assert.match(host, /patch\(c\.seq, \{ accepted: true, invite: false, error: undefined, notPrivate: !ok \}\);/);
  assert.match(host, /\}\s*$/, "vacuity anchor: the read reached the end of the file");
});

test("keepsLine: the window takes the box's text exactly when it let go BY ITSELF (each cause), never on the person's own close", () => {
  const person = { matrixId: "@casey:site.test", username: "casey", displayName: null };
  // Cause 1: my draft becomes their request.
  const draft = { seq: 4, person, phase: "open" as const, incoming: false, accepted: true, draft: true };
  const asked = arriveInto({ current: draft, queue: [] }, { partner: person.matrixId, roomId: "!theirs", invite: true }, null, next).current!;
  assert.equal(keepsLine(asked, 4), true, "their request arrived on my draft");
  // Cause 2: someone else joined (the strict check flips notPrivate).
  const room = { seq: 5, person, phase: "open" as const, incoming: false, accepted: true, roomId: "!r", notPrivate: false };
  assert.equal(keepsLine({ ...room, notPrivate: true }, 5), true, "someone else joined");
  // The person's own release (✕, the send-to control): still bindable — the text stays theirs.
  assert.equal(keepsLine(room, 5), false);
  // Another conversation is showing now: not this window's line.
  assert.equal(keepsLine({ ...room, seq: 6, notPrivate: true }, 5), false);
  assert.equal(keepsLine(null, 5), false);
});

test("DmHost wires the kept line: keep / takeKept on the binding, re-declared when a line is kept, and a window holding one never closes by itself", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("../../lib/testSource.ts");
  const host = stripComments(readFileSync(new URL("./DmHost.tsx", import.meta.url), "utf8"));
  assert.match(host, /keep: \(text\) => \{\s*if \(keepsLine\(currentRef\.current, c\.seq\)\) \{ patch\(c\.seq, \{ kept: text \}\); return true; \}\s*if \(!keepWaiting\(stRef\.current, c\.seq, text\)\) return false;/);
  assert.match(host, /takeKept: \(\) => \{/);
  assert.match(host, /\}, \[bindable, current\?\.seq, current\?\.roomId, encrypted, hasKept\]\);/);
  assert.match(host, /autoDismissMs=\{current\.incoming && !current\.accepted && !current\.kept \? UNACCEPTED_MS : undefined\}/);
  // `/dm name text` opens the window first, then sends; a refusal keeps the line (openThenSend).
  assert.match(host, /const r = await openThenSend\(ready\.client, person\.matrixId, text, \(p\) => patch\(seq, p\), currentEmotes\(\)\);/);
  const chat = stripComments(readFileSync(new URL("../chat/ChatInput.tsx", import.meta.url), "utf8"));
  assert.match(chat, /useEffect\(\(\) => watchBoundText\(\(\) => inputRef\.current\?\.value \?\? "", setInput\), \[inputRef\]\);/);
  assert.match(host, /\}\s*$/, "vacuity anchor: the read reached the end of the file");
  assert.match(chat, /\}\s*$/, "vacuity anchor: the read reached the end of the file");
});

test("isBindable: a draft, or a room KNOWN private; never a request, an unchecked room or a group", () => {
  const base = { seq: 1, person: { matrixId: "@c:s", username: "c", displayName: null }, phase: "open" as const, incoming: false, accepted: true };
  assert.equal(isBindable({ ...base, draft: true }), true);
  assert.equal(isBindable({ ...base, roomId: "!r", notPrivate: false }), true);
  assert.equal(isBindable({ ...base, roomId: "!r" }), false, "privacy not checked yet: the box waits");
  assert.equal(isBindable({ ...base, roomId: "!r", notPrivate: true }), false, "an accepted group invite never holds the box");
  assert.equal(isBindable({ ...base, roomId: "!r", invite: true, notPrivate: false }), false);
  assert.equal(isBindable({ ...base, roomId: "!r", accepted: false, notPrivate: false }), false);
});

test("an arrival for another room opens the window; a second one waits in the queue", () => {
  const s1 = arriveInto(empty, { partner: "@casey:site.test", roomId: "!dm", invite: false }, "!elsewhere", next);
  assert.equal(s1.current?.roomId, "!dm");
  assert.equal(s1.current?.incoming, true);
  assert.equal(s1.current?.accepted, false);
  const s2 = arriveInto(s1, { partner: "@sam:site.test", roomId: "!dm2", invite: true }, null, next);
  assert.equal(s2.current, s1.current);
  assert.deepEqual(s2.queue.map((c) => c.roomId), ["!dm2"]);
  assert.equal(arriveInto(s2, { partner: "@sam:site.test", roomId: "!dm2", invite: false }, null, next), s2, "already waiting");
});

test("switchToWaiting: the first waiting conversation shows and the one shown waits at the back; a window that is not a conversation is dropped", async () => {
  const { switchToWaiting } = await import("./dmQueue.ts");
  const person = (u: string) => ({ matrixId: `@${u}:site.test`, username: u, displayName: null });
  const shown = { seq: 1, person: person("casey"), phase: "open" as const, incoming: false, accepted: true, roomId: "!c", notPrivate: false };
  const sam = { seq: 2, person: person("sam"), phase: "open" as const, incoming: true, accepted: false, roomId: "!s", invite: true };
  const kim = { seq: 3, person: person("kim"), phase: "open" as const, incoming: true, accepted: false, roomId: "!k" };
  const s = switchToWaiting({ current: shown, queue: [sam, kim] });
  assert.equal(s.current, sam);
  assert.deepEqual(s.queue.map((c) => c.seq), [3, 1], "casey waits behind kim: tapping on cycles through all of them");
  assert.equal(switchToWaiting({ current: shown, queue: [] }).current, shown, "nobody waiting: nothing changes");
  const gone = [["an error", { ...shown, phase: "error" as const }], ["loading", { ...shown, phase: "loading" as const }], ["blocked", { ...shown, blocked: true }]] as const;
  for (const [what, c] of gone) {
    assert.deepEqual(switchToWaiting({ current: c, queue: [sam] }).queue, [], `${what}: not a conversation to come back to`);
  }
});

test("keepWaiting: a line typed for a conversation switched away waits with it; nothing else is touched", async () => {
  const { keepWaiting } = await import("./dmQueue.ts");
  const person = { matrixId: "@casey:site.test", username: "casey", displayName: null };
  const shown = { seq: 2, person, phase: "open" as const, incoming: true, accepted: false, roomId: "!s" };
  const waiting = { seq: 1, person, phase: "open" as const, incoming: false, accepted: true, roomId: "!c", notPrivate: false };
  const s = keepWaiting({ current: shown, queue: [waiting] }, 1, "see you at 8");
  assert.equal(s?.queue[0]?.kept, "see you at 8");
  assert.equal(s?.current, shown);
  assert.equal(keepWaiting({ current: shown, queue: [waiting] }, 7, "x"), null, "not waiting: not this host's to keep");
});
