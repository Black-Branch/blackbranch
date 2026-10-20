// Source scan: homeCache imports pool through @/lib/db, so it cannot load in
// node; the wiring of the loaders through the shared readers is what this pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const src = stripComments(readFileSync(join(import.meta.dirname, "homeCache.ts"), "utf8"));

test("ONE 60s single-flight cache over buildHomePayload, read by getHomePayload", () => {
  assert.match(src, /createTtlCache<HomePayload>\(\{ ttlMs: 60_000,/);
  assert.match(src, /buildHomePayload\(\{/);
  assert.match(src, /export function getHomePayload\(\): Promise<HomePayload> \{\s*return cache\.get\(\);\s*\}/);
});

test("every widget's loader is wired through the shared readers, never a second copy", () => {
  assert.match(src, /status: \(\) => getStreamStatus\(\)\.then\(\(s\) => \{\s*if \(!streamStatusFresh\(\)\) throw new Error\("status not fresh"\);\s*return statusFromStream\(s\);\s*\}\)/);
  assert.match(src, /cacheable: data\.status !== null && boardsWarm\(data\.boards\)/, "a body built while the boards are still warming is served but not remembered");
  assert.match(src, /lastStream: \(\) => getLastStream\(pool\)/);
  assert.match(src, /news: \(\) => \{ kickRefresh\(\); return listItems\(\{ limit: 4 \}\)\.then\(\(items\) => newsFromRss\(items, 4\)\); \}/);
  assert.match(src, /vods: \(\) => getVods\(\)\.then\(\(v\) => v\.slice\(0, 3\)\)/);
  assert.match(src, /threads: \(\) => forumReader\.rooms\(\)/);
  assert.match(src, /, 4\)\),\s*\}\);/, "threads capped at 4");
});

test("the Leaderboard's part comes from boards.ts's own caches, awaited only inside its settled loader", () => {
  assert.match(src, /import \{ getBoards \} from "@\/app\/lib\/boards"/);
  assert.match(src, /boards: \(\) => getBoards\(\),/);
  assert.equal((src.match(/getBoards\(\)/g) ?? []).length, 1, "one call, inside the loader");
});

test("the page's copy races a timer and never rejects", () => {
  assert.match(src, /Promise\.race\(\[\s*getHomePayload\(\)\.catch\(\(\) => null\),\s*new Promise<null>/);
});

test("the money board never rides this body", () => {
  assert.doesNotMatch(src, /bot\/top/);
  assert.doesNotMatch(src, /support/);
  assert.match(src, /\}\s*$/); // END anchor
});
