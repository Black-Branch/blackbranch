// The old route paths are not rewritten, and nothing serves them — a request to one is a plain
// 404.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..", "..");
const src = readFileSync(join(WEB, "next.config.ts"), "utf8");

test("next.config.ts rewrites nothing but the product favicon — the one-release phase-R aliases are gone", () => {
  assert.match(src, /async redirects\(\)/, "anchor: the config was read and still has its redirects");
  const block = src.match(/async rewrites\(\) \{([\s\S]*?)\n {2}\},\n/)?.[1];
  assert.ok(block, "anchor: the rewrites() block was found");
  // Exactly one rule: /favicon.ico → the product's, after files (a site's own public/favicon.ico wins).
  assert.deepEqual([...block.matchAll(/source: "([^"]+)"/g)].map((m) => m[1]), ["/favicon.ico"]);
  assert.match(block, /afterFiles: \[\{ source: "\/favicon\.ico", destination: "\/brand\/favicon\.ico" \}\]/);
  assert.doesNotMatch(block, /beforeFiles|fallback|coins/);
});

test("the renamed route families are served only under their new names", () => {
  // The owner plugin's renamed family is checked in its own folder (app/(owner)/ownerRoutes.test.ts).
  for (const [oldDir, newDir] of [["api/coins", "api/points"], ["api/billing/coins", "api/billing/points"]] as const) {
    assert.ok(!existsSync(join(WEB, "app", oldDir)), `${oldDir} has a route directory again`);
    assert.ok(existsSync(join(WEB, "app", newDir)), `${newDir} is missing from app`);
  }
});
