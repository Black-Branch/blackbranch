// Runtime blocklist overrides — the mod-curated layer over the shipped list.
//
// The case it exists for: a word shipped at block severity is said mid-stream,
// the message is destroyed, and a mod needs to correct the grading on the
// spot. The Allow button is correctly absent (a blocked row has no message
// waiting to publish, and an Allow that publishes a slur is one mis-click from
// the worst outcome) — the thing to fix is the GRADING, and the shipped
// grading lives in code.
//
// Run: node --test app/lib/blocklistOverrides.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import {
  applyOverrides, normalizeTerm, compileTerms, classifyWith, actionFor,
  matchesBlacklist, setOverrides as webSetOverrides,
  BLOCKLIST, type BlockTerm, type Override,
} from "./blacklist.ts";

// The migration history (migrations/schema.sql + migrate-vN.sql) is the private repo's; a public
// tree starts from migrations/baseline/. A test of what one migration wrote runs where the history is.
const CHAIN = existsSync(new URL("../../../migrations/schema.sql", import.meta.url));
const HISTORY = CHAIN ? false : "reads the migration history, which this tree does not carry";

const require = createRequire(import.meta.url);
const api = require("../../../stream-api/blacklist.js") as {
  applyOverrides: (shipped: BlockTerm[], o: Override[]) => BlockTerm[];
  normalizeTerm: (t: string) => string;
  compileTerms: (e: BlockTerm[]) => unknown[];
  classifyWith: (p: unknown[], t: string) => { action: string; severity?: number };
  setOverrides: (o: Override[]) => void;
  classify: (t: string) => { action: string };
  maskBlacklist: (t: string) => string;
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** A fixture list, so these tests do not depend on what the shipped list says. */
const SHIPPED: BlockTerm[] = [
  { term: "severe", severity: 4, tags: ["racial"] },
  { term: "middling", severity: 3, tags: ["lgbtq"] },
  { term: "reclaimed", severity: 4, tags: ["lgbtq"] },
];

const verdict = (entries: BlockTerm[], text: string) =>
  classifyWith(compileTerms(entries), text);

// ── The core: an override is a re-grade ──────────────────────────────────────

test("an override replaces a shipped severity", () => {
  assert.equal(verdict(SHIPPED, "reclaimed").action, "block", "precondition");
  const after = applyOverrides(SHIPPED, [{ term: "reclaimed", severity: 1 }]);
  assert.equal(verdict(after, "reclaimed").action, "allow", "the whitelist did not take");
  // …and only that one. A re-grade must not disturb its neighbours.
  assert.equal(verdict(after, "severe").action, "block");
  assert.equal(verdict(after, "middling").action, "hold");
});

test("an override adds a term the shipped list has never heard of", () => {
  assert.equal(verdict(SHIPPED, "goy").action, "allow", "precondition: unlisted");
  const after = applyOverrides(SHIPPED, [{ term: "goy", severity: 3 }]);
  assert.equal(verdict(after, "goy").action, "hold");
  assert.equal(after.length, SHIPPED.length + 1);
});

test("clearing an override restores the shipped grading", () => {
  // Modelled as "apply, then apply without it" — which is what the refresher
  // does: it installs a whole set, it never patches one entry.
  const on = applyOverrides(SHIPPED, [{ term: "reclaimed", severity: 1 }]);
  assert.equal(verdict(on, "reclaimed").action, "allow");
  const off = applyOverrides(SHIPPED, []);
  assert.equal(verdict(off, "reclaimed").action, "block",
    "clearing must put the shipped severity back, not leave the term allowed");
});

test("a re-grade keeps the entry's tags", () => {
  // The tag says what KIND of term it is, which re-grading does not change — and
  // the review row uses it to say WHY something was held.
  const after = applyOverrides(SHIPPED, [{ term: "reclaimed", severity: 3 }]);
  const entry = after.find((e) => e.term === "reclaimed")!;
  assert.deepEqual(entry.tags, ["lgbtq"], "the tag was dropped by the re-grade");
});

test("worst-match-wins still holds across the override layer", () => {
  // The one that would matter in practice: whitelisting a reclaimed word must
  // not become a way to smuggle a slur past the filter by putting both in one
  // message.
  const after = applyOverrides(SHIPPED, [{ term: "reclaimed", severity: 1 }]);
  const v = verdict(after, "reclaimed and severe together");
  assert.equal(v.action, "block", "the severe term must still decide the outcome");
});

// ── Term keying ──────────────────────────────────────────────────────────────

test("terms are keyed by letters, so a re-grade cannot silently become an ADD", () => {
  // The subtle one. The matcher reduces terms to letters, so "Reclaimed" and
  // "re.claimed" are the same word — but as raw strings they are different keys.
  // Without normalisation, `/whitelist word Reclaimed` would append a second
  // entry at severity 1 while the shipped severity-4 entry kept on blocking, and
  // the mod would watch their own fix do nothing.
  for (const spelling of ["Reclaimed", "RECLAIMED", "re.claimed", "r-e-c-l-a-i-m-e-d"]) {
    const after = applyOverrides(SHIPPED, [{ term: spelling, severity: 1 }]);
    assert.equal(after.length, SHIPPED.length, `"${spelling}" added an entry instead of re-grading`);
    assert.equal(verdict(after, "reclaimed").action, "allow", `"${spelling}" did not take effect`);
  }
});

test("a term with no letters is ignored rather than creating a junk entry", () => {
  const after = applyOverrides(SHIPPED, [{ term: "!!!", severity: 1 }]);
  assert.equal(after.length, SHIPPED.length);
});

// ── Parity: both runtimes resolve identically ────────────────────────────────

test("both runtimes apply overrides in the SAME resolution order", () => {
  // The spec's requirement. blacklistParity.test.ts pins the two shipped LISTS;
  // this pins the layer on top of them, which is a different way to diverge.
  const cases: Override[][] = [
    [],
    [{ term: "reclaimed", severity: 1 }],
    [{ term: "goy", severity: 3 }],
    [{ term: "Reclaimed", severity: 2 }],
    [{ term: "reclaimed", severity: 1 }, { term: "severe", severity: 3 }],
  ];
  for (const overrides of cases) {
    const web = applyOverrides(SHIPPED, overrides);
    const node = api.applyOverrides(SHIPPED, overrides);
    assert.deepEqual(
      node.map((e) => [e.term, e.severity]).sort(),
      web.map((e) => [e.term, e.severity]).sort(),
      `the two runtimes disagree for ${JSON.stringify(overrides)}`
    );
    for (const text of ["reclaimed", "severe", "goy", "reclaimed and severe"]) {
      assert.equal(
        api.classifyWith(api.compileTerms(node), text).action,
        classifyWith(compileTerms(web), text).action,
        `verdicts diverge for "${text}" under ${JSON.stringify(overrides)}`
      );
    }
  }
});

test("normalizeTerm agrees across runtimes", () => {
  for (const t of ["Twink", "tw.ink", "T-W-I-N-K", "goy", "!!!", "Ünï"]) {
    assert.equal(api.normalizeTerm(t), normalizeTerm(t), `normalisation differs for "${t}"`);
  }
});

// ── The failure mode that matters most ───────────────────────────────────────

test("a failed load NEVER opens the filter", () => {
  // The one that matters most, so it is asserted at the
  // source: the catch path must not install an empty override set. `[]` is a
  // REAL answer meaning "no overrides exist" — using it for "the read failed"
  // would let one DB blip silently revert every mod re-grade to the shipped
  // grading, and (worse, in the other direction) is the shape of the bug where a
  // filter fails open.
  const src = readFileSync(join(HERE, "blocklistOverrides.ts"), "utf8");
  const code = stripComments(src);

  const catchIdx = code.indexOf("} catch");
  assert.ok(catchIdx !== -1, "the loader no longer handles a failed read at all");
  const tail = code.slice(catchIdx);
  assert.doesNotMatch(tail, /setOverrides/,
    "the catch path installs an override set — a failed read must change nothing");

  // And the success path must still install one, or the whole module is inert.
  const head = code.slice(0, catchIdx);
  assert.match(head, /setOverrides\(overrides\)/, "the success path no longer installs anything");
});

test("with no overrides loaded, the SHIPPED list is what runs", () => {
  // The boot state, and the state after a read that has never succeeded. It must
  // be the strict end: a slur filter that fails open is the only genuinely bad
  // outcome here.
  const shippedSevere = BLOCKLIST.find((e) => e.severity >= 4);
  assert.ok(shippedSevere, "the shipped list has no block-level term to test with");
  assert.equal(actionFor(shippedSevere.severity), "block");

  // stream-api's module-level default, driven for real.
  api.setOverrides([]);
  assert.equal(api.classify(shippedSevere.term).action, "block",
    "with no overrides the shipped grading must still block");
});

test("setOverrides([]) means 'no overrides', not 'no filter'", () => {
  api.setOverrides([{ term: "reclaimed", severity: 1 }]);
  api.setOverrides([]);
  const shippedSevere = BLOCKLIST.find((e) => e.severity >= 4)!;
  assert.equal(api.classify(shippedSevere.term).action, "block");
});

// ── The override layer reaches EVERY judgement surface ───────────────────────

test("overrides reach matchesBlacklist — paid TTS obeys mod re-grades", () => {
  // matchesBlacklist must not compile its own pattern set from the SHIPPED
  // list at module load: a mod's `/blacklist word X` would hold chat within a
  // minute while the no-hold-state routes still accepted X.
  try {
    assert.equal(matchesBlacklist("grifterino"), false, "precondition: unlisted");
    webSetOverrides([{ term: "grifterino", severity: 3 }]);
    assert.equal(matchesBlacklist("grifterino"), true,
      "a mod-held term is still purchasable for TTS");
    // …and the other direction: a whitelisted shipped term becomes speakable.
    const shipped = BLOCKLIST.find((e) => e.severity >= 4)!;
    webSetOverrides([{ term: shipped.term, severity: 1 }]);
    assert.equal(matchesBlacklist(shipped.term), false,
      "a whitelisted term is still refused for TTS — no mod can fix that from chat");
  } finally {
    webSetOverrides([]);
  }
});

test("overrides reach the alert mask — TTS/OBS star the ACTIVE list", () => {
  // Same gap, stream-api side: maskBlacklist compiled once from the shipped
  // terms, so a mod-added term was withheld from chat but read aloud by TTS
  // and painted on the OBS overlay via the alert path.
  try {
    api.setOverrides([{ term: "grifterino", severity: 3 }]);
    assert.equal(api.maskBlacklist("big grifterino energy"), "big ********** energy",
      "a mod-held term still reaches TTS/OBS unmasked");
    const shipped = BLOCKLIST.find((e) => e.severity >= 4)!;
    assert.match(api.maskBlacklist(shipped.term), /^\*+$/, "shipped terms must stay masked");
    api.setOverrides([{ term: shipped.term, severity: 1 }]);
    assert.equal(api.maskBlacklist(shipped.term), shipped.term,
      "a whitelisted term stays asterisked in alerts forever");
  } finally {
    api.setOverrides([]);
  }
});

// ── Severity 4 cannot be reached from chat ───────────────────────────────────

test("the API refuses severity 4, and says why", () => {
  const route = readFileSync(join(HERE, "../api/mod/blocklist/route.ts"), "utf8");
  assert.match(route, /MAX_RUNTIME_SEVERITY = 3/,
    "the runtime ceiling is gone — /blacklist could start destroying messages");
  assert.match(route, /severity > MAX_RUNTIME_SEVERITY/,
    "nothing enforces the ceiling on the write path");
  // A refusal the user cannot understand is a bug report, so pin that it explains.
  assert.match(route, /DESTROYED/, "the refusal does not explain what severity 4 does");
});

test("the DB constraint backs the handler check, not the other way round", { skip: HISTORY }, () => {
  // The handler check exists for the error MESSAGE. The guarantee is the
  // CHECK, because a future caller that forgets the rule cannot route around a
  // constraint — and this is the one rule where "someone forgot" means messages
  // start being destroyed silently.
  const raw = readFileSync(join(HERE, "../../../migrations/migrate-v87.sql"), "utf8");
  // STRIP `--` COMMENTS FIRST. The comment above the table explains the rule
  // and quotes it verbatim, so without stripping, the regex would match the
  // prose and pass against a migration with the constraint DELETED (the same
  // guard is in sendDestination.test and composerLayout.test). A test that
  // reads comments is testing the explanation, not the behaviour.
  const sql = raw.split("\n").map((l) => {
    const i = l.indexOf("--");
    return i === -1 ? l : l.slice(0, i);
  }).join("\n");

  assert.match(sql, /CHECK\s*\(\s*severity\s+BETWEEN\s+1\s+AND\s+3\s*\)/i,
    "the severity ceiling is not enforced by the database");
  // Belt and braces: the column must not merely mention a check somewhere else
  // in the file — it has to be on THIS column.
  assert.match(sql, /severity\s+smallint\s+NOT NULL\s+CHECK/i,
    "the CHECK is not attached to the severity column");
});
