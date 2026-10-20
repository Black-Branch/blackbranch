// The DM nudge reaches only its recipient (external review S5).
//
// Before: POST /api/dm/ping sent stream-api a STABLE per-recipient tag (an HMAC of the Matrix id)
// and stream-api broadcast it on the PUBLIC chat socket. Any signed-in account could nudge a chosen
// target, watch the socket for the frame that followed, and from then on recognise every nudge to
// that person — who is being messaged, and when — without knowing the secret.
// Now: the POST only records a pending nudge for the recipient on the web server (nudgeBox.ts), and
// the recipient's own signed-in page asks for it (GET /api/dm/ping, its session's id only). Nothing
// about a nudge leaves on a public channel, so there is nothing to correlate.
//
// Run: node --test app/lib/dm/nudgeBox.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../testSource.ts";
import { createNudgeBox, NUDGE_TTL_MS } from "./nudgeBox.ts";

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
const PING = read("../../api/dm/ping/route.ts");

const A = "@mallory:site.test"; // the attacker
const B = "@casey:site.test";   // the target

test("account A cannot label account B's future notification traffic by inducing a nudge", () => {
  // Everything A can observe, in two worlds that differ ONLY in whether C later messages B.
  const world = (cMessagesB: boolean) => {
    let t = 1_000_000;
    const box = createNudgeBox(() => t);
    const seenByA: unknown[] = [];
    seenByA.push(box.latest(A));      // A polls its own nudges
    box.record(B);                    // A nudges B (the POST answers a constant { ok: true })
    seenByA.push(box.latest(A));
    t += 5_000;
    if (cMessagesB) box.record(B);    // C, unrelated, messages B
    t += 5_000;
    seenByA.push(box.latest(A));
    return { seenByA, bSees: box.latest(B) };
  };
  const quiet = world(false);
  const busy = world(true);
  assert.deepEqual(busy.seenByA, quiet.seenByA, "A's observations change with traffic to B — A can label it");
  assert.deepEqual(busy.seenByA, [0, 0, 0], "A sees nudges that are not its own");
  assert.ok(busy.bSees > quiet.bSees && quiet.bSees > 0, "B must still learn of each nudge");
});

test("the POST puts nothing on a public channel: no stream-api call, no per-recipient tag", () => {
  const post = PING.slice(PING.indexOf("export async function POST"));
  assert.ok(post.length > 100, "vacuity: the POST handler was read");
  assert.doesNotMatch(PING, /streamApiFetch|\/chat\/dm-ping|createHmac|dmKey/, "a recipient-derived value still leaves the web server");
  assert.match(post, /dmNudges\.record\(to\);\s*return Response\.json\(\{ ok: true \}\);\s*\}\s*$/, "the POST must only record, then answer the same thing every time");
});

test("the GET answers only for the session's own account, takes no input and is never cached", () => {
  const get = PING.slice(PING.indexOf("export async function GET"), PING.indexOf("export async function POST"));
  assert.match(get, /const me = session\?\.user\?\.id;\s*if \(!me\) return/);
  assert.match(get, /at: dmNudges\.latest\(me\)/, "the nudges of the session's own id, never a requested one");
  assert.doesNotMatch(get, /searchParams|req\b/, "takes no input");
  assert.match(get, /"Cache-Control": "private, no-store"/);
});

test("the page watches by asking: an interval only while the tab is visible, a look on a NEW stamp only", () => {
  const host = read("../../features/dm/DmHost.tsx");
  assert.doesNotMatch(host, /onDmPing|ownDmKey/, "the public-socket listener is back");
  assert.match(host, /const at = await latestDmNudge\(\);/);
  assert.match(host, /if \(seen !== null && at > seen\)/, "a nudge from before the page loaded, or one already seen, must not trigger a look");
  assert.match(host, /if \(asking \|\| \(document\.hidden && seen !== null\)\) return;/, "a hidden tab must not poll (but must take its baseline)");
  assert.match(host, /setInterval\(\(\) => void poll\(\), NUDGE_POLL_MS\)/);
  const chat = read("../useChatMessages.ts");
  assert.doesNotMatch(chat, /dm_ping/, "the chat socket still acts on a dm_ping frame");
});

test("stamps only rise; a nudge expires after its TTL; the box stays bounded", () => {
  let t = 5_000;
  const box = createNudgeBox(() => t, 3);
  box.record(B);
  const first = box.latest(B);
  box.record(B); // same millisecond
  assert.ok(box.latest(B) > first, "two nudges in one millisecond read as one");
  t += NUDGE_TTL_MS + 1;
  assert.equal(box.latest(B), 0, "a nudge outlived its TTL");
  for (const who of ["@1:x", "@2:x", "@3:x", "@4:x", "@5:x"]) box.record(who);
  assert.ok(box.size() <= 3, `the box grew past its cap (${box.size()})`);
  assert.ok(box.latest("@5:x") > 0, "the newest nudge was evicted");
});
