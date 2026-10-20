// The backend linters must actually RUN, and must actually FAIL the build.
//
// Why: a gate is worth exactly as much as its reader. A `lint` script that CI never invokes is
// a linter that exists only on the machine of whoever remembers to type it.
//
// So this file asserts the CHAIN, not the tool:
//
//   package.json declares `lint`  →  `check:all` calls it  →  CI runs `check:all`
//
// Each link is checked for both backends. Break any one and this goes red.
//
// It also pins the config filename to `.mjs`. The stream-api deploy copies the top-level `*.js`,
// so a config named `eslint.config.js` would be copied onto the runtime box as though it were
// application code — the same class of mistake as shipping a test file.
//
// This test lives in stream-api but covers BOTH packages:
// the paths resolve only in the repo, deliberately, since CI runs from the repo and a check
// that quietly skipped would be worse than no check.
//
// Run: node --test lint-wiring.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const REPO = join(__dirname, '..');
const CI = join(REPO, '.github', 'workflows', 'ci.yml');
const BACKENDS = ['stream-api', 'stream-ingest'];

function pkg(name) {
  return JSON.parse(readFileSync(join(REPO, name, 'package.json'), 'utf8'));
}

/**
 * Read the workflow and prove it arrived whole.
 *
 * Anchored on the END of the file. Every assertion below that counts occurrences is a
 * disguised negative — "no job is missing the step" — and a truncated read is the shape that
 * passes loudest over nothing.
 */
function readCiWhole(end) {
  const src = readFileSync(CI, 'utf8');
  assert.match(src.slice(-400), end,
    'ci.yml did not end as expected — the read is truncated and these assertions are vacuous');
  return src;
}

/** The private repo (it has the cut's tools) runs the package jobs; the public repo's CI is the
 *  workflow public-root/ placed at its root (one `gates` job over the three packages). */
const PRIVATE = existsSync(join(REPO, 'tools', 'public-export.sh'));

test('each backend declares a lint script, and check:all calls it', () => {
  for (const name of BACKENDS) {
    const scripts = pkg(name).scripts || {};
    assert.equal(scripts.lint, 'eslint', `${name}: expected a plain \`eslint\` lint script`);
    assert.ok(scripts['check:all'], `${name}: no check:all script — CI has nothing to call`);
    assert.match(scripts['check:all'], /\blint\b/,
      `${name}: check:all exists but does not run lint, so CI would run a green no-op`);
  }
});

test('each backend declares check:orphans, and check:all calls it too', () => {
  // The same chain argument as `lint` above, for the orphan gate.
  // eslint cannot see an unused EXPORT — a symbol that leaves its module is
  // "used" as far as the linter is concerned, whoever does or does not import
  // it — so `check:all` running only eslint would leave the backends with no
  // reader for exactly the failure this second gate exists to find.
  for (const name of BACKENDS) {
    const scripts = pkg(name).scripts || {};
    assert.ok(scripts['check:orphans'],
      `${name}: no check:orphans script — the dead-export gate has no entry point`);
    assert.match(scripts['check:orphans'], new RegExp(`check-orphans\\.mjs ${name}\\b`),
      `${name}: check:orphans must point the shared scanner at ITS OWN package`);
    assert.match(scripts['check:all'], /check:orphans/,
      `${name}: check:all does not run check:orphans, so CI would never call it`);
  }
  // ONE scanner, outside both packages. Two copies would drift, and a copy
  // INSIDE either package would be shipped to a runtime box — stream-api's
  // deploy copies the top-level `*.js` and stream-ingest is copied whole.
  assert.ok(existsSync(join(REPO, 'tools', 'check-orphans.mjs')),
    'the shared scanner is missing — both packages\' check:orphans would fail to resolve');
  for (const name of BACKENDS) {
    assert.ok(!existsSync(join(REPO, name, 'check-orphans.mjs')),
      `${name}: a per-package copy of the scanner — the two will drift, and this one deploys`);
  }
});

test('every package declares check:owner-literals, and check:all calls it', () => {
  // The owner-literal ratchet runs in ALL THREE
  // packages — web included, unlike the two gates above — because owner values
  // land in all three. Same chain argument: a gate check:all does not call is a
  // gate CI never runs.
  for (const name of [...BACKENDS, 'web']) {
    const scripts = pkg(name).scripts || {};
    assert.match(scripts['check:owner-literals'] || '',
      new RegExp(`^node \\.\\./tools/check-owner-literals\\.mjs ${name}$`),
      `${name}: check:owner-literals must point the shared scanner at ITS OWN package`);
    assert.match(scripts['check:all'], /npm run check:owner-literals\b/,
      `${name}: check:all does not run check:owner-literals, so CI would never call it`);
  }
  // One scanner, outside every package, with its config and baseline beside it.
  for (const f of ['check-owner-literals.mjs', 'literals.json', 'owner-literals.baseline.json']) {
    assert.ok(existsSync(join(REPO, 'tools', f)), `tools/${f} is missing`);
  }
  for (const name of [...BACKENDS, 'web']) {
    assert.ok(!existsSync(join(REPO, name, 'check-owner-literals.mjs')),
      `${name}: a per-package copy of the scanner — the two will drift, and a backend copy deploys`);
  }
});

