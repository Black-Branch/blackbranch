// The three .env.example files are the install's env reference. This keeps each one from falling behind what its package actually reads:
//   1. every env name the settings schema declares for a package (its canonical name) is in
//      that package's example, and
//   2. every `process.env.NAME` the package's own code reads is in it too, unless it is on the
//      short list below of names that are not install settings (each says why).
// Run: node --test env-example.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTANCE_KEYS } from '../config/instance-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Names a package reads that are not an install's settings. */
const NOT_SETTINGS = {
  '*': {
    NODE_ENV: 'set by the runtime / the unit, not by an installer',
    CI: 'set by the CI runner',
  },
  web: {
    NEXT_RUNTIME: 'set by Next itself',
    INSTALL_VALUES: 'written by instrumentation.ts at boot from the install values (installValuesServer.ts) — never set by hand',
    DRY_RUN: 'a flag for the maintenance scripts, not the site',
    AUTH_URL: 'next-auth\'s own name for SITE_ORIGIN — set from it at boot (the example says so)',
    NEXTAUTH_URL: 'next-auth\'s legacy name for the same, never needed',
    TEST_NO_OWNER: 'a switch for the TSX test loader (app/lib/testTsx.ts): render as the public build would',
  },
  'stream-api': {},
  'stream-ingest': {},
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    // The owner folders are not the product: their knobs are the owner's own.
    if (e === 'node_modules' || e === '.next' || e.startsWith('.') || e === 'owner' || e === '(owner)') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(c|m)?(j|t)sx?$/.test(e) && !/\.(test|probe)\.|generated/.test(e)) out.push(p);
  }
  return out;
}

for (const pkg of ['web', 'stream-api', 'stream-ingest']) {
  const example = readFileSync(join(ROOT, pkg, '.env.example'), 'utf8');
  const mentions = (name) => new RegExp(`(^|[^A-Z0-9_])${name}=`, 'm').test(example);

  test(`${pkg}/.env.example names every env the schema declares for ${pkg}`, () => {
    const declared = INSTANCE_KEYS.filter((e) => e.packages.includes(pkg) && e.env.length).map((e) => e.env[0]);
    assert.ok(declared.length >= 10, `only ${declared.length} declared names for ${pkg} — the schema read went wrong`);
    const missing = declared.filter((n) => !mentions(n));
    assert.deepEqual(missing, [], `${pkg}/.env.example is missing: ${missing.join(', ')}`);
  });

  test(`${pkg}/.env.example names every env ${pkg}'s code reads`, () => {
    const files = walk(join(ROOT, pkg));
    assert.ok(files.length > 20, `scanned only ${files.length} files in ${pkg}`);
    const read = new Set();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) read.add(m[1]);
    }
    const anchor = { web: 'DATABASE_URL', 'stream-api': 'DB_PASSWORD', 'stream-ingest': 'STREAM_API_URL' }[pkg];
    assert.ok(read.has(anchor), `the scan did not find ${anchor}, which every install sets`);
    const skip = { ...NOT_SETTINGS['*'], ...NOT_SETTINGS[pkg] };
    const missing = [...read].filter((n) => !skip[n] && !mentions(n)).sort();
    assert.deepEqual(missing, [], `${pkg}/.env.example is missing: ${missing.join(', ')}`);
  });

  test(`${pkg}/.env.example carries no install's own values`, () => {
    // The ratchet (tools/check-owner-literals.mjs) holds the owner's names at zero here; this
    // pins the shape: placeholders are example.tv / empty, never a real host.
    assert.match(example, /\n$/, 'the example lost its end');
    assert.doesNotMatch(example, /https?:\/\/(?!127\.0\.0\.1|example\.tv|api\.example\.tv|matrix\.example\.tv|auth\.example\.tv)[a-z0-9.-]+\.[a-z]{2,}/i,
      'a real host in the example');
  });
}
