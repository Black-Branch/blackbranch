// Every outbound fetch on the player's upstream paths — the YouTube liveness
// scrape, the avatar lookup, the VOD list, the mod tooling's channel resolve —
// carries a deadline, and a failed scrape is remembered for a short while.
//
// Why a source scan: these functions import the pg pool and call the network,
// so the harness cannot execute them. What it CAN do is refuse a fetch with no
// `signal`. The status loader is single-flight and sits under
// /api/stream/status, /api/chat/send and the coin heartbeat: one hung scrape
// would stall all of them.
//
// Run: node --test app/lib/playerUpstream.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const STATUS = "app/lib/streamStatus.ts";
const VODS = "app/lib/vods.ts";
const EMBED_ROUTE = "app/api/mod/embed/route.ts";
const MANAGER = "app/components/CommunityEmbedManager.tsx";
const CMD_SPEC = "app/lib/commands/spec.ts";
const CMD_RUN = "app/lib/commands/run.ts";

/** Read a source file, proving first that the read reached its end. */
function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail,
    `${rel} did not end as expected — the read is truncated, and every assertion below it is vacuous`);
  return stripComments(src);
}

/** The text of every `<name>(` call in `src`, from the call to its `);`. */
function calls(src: string, name: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
    const end = src.indexOf(");", m.index);
    out.push(src.slice(m.index, end === -1 ? undefined : end));
  }
  return out;
}

test("streamStatus.ts: the live scrape and the avatar lookup carry a deadline", () => {
  const src = read(STATUS, /statusCache\.get\(\);\s*$/);
  const found = calls(src, "fetch");
  assert.equal(found.length, 2, `expected the scrape + the avatar lookup, found ${found.length}`);
  for (const c of found) {
    assert.match(c, /signal: AbortSignal\.timeout\(YT_FETCH_TIMEOUT_MS\)/, `unbounded fetch: ${c.slice(0, 80)}…`);
  }
  assert.match(src, /YT_FETCH_TIMEOUT_MS = 7_000/);
});

test("streamStatus.ts: a failed scrape is remembered briefly, a good one for the full TTL", () => {
  const src = read(STATUS, /statusCache\.get\(\);\s*$/);
  assert.match(src, /YT_FAIL_CACHE_MS = 45 \* 1000/);
  assert.match(src, /ttlMs: YT_FAIL_CACHE_MS/, "the failure entry must carry its own, shorter TTL");
  assert.match(src, /ttlMs: YT_CACHE_MS/, "the good entry keeps the 5-minute TTL");
  assert.match(src, /Date\.now\(\) - cached\.ts < cached\.ttlMs/, "one lookup, per-entry TTL");
  assert.match(src, /AVATAR_FAIL_CACHE_MS = 5 \* 60 \* 1000/);
  assert.match(src, /ttlMs: AVATAR_FAIL_CACHE_MS/, "a failed avatar lookup must not be remembered for 24h");
});

test("streamStatus.ts: the rotation is scanned in parallel, priority still decides", () => {
  const src = read(STATUS, /statusCache\.get\(\);\s*$/);
  assert.match(src, /await Promise\.all\(rows\.map\(\(row\) => checkYouTubeLive\(row\.youtube_channel_id\)\)\)/);
});

test("vods.ts: all three fetches carry a deadline", () => {
  const src = read(VODS, /return cache\.vods;\s*}\s*$/);
  const found = calls(src, "fetch");
  assert.equal(found.length, 3, `expected playlistItems + videos + the playlist scrape, found ${found.length}`);
  for (const c of found) {
    assert.match(c, /signal: AbortSignal\.timeout\(VOD_FETCH_TIMEOUT_MS\)/, `unbounded fetch: ${c.slice(0, 80)}…`);
  }
  assert.match(src, /VOD_FETCH_TIMEOUT_MS = 8_000/);
});

test("mod/embed route: the channel resolve carries a deadline", () => {
  const src = read(EMBED_ROUTE, /return Response\.json\(rows\[0\]\);\s*}\s*$/);
  const found = calls(src, "safeFetch");
  assert.equal(found.length, 1);
  assert.match(found[0]!, /signal: AbortSignal\.timeout\(RESOLVE_TIMEOUT_MS\)/);
  assert.match(src, /RESOLVE_TIMEOUT_MS = 6_000/);
});

// ─── the mod tooling ─────────────────────────────────────────────────────────

test("mod/embed route: DELETE cannot target a rotation position", () => {
  // `priority` is rewritten 1..N by every reorder, so a `/embed remove #N`
  // shorthand printed by /embed list would delete the wrong streamer after a
  // reorder between the two. There is no shorthand.
  const src = read(EMBED_ROUTE, /return Response\.json\(rows\[0\]\);\s*}\s*$/);
  assert.doesNotMatch(src, /WHERE priority = \$1/);
  assert.doesNotMatch(src, /#priority/);
  assert.match(src, /Usage: \/embed remove <name \| UC…>/);
  assert.match(src, /ROW_COLUMNS/, "GET and the reorder PATCH return the same row shape");
});

test("the /embed command surfaces agree, and add cannot hang", () => {
  const spec = read(CMD_SPEC, /return `\/\$\{path\.join\(" "\)\}\$\{args \? " " \+ args : ""\}`;\s*}\s*$/);
  assert.match(spec, /name: "name \| UC…"/);
  assert.doesNotMatch(spec, /#priority/);
  const run = read(CMD_RUN, /return \{ runCommand \};\s*}\s*$/);
  assert.match(run, /postJson\("\/api\/mod\/embed", args, "POST", \{ timeoutMs: 8_000 \}\)/);
});

test("the manager's add cannot hang, reorders show the server's order, and the dead prop is gone", () => {
  const m = read(MANAGER, /<\/button>\s*\);\s*}\s*$/);
  assert.match(m, /postJsonOrThrow\("\/api\/mod\/embed", \{[\s\S]*?\}, "POST", \{ timeoutMs: 8_000 \}\)/);
  assert.match(m, /if \(d\?\.reordered\) setEmbeds\(d\.reordered\);/);
  assert.match(m, /if \(d\?\.videos\) setLoop\(d\.videos\);/);
  assert.doesNotMatch(m, /strong\?: boolean/, "Toggle's `strong` prop was never passed");
});
