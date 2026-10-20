// Source-scan — the three routes import pool via the @/lib/db alias, so
// (same reasoning as every other route test in this plan) this pins the
// response SHAPE rather than executing the route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const webRoot = join(import.meta.dirname, "../..");
const read = (p: string) => stripComments(readFileSync(join(webRoot, p), "utf8"));
const ROUTES = ["api/billing/donate/route.ts", "api/billing/gift/route.ts", "api/billing/points/route.ts"];

test("every payment-mode checkout route returns sessionId beside clientSecret", () => {
  for (const path of ROUTES) {
    const src = read(path);
    assert.match(
      src,
      /Response\.json\(\{ clientSecret: checkout\.client_secret, sessionId: checkout\.id \}\)/,
      `${path}: must return { clientSecret: checkout.client_secret, sessionId: checkout.id }`
    );
  }
});
