// The scorer registry: nothing registered = nothing scored (the public build), and a malformed
// scorer is refused at registration rather than throwing per message.
// Run: node --test lib/scoring.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerScorer, scorer } from './scoring.js';

test('no scorer until one is registered; then that one', () => {
  assert.equal(scorer(), null);
  const s = { platformJobs: () => [] };
  registerScorer(s);
  assert.equal(scorer(), s);
});

test('a scorer without platformJobs is refused', () => {
  for (const bad of [null, undefined, {}, { platformJobs: 1 }]) assert.throws(() => registerScorer(bad), /platformJobs/);
});

test('the pipeline scores only through the registry, never by importing a scorer', () => {
  const src = fs.readFileSync(new URL('./pipeline.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ scorer \} from '\.\/scoring\.js';/);
  assert.match(src, /const active = scorer\(\);\s*\n\s*if \(active\) for \(const job of active\.platformJobs\(\{ id: logged\.id, clean, words \}\)\) enrichQ\.push\(job\);/);
  assert.doesNotMatch(src, /score\.js|patchKarma|patchIntelligence|KARMA_MIN_WORDS/);
  // Vacuity anchor on the END of the file: the embedding job is the enrichment block's last.
  assert.match(src, /\[pipeline\] embed failed id=/);
});
