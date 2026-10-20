// Source scans over the census wiring.
//
// Run: node --test app/lib/sourceCensusWiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const routePath = join(here, "..", "api", "stream", "status", "route.ts");
const storePath = join(here, "sourceCensusStore.ts");
const pollPath = join(here, "useStreamStatusPoll.ts");
const streamViewPath = join(here, "..", "components", "StreamView.tsx");

test("the status route resolves the live status before the census call, and never awaits the census", () => {
  // Deleting the try/catch-await that used to wrap this call and replacing
  // it with an unawaited fire-and-forget is the actual fix for a hung flush
  // stranding this route's caller (a try/catch around an await cannot save
  // you from a query that never settles) — so this scan pins the shape that
  // matters now: status resolved first, census call present but NOT awaited.
  const src = stripComments(readFileSync(routePath, "utf8"));
  assert.match(src, /const status = await getStreamStatus\(\);[\s\S]{0,200}?recordAndMaybeFlush\(/,
    "the live status must be resolved before the census call runs");
  assert.equal(/await\s+recordAndMaybeFlush\(/.test(src), false,
    "the census call must NOT be awaited — an await lets a hang strand this route's caller");
  assert.match(src, /recordAndMaybeFlush\([^;]*\)\s*\.catch\(/,
    "the census call must be fire-and-forget with its own .catch");
  assert.match(src, /return Response\.json\(status\)/,
    "the status answer must still be returned");
});

test("the empty-census early return happens BEFORE the flush gate, so an empty minute never consumes its stamp", () => {
  // F1, updated for hasFreshEntry: recordSample, then the freshness check,
  // THEN the gate. Reversing the last two would let a quiet arrival still
  // consume the gate's stamp and delay the first real row by up to a full
  // interval. hasFreshEntry replaced a countSources call + all-zero check
  // here specifically so this early return no longer pays for a full walk of
  // the map on every request — see sourceCensus.ts's hasFreshEntry docblock.
  const src = stripComments(readFileSync(storePath, "utf8"));
  assert.match(src, /if \(source && tab\) recordSample\(census, tab, source, now\);[\s\S]{0,300}?if \(!hasFreshEntry\(census, now\)\) return;[\s\S]{0,300}?if \(!flushGate\.beginIfDue\(now\)\) return;/,
    "the freshness check must run and return BEFORE the flush gate is consulted");
});

test("the double-write decision is delegated to the flush gate, which is finished in a finally around the INSERT", () => {
  // The gate's OWN behaviour (serialising two overlapping flushes, and the
  // deliberate stranded-hang trade) is proven by real execution in
  // sourceCensus.test.ts, not here — this only pins that the store actually
  // asks the gate rather than keeping its own loose state, and releases it
  // correctly around the query.
  const src = stripComments(readFileSync(storePath, "utf8"));
  assert.match(src, /if \(!flushGate\.beginIfDue\(now\)\) return;/,
    "the gate, not a local variable, must decide whether this call may flush");
  assert.match(src, /flushGate\.beginIfDue\(now\)[\s\S]{0,300}?await pool\.query/,
    "the gate's decision must be made before the INSERT is awaited");
  assert.match(src, /finally\s*\{\s*flushGate\.finish\(\);\s*\}/,
    "the gate must be released in a finally, so a rejected flush can still flush again later");
});

test("both query parameters are validated before they reach the map", () => {
  const src = stripComments(readFileSync(storePath, "utf8"));
  assert.match(src, /parseCensusSource\(/);
  assert.match(src, /parseTabId\(/);
  assert.match(src, /if \(source && tab\) recordSample\(/,
    "an unvalidated parameter must not become a map key");
});

test("the INSERT's column list and value array line up element-wise, including the deliberate folded <- c.none mapping", () => {
  // Swapping two entries in the value array would attribute every count to
  // the wrong source, permanently and silently, in the exact table used to
  // decide which source to cut — and it would leave every OTHER assertion in
  // this suite green. This parses both lists out of the actual source and
  // checks them position by position, rather than asserting a hardcoded
  // "known good" array that a swap could coincidentally still satisfy.
  const src = stripComments(readFileSync(storePath, "utf8"));
  const colMatch = src.match(/INSERT INTO site\.player_source_snapshots\s*\(([^)]+)\)/);
  const valMatch = src.match(/\[(c\.[a-z]+(?:,\s*c\.[a-z]+)*)\]/);
  if (!colMatch) throw new Error("must find the INSERT's column list in source");
  if (!valMatch) throw new Error("must find the parameterized value array in source");

  const columns = colMatch[1]!.split(",").map((s) => s.trim());
  const values = valMatch[1]!.split(",").map((s) => s.trim());
  assert.equal(columns.length, values.length,
    "the column list and the value array must have the same arity");

  columns.forEach((col, i) => {
    const expected = col === "folded" ? "c.none" : `c.${col}`;
    assert.equal(values[i], expected,
      col === "folded"
        ? "the folded column must be populated from c.none — the deliberate folded<->none vocabulary mapping — not c.folded"
        : `the ${col} column must be populated from c.${col} at the same position, not a value swapped from a neighboring column`);
  });
});

test("the poll sends both parameters", () => {
  const src = stripComments(readFileSync(pollPath, "utf8"));
  assert.match(src, /src=\$\{encodeURIComponent\(sourceRef\.current\)\}/);
  assert.match(src, /tab=\$\{encodeURIComponent\(tabId\(\)\)\}/);
});

test("a poll with no known source fetches the bare status URL, and casts no vote — the ternary's truthy branch is bound to carrying both parameters, not asserted separately from its shape", () => {
  // The rule: the first poll of a page load runs before any effect has
  // written sourceRef, so it has nothing honest to report. It must fetch the
  // bare endpoint rather than vote "none" on a guess — that vote is now
  // load-bearing (sourceCensusStore's own comment says the same thing).
  // F10: folded into ONE regex spanning the whole ternary, so the assertion
  // binds the truthy branch to its actual contents (both src= and tab=)
  // rather than checking the branch's shape and the parameters' presence as
  // two independent facts that could each pass while the other is wrong.
  const src = stripComments(readFileSync(pollPath, "utf8"));
  assert.match(
    src,
    /sourceRef\.current\s*\?\s*`\/api\/stream\/status\?src=\$\{encodeURIComponent\(sourceRef\.current\)\}&tab=\$\{encodeURIComponent\(tabId\(\)\)\}`\s*:\s*"\/api\/stream\/status"/,
    "an empty sourceRef must fetch the bare URL; a non-empty one must fetch a URL carrying both src and tab in the ternary's own truthy branch",
  );
});

test("StreamView writes sourceRef from folded/currentSource in an effect, and passes that same ref into useStreamStatusPoll", () => {
  // Deleting the one-line effect that writes sourceRef makes every poll take
  // the bare-URL branch above — the whole feature produces zero data for the
  // rest of its life, with every other test in this repo still green and no
  // symptom anywhere, because nothing before this test ever opened
  // StreamView.tsx.
  const src = stripComments(readFileSync(streamViewPath, "utf8"));
  assert.match(
    src,
    /useEffect\(\(\) => \{\s*sourceRef\.current = folded \? "none" : \(currentSource \?\? "none"\);\s*\}, \[folded, currentSource\]\);/,
    "the effect must set sourceRef.current from folded and currentSource, with both listed as deps",
  );
  assert.match(
    src,
    /useStreamStatusPoll\([^)]*sourceRef, offlineTab\)/,
    "sourceRef must be passed into useStreamStatusPoll — the poll hook has no other way to see what this tab is watching",
  );
});

test("VACUITY ANCHOR: the scanned files were read to the END", () => {
  for (const [label, p] of [
    ["route", routePath], ["store", storePath], ["poll", pollPath], ["streamView", streamViewPath],
  ] as const) {
    const raw = readFileSync(p, "utf8");
    assert.match(raw.trimEnd().slice(-40), /[}\);]\s*$/, `${label} was read truncated`);
  }
});
