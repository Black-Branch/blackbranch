// The backend orphaned-export gate, tested against fixtures.
//
// `tools/check-orphans.mjs` decides what counts as a dead export in stream-api
// and stream-ingest. Every case below is a mistake a scanner like this makes
// easily, in both directions: counting nested config keys as exports, calling
// every test-reached internal dead, and stopping the reference sweep at the
// package edge so live exports used only by another package read as dead.
//
// The gate is the thing that decides whether code gets deleted, so it is worth
// more than its own output. These fixtures are what stop it drifting back.
//
// This file is `.test.mjs`, not `.test.js`. It imports an ES module, and the
// deploy for this package copies the top-level `*.js` — a name ending in `.mjs`
// cannot match it. Same reasoning as `eslint.config.mjs`.
//
// Run: node --test orphan-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { findOrphans, exportedNames } from "../tools/check-orphans.mjs";

test("a nested object's keys are properties, not exports", () => {
  // The first run reported obs.js:AUDIO_SCENE and four siblings as dead
  // exports. They are keys of the exported `config` object — deleting them
  // would have removed live configuration from a running service. The braced
  // list must be read depth-aware; a `[^}]*` capture stops at the first `}`
  // and swallows the nested names.
  const names = exportedNames(
    "const URL = 1, AUDIO_SCENE = 2, playSound = 3;\n" +
    "module.exports = {\n  playSound,\n  config: { URL, AUDIO_SCENE },\n};\n"
  ).map((e) => e.name);
  assert.deepEqual(names.sort(), ["config", "playSound"]);
});

test("both dialects are read by the one scanner", () => {
  const cjs = exportedNames("module.exports = { a, b: impl };").map((e) => e.name);
  assert.deepEqual(cjs.sort(), ["a", "b"]);
  const esm = exportedNames("export function a() {}\nexport const b = 1;\n").map((e) => e.name);
  assert.deepEqual(esm.sort(), ["a", "b"]);
  const renamed = exportedNames("export { impl as publicName };").map((e) => e.name);
  assert.deepEqual(renamed, ["publicName"]);
});

test("a symbol named only in a COMMENT is not a reference", () => {
  // The failure web's own gate shipped with: `\bname\b` against raw source, so
  // a note telling a future reader to use something kept it alive.
  const { dead } = findOrphans({
    "a.js": "function widget() {}\nmodule.exports = { widget };\n",
    "b.js": "// one day we should call widget() here\n",
  });
  assert.deepEqual(dead, ["a.js:widget"]);
});

test("a real call site keeps it alive", () => {
  const { dead } = findOrphans({
    "a.js": "function widget() {}\nmodule.exports = { widget };\n",
    "b.js": "const { widget } = require('./a');\nwidget();\n",
  });
  assert.deepEqual(dead, []);
});

test("test-reached and dead are DIFFERENT answers", () => {
  // Conflating them is what made the first run unusable. A test is a real
  // consumer; nothing is not.
  const { dead, testOnly } = findOrphans({
    "a.js": "function tested() {}\nfunction nobody() {}\nmodule.exports = { tested, nobody };\n",
    "a.test.js": "const { tested } = require('./a');\ntested();\n",
  });
  assert.deepEqual(dead, ["a.js:nobody"]);
  assert.deepEqual(testOnly, ["a.js:tested"]);
});

test("a consumer in ANOTHER package counts, when it imports this one", () => {
  // The eleven false deaths. web/app/lib/linkGateParity.test.ts does
  // `require("../../../stream-api/link-gate.js")` and is the only consumer of
  // eight link-gate exports. A package-scoped sweep called all of them dead.
  const own = { "link-gate.js": "function hostOf() {}\nmodule.exports = { hostOf };\n" };
  const world = {
    ...own,
    "web/app/lib/parity.test.ts":
      'const api = require("../../../stream-api/link-gate.js");\napi.hostOf("x");\n',
  };
  assert.deepEqual(findOrphans(own, world).dead, []);
  assert.deepEqual(findOrphans(own, world).testOnly, ["link-gate.js:hostOf"]);
});

test("an unrelated same-named symbol elsewhere does NOT count", () => {
  // The opposite error, introduced by the fix for the one above: sweeping the
  // whole repo made notify.js:COOLDOWN_MS look alive because
  // web/app/api/me/displayname/route.ts declares its own seven-day COOLDOWN_MS.
  // The caller only puts importers in `world`, so this fixture stands in for
  // what it must NOT put there.
  const own = { "notify.js": "const COOLDOWN_MS = 1;\nmodule.exports = { COOLDOWN_MS };\n" };
  assert.deepEqual(findOrphans(own, own).dead, ["notify.js:COOLDOWN_MS"]);
});

test("a tag exempts, but only with a reason", () => {
  const tagged = findOrphans({
    "a.js":
      "// @test-only reached by the parity suite, which is the point of it\n" +
      "function widget() {}\nmodule.exports = { widget };\n",
  });
  assert.deepEqual(tagged.dead, []);

  const bare = findOrphans({
    "a.js": "// @test-only\nfunction widget() {}\nmodule.exports = { widget };\n",
  });
  assert.deepEqual(bare.dead, ["a.js:widget"], "a bare tag is a mute button, not a reason");
});

test("a CommonJS tag is found at the DEFINITION, not just the export list", () => {
  // The one thing this gate needs that web's does not. `module.exports = {…}`
  // sits at the bottom of the file, so "the docblock above the export" would
  // mean the docblock above a list of names.
  const { dead } = findOrphans({
    "a.js":
      "// @parked kept to mirror the web twin, enforced by the parity test\n" +
      "function widget() {}\n\nmodule.exports = { widget };\n",
  });
  assert.deepEqual(dead, []);
});

test("a tag one blank line up does NOT reach the definition", () => {
  // The drift web's gate found in coins.ts: a real, reasoned tag that had
  // floated out of its window and was enforcing nothing. One blank line ends
  // the docblock, so a tag above the wrong symbol cannot leak onto this one.
  const { dead } = findOrphans({
    "a.js":
      "// @parked kept to mirror the web twin, enforced by the parity test\n" +
      "function other() {}\n\nfunction widget() {}\nmodule.exports = { widget };\n",
  });
  assert.deepEqual(dead, ["a.js:widget"]);
});

test("a scan that finds no exports THROWS rather than passing", () => {
  // The vacuity anchor, and the one that matters most: every answer this gate
  // gives is "these are unreferenced", which an empty read satisfies perfectly.
  assert.throws(
    () => findOrphans({ "a.js": "const x = 1;\n" }),
    /vacuous/,
    "a scan with nothing to scan must fail loudly, not report a clean bill"
  );
});
