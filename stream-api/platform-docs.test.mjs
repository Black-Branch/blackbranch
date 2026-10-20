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
import { renderAll, renderIndex, setupLists } from "../tools/gen-platform-docs.mjs";

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

test("an index description keeps its pipes and backslashes inside its own cell", () => {
  const row = renderIndex([{ id: "x", label: "X", kind: "module", description: String.raw`a | b \| c \ d` }])
    .split("\n").find((l) => l.startsWith("| [X]"));
  // Escaped: `\\` for each backslash, then `\|` for each pipe — so the table splitter sees no bare pipe.
  assert.equal(row, String.raw`| [X](x.md) | module (switch) | a \| b \\\| c \\ d |`);
});

test("the committed pages are exactly what the setup lists make", () => {
  const r = spawnSync("node", [join(REPO, "tools", "gen-platform-docs.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok — \d+ pages match the setup lists/);
});
