// The mod log records merges, report resolutions and held-message releases (KG-19).
//   • the exact row each action appends (modlogActions.ts);
//   • a scan of each route: the row is appended only after the action took effect — a report only
//     when this click closed it (a second click, a retry, moves nothing and logs nothing), a held line
//     only once it is posted, a merge only after stream-api answered.
// Run: node --test app/lib/modlogActions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { identityMergedEntry, reportResolvedEntry, heldReleasedEntry } from "./modlogActions.ts";
import { stripComments } from "./testSource.ts";

const { at } = createRequire(import.meta.url)("../../../stream-api/testlib/source.js") as { at: (hay: string, needle: string) => number };

test("merge, resolve, release each append their action — an exact row each", () => {
  assert.deepEqual(identityMergedEntry({ mod: "@m:site.test", survivor: "aaaaaaaaaaaa", victim: { userId: "bbbbbbbbbbbb", name: "casey" } }),
    { action: "identity_merged", target: "aaaaaaaaaaaa", by: "@m:site.test", reason: "merged in casey (bbbbbbbbbbbb)" });
  assert.deepEqual(identityMergedEntry({ mod: "@m:site.test", survivor: "aaaaaaaaaaaa", victim: { userId: "bbbbbbbbbbbb", name: null } }),
    { action: "identity_merged", target: "aaaaaaaaaaaa", by: "@m:site.test", reason: "merged in bbbbbbbbbbbb" });
  assert.deepEqual(reportResolvedEntry({ mod: "@m:site.test", subject: "@u:site.test", reportId: 7 }),
    { action: "report_resolved", target: "@u:site.test", by: "@m:site.test", reason: "report #7" });
  assert.deepEqual(heldReleasedEntry({ mod: "@m:site.test", sender: "@u:site.test", source: "link_gate", rowId: 12 }),
    { action: "held_released", target: "@u:site.test", by: "@m:site.test", reason: "held by link_gate · #12" });
});

const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), "utf8"));

test("report resolved: logged after the closing UPDATE, only when it closed a row (retry logs nothing)", () => {
  const src = read("app/api/mod/support/route.ts");
  const post = src.slice(at(src, "export async function POST"));
  const update = at(post, "UPDATE site.reports SET status = 'resolved'");
  const log = at(post, "appendModLog(reportResolvedEntry(");
  assert.ok(update < log);
  assert.match(post.slice(update, log), /RETURNING id[\s\S]*if \(closed\.length > 0 && subject\)/, "a second click moves nothing and logs nothing");
  assert.match(src, /return Response\.json\(\{ ok: true \}\);\s*\}\s*$/, "vacuity anchor: the scan read to the end");
});

test("identity merged: logged after stream-api answered the merge", () => {
  const src = read("app/api/mod/identity/link/route.ts");
  const post = src.slice(at(src, "export async function POST"));
  const failed = at(post, "if (!res.ok)");
  assert.ok(at(post, `streamApiFetch("/identity/merge"`) < failed && failed < at(post, "appendModLog(identityMergedEntry("));
  assert.match(src, /merged: d\.merged \?\? 1 \}\);\s*\}\s*$/, "vacuity anchor: the scan read to the end");
});

test("held released: logged once the line is posted, on both release paths", () => {
  const src = read("app/api/mod/automod/resolve/route.ts");
  const own = src.slice(at(src, "if (RELEASABLE.includes(row.source)"), at(src, "const cap = await getBroadcasterToken"));
  assert.ok(at(own, "if (!released?.ok)") < at(own, "appendModLog(heldReleasedEntry("), "our own rows: after the post succeeded");
  const twitch = src.slice(at(src, "const cap = await getBroadcasterToken"));
  const rejected = at(twitch, "if (status < 200 || status >= 300)");
  const log = at(twitch, `if (action === "allow") await appendModLog(heldReleasedEntry(`);
  assert.ok(rejected < log, "Twitch: only after Twitch accepted our Allow");
  assert.match(src, /return Response\.json\(\{ error: why \}, \{ status: 409 \}\);\s*\}\s*$/, "vacuity anchor: the scan read to the end");
});
