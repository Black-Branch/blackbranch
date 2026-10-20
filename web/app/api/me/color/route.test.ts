// /api/me/color's server limit. Source scan — the route imports pool through the @/lib/db alias, which node
// --test cannot resolve.
// The page's own saver (app/lib/ownColor.ts) sends at most one change every 5 s per tab; the server holds
// every caller to 60 a minute per account, so a script hammering the URL gets 429s and a person never does.
//
// Run: node --test app/api/me/color/route.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";

const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));
const block = (verb: string) => src.slice(src.indexOf(`export async function ${verb}(`), src.indexOf("\n}\n", src.indexOf(`export async function ${verb}(`)));

test("a change is limited per ACCOUNT: one sliding window of 60 a minute shared by PATCH and DELETE", () => {
  assert.match(src, /import \{ createSlidingWindowLimiter \} from "@\/app\/lib\/rateLimit";/, "the shared limiter, not a copy");
  assert.match(src, /const isRateLimited = createSlidingWindowLimiter\(60_000, 60\);/);
  assert.equal(src.match(/createSlidingWindowLimiter\(/g)?.length, 1, "one window for both verbs");
});

test("each write checks it after the sign-in guard and before the body is read or the row written; over it is a 429", () => {
  for (const verb of ["PATCH", "DELETE"]) {
    const b = block(verb);
    const gate = b.indexOf("await requireUser()");
    const limit = b.indexOf('if (isRateLimited(matrixId)) return new Response("Too Many Requests", { status: 429 });');
    assert.ok(gate !== -1 && limit > gate, `${verb}: keyed on the account the guard found, never an IP`);
    assert.ok(limit < b.indexOf("pool.query"), `${verb}: a throttled call writes nothing`);
    if (verb === "PATCH") assert.ok(limit < b.indexOf("req.json()"), "PATCH: a throttled call reads nothing");
  }
  assert.doesNotMatch(block("GET"), /isRateLimited/, "reading your colour is not limited");
  assert.match(src.slice(-200), /writeMatrixColor\(matrixId, null\);/, "vacuity anchor: the file was read to its end");
});

test("the page's saver stays well under the limit: at most one save every 5 s per tab", () => {
  const own = readFileSync(join(import.meta.dirname, "../../../lib/ownColor.ts"), "utf8");
  assert.match(own, /const GAP_MS = 5000;/);
});
