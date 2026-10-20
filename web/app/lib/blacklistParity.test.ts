// PARITY GUARD: web/app/lib/blacklist.ts  ⇄  stream-api/blacklist.js
//
// These two files are hand-synced copies of one filter living in two runtimes
// (Next.js vs the Node stream-api) that cannot share an import. Until now the
// only thing keeping them equal was a comment in each saying "keep in sync",
// which is not a mechanism — a fix applied to one copy would silently leave the
// other exploitable, and the failure is invisible until a slur gets through.
//
// This test imports BOTH and fails on any divergence: the term list, the
// generated regex, or the matching behaviour.
//
// The asymmetry it does NOT check, because it is intentional: a hit makes the
// web app refuse a NATIVE send (the sender is told), while stream-api declines
// to relay a PLATFORM message (nobody to tell — it is already public over
// there). Same detection and the same verdict; different response, because the
// two sides have different things they can still prevent.
//
// Run: node --test app/lib/blacklistParity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BLACKLIST as WEB_LIST, BLOCKLIST as WEB_ENTRIES, termRegex as webTermRegex, classify as webClassify } from "./blacklist.ts";

const require = createRequire(import.meta.url);
const api = require("../../../stream-api/blacklist.js") as {
  BLACKLIST: string[];
  BLOCKLIST: { term: string; severity: number; tags?: string[] }[];
  classify: (text: string) => { action: string; severity?: number };
  maskBlacklist: (text: string) => string;
  termRegex: (term: string, flags: string) => RegExp | null;
};

// Terms chosen to exercise the matcher's real edge cases rather than happy paths:
// separator chars that appear in the separator CLASS itself are the ReDoS trigger
// the "reduce to letters first" step exists to defuse.
const TERMS = [
  "slur",
  "badword",
  "a",
  "sl.ur",      // term contains a separator-class char
  "sl*ur",      // ditto, the asterisk case
  "sl-ur",
  "sl_ur",
  "MiXeDcAsE",
  "with space",
  "123",        // no letters at all -> both must return null
  "",           // empty -> both must return null
  "ünïcöde",    // non-ASCII letters are stripped by /[^a-z]/gi in both
];

const CORPUS = [
  "clean message",
  "you slur here",
  "you SLUR here",
  "s.l u*r",
  "s-l-u-r",
  "s_l_u_r",
  "sssslurrr",
  "slurred",             // substring inside a longer word must NOT match
  "unslur",              // ditto, prefix side
  "Scunthorpe",          // the classic false positive
  "slur.",
  "(slur)",
  "…slur…",
  "slur\nslur",
  "a".repeat(200),
  "badword",
  "b a d w o r d",
  "b.a.d.w.o.r.d",
];

test("term lists are identical (order and contents)", () => {
  assert.deepEqual(
    WEB_LIST,
    api.BLACKLIST,
    "web/app/lib/blacklist.ts BLACKLIST diverged from stream-api/blacklist.js — " +
      "populate BOTH copies; native sends and platform ingest must filter the same words"
  );
});

test("termRegex produces an identical pattern for every term", () => {
  for (const term of TERMS) {
    const web = webTermRegex(term, "gi");
    const svc = api.termRegex(term, "gi");

    if (web === null || svc === null) {
      assert.equal(
        web === null,
        svc === null,
        `termRegex("${term}") null-disagreement: web=${web} stream-api=${svc} — ` +
          "one copy treats this term as unmatchable and the other does not"
      );
      continue;
    }
    assert.equal(
      web.source,
      svc.source,
      `termRegex("${term}") pattern diverged — the two matchers are no longer the same filter`
    );
    assert.equal(web.flags, svc.flags, `termRegex("${term}") flags diverged`);
  }
});

test("both matchers agree on every corpus string, for every term", () => {
  for (const term of TERMS) {
    const web = webTermRegex(term, "i");
    const svc = api.termRegex(term, "i");
    if (web === null || svc === null) continue;

    for (const text of CORPUS) {
      // Fresh lastIndex semantics: "i" (not "gi") so .test() is stateless here.
      assert.equal(
        web.test(text),
        svc.test(text),
        `disagreement on term="${term}" text=${JSON.stringify(text)} — ` +
          "the same message would be filtered in one runtime and allowed in the other"
      );
    }
  }
});

test("word boundaries hold: no substring matches inside longer words", () => {
  const re = webTermRegex("slur", "i");
  assert.ok(re);
  assert.equal(re!.test("slurred"), false, "suffix substring must not match");
  assert.equal(re!.test("unslur"), false, "prefix substring must not match");
  assert.equal(re!.test("Scunthorpe"), false, "the classic false positive must not match");
  assert.equal(re!.test("you slur here"), true, "a real whole-word hit must still match");
});

