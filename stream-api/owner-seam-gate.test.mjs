// The owner seam gate (tools/check-owner-seam.mjs), against fixtures and the real tree.
// Product code reaches the owner folder only through its package's seam file.
// `.test.mjs`: it imports an ES module, and the deploy copies `*.js` (orphan-gate.test.mjs).
//
// Run: node --test owner-seam-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { checkSeam, specifiersOf, targetOf, REPO } from "../tools/check-owner-seam.mjs";

const f = (path, text) => ({ path, text });

test("a product file importing the owner folder is a violation, in every spelling", () => {
  const files = [
    f("stream-api/plugins.js", "require(path.join(dir, './owner/index.js'));"),
    f("stream-api/a.js", "const x = require('./owner/lights');"),
    f("stream-api/b.js", "const y = require(`./owner/meter.js`);"),
    f("stream-api/sub/c.js", "require('../owner');"),
  ];
  const r = checkSeam("stream-api", files);
  assert.deepEqual(r.violations.map((v) => v.path), ["stream-api/a.js", "stream-api/b.js", "stream-api/sub/c.js"]);
});

test("ESM, dynamic import, URL resolution and the web alias all count", () => {
  const ingest = checkSeam("stream-ingest", [
    f("stream-ingest/index.js", "new URL('./owner/plugin.js', import.meta.url)"),
    f("stream-ingest/lib/x.js", "import { a } from '../owner/gadget/brain.js';"),
    f("stream-ingest/lib/y.js", "const m = await import('../owner/plugin.js');"),
  ]);
  assert.deepEqual(ingest.violations.map((v) => v.path), ["stream-ingest/lib/x.js", "stream-ingest/lib/y.js"]);
  const web = checkSeam("web", [
    f("web/app/lib/plugins/installed.ts", 'import { ownerPlugin } from "@owner/plugin";'),
    f("web/app/features/chat/A.tsx", 'import { T } from "@/app/(owner)/terminal/T";'),
    f("web/app/features/chat/B.tsx", 'import { ownerPlugin } from "@owner/plugin";'),
    f("web/next.config.ts", 'const p = existsSync("./app/(owner)/plugin.ts") ? "./app/(owner)/plugin.ts" : "x";'),
  ]);
  assert.deepEqual(web.violations.map((v) => v.path), ["web/app/features/chat/A.tsx", "web/app/features/chat/B.tsx"]);
  assert.equal(web.seamImports, 1);
});

test("a comment naming the owner folder is not an import", () => {
  const r = checkSeam("stream-api", [
    f("stream-api/plugins.js", "require('./owner/index.js');"),
    f("stream-api/a.js", "// moved to ./owner/lights.js in phase 5\n/* require('./owner/x') */\nconst a = 1;"),
  ]);
  assert.deepEqual(r.violations, []);
});

test("owner code importing product code is the right direction, and a folder merely named owner is product", () => {
  const r = checkSeam("stream-api", [
    f("stream-api/plugins.js", "require('./owner/index.js');"),
    f("stream-api/owner/lights.js", "require('../notify.js');"),
    f("stream-api/lib/owner/x.js", "require('../../owner/index.js');"),
  ]);
  assert.deepEqual(r.violations.map((v) => v.path), ["stream-api/lib/owner/x.js"]);
});

test("vacuous case: no seam read, or a seam that imports nothing, is reported", () => {
  assert.equal(checkSeam("stream-api", [f("stream-api/a.js", "1")]).seamRead, false);
  const r = checkSeam("stream-api", [f("stream-api/plugins.js", "module.exports = {};")]);
  assert.equal(r.seamRead, true);
  assert.equal(r.seamImports, 0);
});

test("specifier helpers", () => {
  assert.deepEqual(specifiersOf("import a from 'x'; import 'y'; require(\"z\")").sort(), ["x", "y", "z"]);
  assert.equal(targetOf("@owner/plugin", "web/a.ts"), "@owner");
  assert.equal(targetOf("react", "web/a.ts"), null);
  assert.equal(targetOf("./owner/x.js", "stream-api/a.js"), join("stream-api", "owner", "x.js"));
});

test("the real tree passes in all three packages (and the CLI exits 1 on a violation)", () => {
  for (const pkg of ["stream-api", "stream-ingest", "web"]) {
    const out = execFileSync("node", ["tools/check-owner-seam.mjs", pkg], { cwd: REPO, encoding: "utf8" });
    assert.match(out, /ok — \d+ files, [1-9]\d* seam import/);
  }
});
