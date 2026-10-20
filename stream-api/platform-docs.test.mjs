// The public docs' platform pages (docs/public/platforms/*.md) are GENERATED from the setup lists the
// setup pages use (tools/gen-platform-docs.mjs), so the docs and the wizard cannot disagree. This holds
// the committed pages to what the lists make — a list edited without regenerating fails here.
//
// `.test.mjs`: it imports an ES module, and this package's deploy loop is `for f in *.js`.
//
// Run: node --test platform-docs.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAll, setupLists } from "../tools/gen-platform-docs.mjs";

const REPO = join(fileURLToPath(import.meta.url), "..", "..");

test("every setup list has its page, and the index links each one", () => {
  const lists = setupLists();
  assert.ok(lists.length >= 6, `vacuity: only ${lists.length} setup lists read`);
  const files = renderAll();
  for (const l of lists) {
    assert.ok(files[`${l.id}.md`], `${l.id} has no page`);
    assert.match(files["README.md"], new RegExp(`\\]\\(${l.id}\\.md\\)`), `the index does not link ${l.id}`);
  }
  // A value to paste is shown for an example domain, never with a hole in it.
  for (const [f, text] of Object.entries(files)) assert.doesNotMatch(text, /\{(origin|apiOrigin|domain|matrixOrigin|serverName)\}/, f);
});

test("the committed pages are exactly what the setup lists make", () => {
  const r = spawnSync("node", [join(REPO, "tools", "gen-platform-docs.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok — \d+ pages match the setup lists/);
});
