// Source scan (the cache imports pool through the @/lib/db alias, like every
// route test in this repo): the route is one line over the shared cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));

test("the route answers from the shared Home cache and builds nothing itself", () => {
  assert.match(src, /import \{ getHomePayload \} from "@\/app\/lib\/homeCache"/);
  assert.match(src, /export async function GET\(\) \{\s*return Response\.json\(await getHomePayload\(\)\);\s*\}/);
  assert.doesNotMatch(src, /createTtlCache|buildHomePayload|bot\/top|support/);
  assert.match(src, /\}\s*$/); // END anchor
});
