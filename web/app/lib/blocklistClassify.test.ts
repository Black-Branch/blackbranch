// Tests for severity-driven blocklist classification (pure, node --test).
//
// The list itself ships EMPTY, so these build their own entries via the real
// matcher rather than depending on operator data — the logic under test is the
// severity → outcome mapping and the worst-match rule, not the word list.
//
// Run: node --test app/lib/blocklistClassify.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { actionFor, classify, classifyWith, compileTerms, BLOCKLIST } from "./blacklist.ts";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

// ── The category mapping ─────────────────────────────────────────────────────

test("severity maps to its outcome, at every level", () => {
  //   4 severe → block (never delivered; mods moderate the PERSON)
  //   2-3 mid  → hold  (withheld, mod allows or denies)
  //   1 mild   → allow (no row, no interruption)
  assert.equal(actionFor(4), "block");
  assert.equal(actionFor(3), "hold");
  assert.equal(actionFor(2), "hold");
  assert.equal(actionFor(1), "allow");
});

test("severity 4 is never merely HELD", () => {
  // The distinction that motivated the design: a queue whose Allow button
  // publishes a slur is one mis-click from the worst possible outcome. Severe
  // terms must be refused outright and recorded, never left pending.
  assert.notEqual(actionFor(4), "hold");
});

// ── The shipped list ─────────────────────────────────────────────────────────
//
// The list is populated from dsojevic/profanity-list, so the real risks are
// flagging ordinary speech, and re-importing upstream severity naively.

test("ordinary chat and the classic false-positive traps are never flagged", () => {
  // These are the words that embarrass a filter in public. They pass because
  // the matcher uses letter-lookaround boundaries — but a future change to the
  // matcher OR a careless term addition could break that silently, in front of
  // an audience.
  const innocent = [
    "hey chat how is everyone doing tonight",
    "Scunthorpe", "Penistone", "assassin", "Sussex", "Middlesex",
    "cockpit", "shuttlecock", "niggardly", "Nigeria", "Niger river",
    "denigrate", "snigger", "Dickinson", "Hancock", "therapist",
    "specialist", "class action", "grape juice", "Uranus",
    "shiitake mushrooms", "bassist", "Matsushita", "Kumamoto",
    "phuket thailand", "Lake Titicaca",
    // Plural forms of the traps — the plural-tail matcher must not turn a
    // trailing s into a new Scunthorpe problem.
    "assassins", "therapists", "specialists", "bassists", "cockpits",
    "sniggers", "Nigerians", "grapes", "Dickinsons",
  ];
  for (const s of innocent) {
    const v = classify(s);
    assert.equal(v.action, "allow", `"${s}" was flagged by term "${"term" in v ? v.term : "?"}"`);
  }
});

test("ordinary profanity is NOT on the list", () => {
  // The decision this pins. Upstream rates `fuck` 4 and `shit` 2 — its scale
  // measures how PROFANE a word is, not how much moderator attention it needs.
  // Imported literally it would hard-block ordinary swearing on a political
  // commentary stream while leaving actual slurs merely "held". We map by
  // CATEGORY instead (racial / lgbtq / shock kept; general / sexual /
  // religious dropped). A naive re-import would silently undo that.
  for (const word of ["fuck", "shit", "bitch", "damn", "crap", "ass", "dick"]) {
    assert.equal(classify(word).action, "allow", `ordinary profanity "${word}" should not be filtered`);
  }
});

test("the list is populated, and severe terms really do block", () => {
  assert.ok(BLOCKLIST.length > 100, `expected a populated list, got ${BLOCKLIST.length}`);
  assert.ok(BLOCKLIST.some((e) => e.severity === 4), "no severity-4 terms — nothing would ever be blocked");
  // Separator evasion must still be caught at the shipped list's settings.
  const severe = BLOCKLIST.find((e) => e.severity === 4)!;
  assert.equal(classify(severe.term).action, "block");
  assert.equal(classify(severe.term.split("").join(".")).action, "block", "separator evasion slipped through");
});