test('every package declares check:owner-seam, and check:all calls it', () => {
  // Product code reaches each package's owner folder only through its one seam file, so the public export (the tree
  // minus owner/) still builds. Same chain argument as above.
  for (const name of [...BACKENDS, 'web']) {
    const scripts = pkg(name).scripts || {};
    assert.match(scripts['check:owner-seam'] || '',
      new RegExp(`^node \\.\\./tools/check-owner-seam\\.mjs ${name}$`),
      `${name}: check:owner-seam must point the shared scanner at ITS OWN package`);
    assert.match(scripts['check:all'], /npm run check:owner-seam\b/,
      `${name}: check:all does not run check:owner-seam, so CI would never call it`);
  }
  assert.ok(existsSync(join(REPO, 'tools', 'check-owner-seam.mjs')), 'tools/check-owner-seam.mjs is missing');
});

test('every package declares check:instance-schema, and check:all calls it', () => {
  // The settings schema (config/instance-schema.mjs) is ONE file with a
  // GENERATED copy in each package; this gate is what makes "the copy is the schema" true.
  // Same chain argument as the ratchet above: a gate check:all does not call is a gate CI
  // never runs.
  for (const name of [...BACKENDS, 'web']) {
    const scripts = pkg(name).scripts || {};
    assert.match(scripts['check:instance-schema'] || '',
      new RegExp(`^node \\.\\./tools/gen-instance-schema\\.mjs --check ${name}$`),
      `${name}: check:instance-schema must check ITS OWN package's copy`);
    assert.match(scripts['check:all'], /npm run check:instance-schema\b/,
      `${name}: check:all does not run check:instance-schema, so CI would never call it`);
  }
  for (const f of ['tools/gen-instance-schema.mjs', 'config/instance-schema.mjs']) {
    assert.ok(existsSync(join(REPO, f)), `${f} is missing`);
  }
});

test('each backend has an eslint config, and it is .mjs so the deploy loop cannot ship it', () => {
  for (const name of BACKENDS) {
    assert.ok(existsSync(join(REPO, name, 'eslint.config.mjs')),
      `${name}: eslint.config.mjs missing — \`eslint\` with no config lints nothing and exits 0`);
    assert.ok(!existsSync(join(REPO, name, 'eslint.config.js')),
      `${name}: a .js config would be copied to the runtime box by the \`for f in *.js\` deploy loop`);
  }
});

test('eslint is a devDependency of each backend, at the same major as web', () => {
  const webMajor = /(\d+)/.exec(pkg('web').devDependencies.eslint)[1];
  for (const name of BACKENDS) {
    const dev = pkg(name).devDependencies || {};
    assert.ok(dev.eslint, `${name}: eslint is not a devDependency, so \`npm ci\` in CI will not install it`);
    assert.equal(/(\d+)/.exec(dev.eslint)[1], webMajor,
      `${name}: eslint major differs from web's — a rule name would mean two different things`);
  }
});

test('CI runs check:all for every package that defines one', () => {
  for (const name of [...BACKENDS, 'web']) {
    assert.ok(pkg(name).scripts['check:all'], `${name} has no check:all but CI runs one`);
  }
  if (!PRIVATE) {
    // The public workflow: one matrix job over the three packages, each ending in check:all.
    const ci = readCiWhole(/docker compose/);
    const gates = ci.match(/\n {2}gates:[\s\S]*?\n {2}tree:/);
    assert.ok(gates, 'the public workflow has no gates job');
    assert.match(gates[0], /package: \[stream-api, stream-ingest, web\]/, 'the gates job does not cover all three packages');
    assert.match(gates[0], /run: npm run check:all/, 'the gates job does not run check:all');
    return;
  }
  const ci = readCiWhole(/check:all/);
  const runs = ci.match(/run: npm run check:all/g) || [];
  // web + the two backends. A floor AND a ceiling: the floor catches a job that lost its step,
  // the exact count catches a step added to a job whose package has no such script.
  assert.equal(runs.length, 3,
    `expected all three jobs to end in \`npm run check:all\`, found ${runs.length}`);
  // The public-export job runs check:all for all three packages through ONE script, so the cut
  // and the package jobs cannot disagree about what the gates are.
  assert.match(ci, /\n {2}public-export:[\s\S]*?run: tools\/public-export\.sh /, 'the public-export job does not run tools/public-export.sh');
  const exportScript = readFileSync(join(REPO, 'tools', 'public-export.sh'), 'utf8');
  assert.match(exportScript, /for pkg in stream-api stream-ingest web; do[\s\S]*?npm run check:all/, 'public-export.sh no longer runs check:all in all three packages');
});

test('every eslint suppression in backend source carries a written reason', () => {
  // A warning is fixed, or switched off with the reason recorded. A bare directive is
  // neither. eslint's own `--` description syntax is used so the reason travels with the
  // directive rather than in prose above it, which drifts.
  //
  // The vacuity anchor here is the WALK, not the directive count. Asserting "at least N
  // directives exist" would turn a legitimate cleanup into a red build; asserting the scan
  // visited a plausible number of files is what actually distinguishes "none found" from
  // "nothing looked".
  const files = [];
  const skip = new Set(['node_modules', '.git', 'config', 'vendor', 'sounds']);
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|cjs|mjs)$/.test(entry)) files.push(full);
    }
  };
  for (const name of BACKENDS) walk(join(REPO, name));

  assert.ok(files.length >= 150,
    `only ${files.length} backend source files walked — the scan is blind and this test is vacuous`);

  const bare = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      const m = /\/[/*]\s*(eslint-disable(?:-next-line|-line)?)\b(.*)$/.exec(line);
      if (!m) return;
      if (!m[2].includes('--')) bare.push(`${file.slice(REPO.length + 1)}:${i + 1}`);
    });
  }
  assert.deepEqual(bare, [],
    `eslint suppressions with no \`-- reason\`:\n  ${bare.join('\n  ')}`);
});
