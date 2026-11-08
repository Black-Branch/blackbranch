// Every evidence code a reader can emit is a code of the one vocabulary
// (config/platform-liveness.mjs → ./platformLiveness.generated.js), in kebab-case. An admin reads
// a code through EVIDENCE's words; a code missing there would show as nothing.
//
// Run: node --test lib/evidenceCodes.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLATFORM_LIVENESS } from './platformLiveness.generated.js';
import { YOUTUBE_LIVE } from './youtubeLive.generated.js';
import { streamplaceObservation } from '../platforms/streamplace.js';
import { stripComments } from '../../web/app/lib/sourceText.mjs';

const { EVIDENCE } = PLATFORM_LIVENESS;
const FIXTURES = new URL('../platforms/fixtures/youtube/', import.meta.url);
const read = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');
const field = (file, label) => {
  const line = read('README').split('\n').find((l) => l.startsWith(`${file} — `));
  assert.ok(line, `README names ${file}`);
  return line.match(new RegExp(`${label} (UC[\\w-]{22})`))[1];
};
const CH = { none: field('none.html', 'owner') };

test('every code is lowercase kebab-case and has words', () => {
  const codes = Object.keys(EVIDENCE);
  assert.equal(codes.length, 31);
  for (const c of codes) {
    assert.match(c, /^[a-z]+(-[a-z]+)*$/, c);
    assert.ok(typeof EVIDENCE[c] === 'string' && EVIDENCE[c].length > 8, `${c} has words`);
  }
  assert.ok(codes.includes(PLATFORM_LIVENESS.PENDING_EVIDENCE));
});

test('the YouTube classifier, on every Task 2 fixture, emits a vocabulary code', () => {
  const ALL = ['live.html', 'live-no-microformat.html', 'upcoming-watch.html', 'none.html', 'foreign.html', 'consent.html', 'botcheck.html'];
  for (const f of ALL) {
    const { evidence } = YOUTUBE_LIVE.classifyLivePage(read(f), CH.none);
    assert.ok(Object.hasOwn(EVIDENCE, evidence), `${f} → ${evidence}`);
  }
});

test('stream.place, on every branch, emits a vocabulary code', () => {
  const NOW = Date.parse('2026-10-23T10:00:00Z');
  const up = { connected: true, connectedAt: NOW - 600_000, lastFrameAt: NOW - 5_000, uri: 'at://did:plc:test/place.stream.livestream/1', now: NOW };
  const live = { lastSeenAt: new Date(NOW - 10_000).toISOString(), idleTimeoutSeconds: 300 };
  const cases = [
    [{ ...up, record: live }, 'record-live'],
    [{ ...up, record: { ...live, endedAt: new Date(NOW - 5_000).toISOString() } }, 'ended-stamp'],
    [{ ...up, record: { ...live, lastSeenAt: new Date(NOW - 900_000).toISOString() } }, 'record-idle'],
    [{ ...up, record: null }, 'no-record'],
    [{ ...up, record: { lastSeenAt: 'garbage' } }, 'no-record'],
    [{ ...up, connected: false, record: live }, 'socket-quiet'],
  ];
  for (const [input, code] of cases) {
    const o = streamplaceObservation(input);
    assert.equal(o.evidence, code);
    assert.ok(Object.hasOwn(EVIDENCE, o.evidence));
  }
});

// The Twitch and Kick readers' codes are pinned behaviourally in pollerTwitchState.test.js and
// platforms/kick.test.js; this scan proves no reader spells a code the vocabulary lacks. The scan
// is positive (each found code must be known) and guarded against reading nothing.
test('no reader spells an evidence code the vocabulary lacks', () => {
  // Each file's LAST export: the scan must reach the end of the file it reads (a vacuity anchor).
  const files = {
    './poller.js': 'export function startPoller(',
    '../platforms/kick.js': 'export async function startKick(',
    '../platforms/streamplace.js': 'export async function startStreamplace(',
    '../platforms/youtube.js': 'export async function startYouTube(',
    './ytEndDecision.js': 'export function chatPollDelay(',
  };
  const found = [];
  for (const [f, last] of Object.entries(files)) {
    const src = stripComments(readFileSync(new URL(f, import.meta.url), 'utf8'));
    const end = src.lastIndexOf(last);
    assert.ok(end !== -1 && !/\nexport /.test(src.slice(end + last.length)), `${f}: the scan did not reach its last export (${last})`);
    for (const m of src.matchAll(/evidence:\s*'([^']+)'/g)) found.push([f, m[1]]);
    for (const m of src.matchAll(/evidence:\s*[^,}\n]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) found.push([f, m[1]], [f, m[2]]);
    // The readers' small helpers: unknown('<code>') in poller.js, o('<raw>', '<code>') in streamplace.js,
    // none(<state>, '<code>'[, certain]) in youtube.js, obs('<raw>', <certain>, '<code>') in ytEndDecision.js.
    for (const m of src.matchAll(/\bunknown\('([^']+)'\)/g)) found.push([f, m[1]]);
    for (const m of src.matchAll(/\bo\([^,()]*,\s*'([^']+)'\)/g)) found.push([f, m[1]]);
    for (const m of src.matchAll(/\bnone\([^,()]*,\s*'([^']+)'/g)) found.push([f, m[1]]);
    for (const m of src.matchAll(/\bnone\([^,()]*,\s*[^,()?]*\?\s*'([^']+)'\s*:\s*'([^']+)'\)/g)) found.push([f, m[1]], [f, m[2]]);
    for (const m of src.matchAll(/\bobs\('[^']+',\s*[^,()]+,\s*'([^']+)'\)/g)) found.push([f, m[1]]);
  }
  assert.ok(found.length >= 8, `the scan found ${found.length} codes — it read nothing useful`);
  for (const [f, code] of found) assert.ok(Object.hasOwn(EVIDENCE, code), `${f} emits '${code}', not in EVIDENCE`);
  // The YouTube reader's own codes were read too (the scan reaches the files Task 4 writes codes in).
  const yt = new Set(found.filter(([f]) => f.endsWith('youtube.js') || f.endsWith('ytEndDecision.js')).map(([, c]) => c));
  for (const c of ['not-live', 'channel-canonical', 'sticky-check-failed', 'foreign-video', 'api-confirmed', 'held-by-chat', 'upcoming']) {
    assert.ok(yt.has(c), `the scan did not see the YouTube reader write '${c}'`);
  }
});