test("plural forms of a listed term are the same term", () => {
  // A plural slur is the same slur, including with separator evasion — the
  // boundary lookaround must not read the plural s as "inside a longer word" —
  // and a y-ending term pluralizes as -ies.
  const severe = BLOCKLIST.find((e) => e.severity === 4)!;
  assert.equal(classify(`${severe.term}s`).action, "block", "plural bypassed the filter");
  assert.equal(classify(`${severe.term}es`).action, "block", "es-plural bypassed the filter");
  assert.equal(classify(`${severe.term}s`.split("").join(" ")).action, "block", "spaced plural bypassed the filter");
  const yTerm = BLOCKLIST.find((e) => e.term.endsWith("y") && /^[a-z]+$/.test(e.term));
  if (yTerm) {
    assert.notEqual(classify(`${yTerm.term.slice(0, -1)}ies`).action, "allow", "ies-plural bypassed the filter");
  }
});

// ── The worst-match rule ─────────────────────────────────────────────────────

test("the HIGHEST severity match wins, not the first", () => {
  // Otherwise the order of the term list silently decides whether a slur is
  // blocked or merely held — a mild word listed first would downgrade it.
  // Drives the REAL classifyWith through compileTerms: a test that
  // reimplemented the worst-match loop locally would stay green when the
  // shipped rule broke. Fixtures in, real logic under test.
  const pats = compileTerms([
    { term: "mildword", severity: 1 },
    { term: "midword", severity: 3 },
    { term: "severeword", severity: 4 },
  ]);
  const worstOf = (text: string) => classifyWith(pats, text).action;

  assert.equal(worstOf("just mildword here"), "allow");
  assert.equal(worstOf("mildword and midword"), "hold");
  // Severe listed LAST, mild listed first — the mapping must still block.
  assert.equal(worstOf("mildword then severeword"), "block");
  assert.equal(worstOf("severeword alone"), "block");
});

// ── Latency, the constraint k set ────────────────────────────────────────────

test("classification does no I/O", () => {
  // No message may be delayed for processing in a way that makes sending feel
  // sluggish. Every clean message runs this,
  // so a query or fetch here would tax the whole room. The review WRITE is the
  // caller's job, happens only on a hit, and is fire-and-forget.
  const src = stripComments(read("app/lib/blacklist.ts"));
  for (const banned of ["pool.query", "await ", "fetch(", "async "]) {
    assert.ok(!src.includes(banned), `blacklist.ts must stay synchronous and I/O-free (found ${banned.trim()})`);
  }
});

test("a BLOCKED hit's review write is fire-and-forget, never awaited by the sender", () => {
  // Awaiting it would put a DB round trip in front of the sender's response for
  // a message that is not being delivered anyway. A HOLD is the one exception, on
  // purpose: the sender is given the row id to follow the message by
  // (holdBlocklistHit, heldMessages.test.ts) — a held message is rare.
  const src = stripComments(read("app/lib/blocklistReview.ts"));
  assert.match(src, /export function recordBlocklistHit/, "the recorder must be sync-returning (void), not async");
  assert.ok(!/export async function recordBlocklistHit/.test(src),
    "recordBlocklistHit must not be async — an async signature invites `await` at the call site");
  const call = stripComments(read("app/api/chat/send/route.ts"));
  assert.ok(!/await recordBlocklistHit/.test(call), "the send path must not await the review write");
});

// ── Send-path wiring ─────────────────────────────────────────────────────────

test("the send path distinguishes blocked from held", () => {
  // A sender told the wrong one either retries pointlessly or assumes they were
  // censored. 422 = final; 202 = a human will look.
  const src = stripComments(read("app/api/chat/send/route.ts"));
  assert.match(src, /verdict\.action === "block"[\s\S]{0,200}status: 422/, "severity-4 must be a final rejection");
  assert.match(src, /held: true[\s\S]{0,80}status: 202/, "a held message must not read as a rejection");
});

test("blocklist rows are never swept by the Twitch expiry", () => {
  // Twitch drops its own holds after ~5 minutes. Our rows have no such
  // deadline; sweeping them would silently discard exactly the reviews this
  // feature exists to produce.
  const src = stripComments(read("app/api/mod/automod/route.ts"));
  assert.match(src, /status = 'expired'[\s\S]{0,200}source = 'twitch'/,
    "the expiry sweep must be scoped to Twitch-sourced rows");
  // The queue's read lives in automodQueueSql.ts (fair per sender) and the route must use it.
  assert.match(src, /AUTOMOD_QUEUE_SQL/, "the queue route no longer reads the shared queue query");
  assert.match(stripComments(read("app/lib/automodQueueSql.ts")), /status IN \('pending','blocked'\)/,
    "the queue must surface blocked rows too — that is how a mod sees who said it");
});