test("a term with no letters yields null in BOTH copies (not a match-everything regex)", () => {
  for (const term of ["", "123", "...", "***"]) {
    assert.equal(webTermRegex(term, "gi"), null, `web termRegex("${term}") should be null`);
    assert.equal(api.termRegex(term, "gi"), null, `stream-api termRegex("${term}") should be null`);
  }
});

test("ReDoS guard: a long punctuation run cannot blow up either matcher", () => {
  // The separator class is [\s._*\-]. Before the "reduce to letters first" fix, a
  // term containing one of those chars let the class overlap the literal and
  // backtrack catastrophically. 5k separators finishes instantly when linear.
  const evil = ".".repeat(5000) + "x";
  for (const term of ["sl.ur", "sl*ur", "sl-ur", "sl_ur"]) {
    for (const [name, fn] of [["web", webTermRegex], ["stream-api", api.termRegex]] as const) {
      const re = fn(term, "i");
      assert.ok(re, `${name} termRegex("${term}") unexpectedly null`);
      const started = process.hrtime.bigint();
      re!.test(evil);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 500, `${name} termRegex("${term}") took ${ms.toFixed(1)}ms — ReDoS guard regressed`);
    }
  }
});

test("chat ingest withholds; masking survives ONLY for alerts", () => {
  // No mask in CHAT, where a starred-out slur is the worst of both worlds
  // (everyone still reads it, no moderator is told).
  //
  // maskBlacklist deliberately still exists for the ALERT path. Alert text is
  // read aloud by TTS and painted on the OBS overlay, and alert.js degrades to
  // identity when the dep is missing — so deleting the export would not fail
  // loudly, it would quietly start reading slurs out on stream.
  assert.equal(typeof api.maskBlacklist, "function",
    "maskBlacklist is still required by the alert path (TTS/OBS)");
  const chat = readFileSync(join(process.cwd(), "..", "stream-api", "chat.js"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  // END-of-file anchor, and it is not redundant with the `classify(message)`
  // check below. That one sits about a third of the way into chat.js, so it
  // proves only that the first third was read — while the `maskBlacklist`
  // assertion above it is NEGATIVE and ranges over the whole file. Truncation
  // anywhere past the classify call would leave "chat ingest must withhold"
  // passing over text nothing had looked at. Anchoring on the export proves
  // the read reached the end.
  assert.ok(/module\.exports = \{ createChat \}/.test(chat),
    "the chat.js scan lost the END of the file — the withhold assertion is now vacuous");
  assert.ok(!/maskBlacklist\s*\(/.test(chat), "chat ingest must withhold, not mask");
  assert.ok(/classify\s*\(message\)/.test(chat), "chat ingest must classify");
});

test("both runtimes reach the SAME verdict for the same message", () => {
  // The property that matters: severity decides whether a message is blocked,
  // held, or allowed. If the two copies disagreed, the same word could be
  // blocked on the site and relayed into chat from a platform — the exact
  // silent asymmetry this file exists to prevent.
  const samples = [
    "hello chat",
    "",
    ...WEB_ENTRIES.slice(0, 40).flatMap((e) => [e.term, e.term.split("").join("."), `x ${e.term} y`]),
  ];
  for (const s of samples) {
    const a = webClassify(s);
    const b = api.classify(s);
    assert.equal(a.action, b.action, `verdict differs for ${JSON.stringify(s.slice(0, 24))}`);
    if (a.action !== "allow" && b.action !== "allow") {
      assert.equal(a.severity, b.severity, "severity differs");
    }
  }
});

// ── Severity structure must match too (v84) ─────────────────────────────────

test("the severity-bearing entry lists are identical in both runtimes", () => {
  // Severity now decides the OUTCOME (4 block / 2-3 hold / 1 allow), so a
  // divergence is not cosmetic: the same word could be blocked on the site and
  // merely masked on platform ingest, or vice versa. That is precisely the
  // silent asymmetry this file exists to prevent, one level deeper than the
  // term list it already guarded.
  const norm = (e: { term: string; severity: number; tags?: string[] }) =>
    `${e.term}|${e.severity}|${(e.tags ?? []).slice().sort().join(",")}`;
  assert.deepEqual(
    WEB_ENTRIES.map(norm).sort(),
    api.BLOCKLIST.map(norm).sort(),
    "web/app/lib/blacklist.ts and stream-api/blacklist.js disagree on terms, severities or tags"
  );
});

test("the flat term list is derived from the entries, not maintained separately", () => {
  // Two hand-maintained lists in ONE file is the same drift risk as two files.
  assert.deepEqual(WEB_LIST.slice().sort(), WEB_ENTRIES.map((e) => e.term).sort());
  assert.deepEqual(api.BLACKLIST.slice().sort(), api.BLOCKLIST.map((e) => e.term).sort());
});
