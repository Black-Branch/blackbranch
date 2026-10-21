// The YouTube reader on an image with no browser fails LOUDLY and fast.
//
// On an image without Chromium the reader cannot start; unhandled, the journal says "[main]
// youtube failed to start" once, with Playwright's boxed many-line advice, and the Stream tab
// says "running". This runs the REAL reader and the REAL Playwright with its browser
// folder pointed at an empty directory — what an image without Chromium looks like to it — and
// asserts a one-line "browser missing: …" that reaches the starter's state as `failed`.
//
// Run: node --test platforms/youtubeBrowserMissing.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const empty = mkdtempSync(join(tmpdir(), 'no-browser-'));
process.env.PLAYWRIGHT_BROWSERS_PATH = empty;
process.env.STREAM_API_URL = 'http://stream-api.test';

const { startYouTube } = await import('./youtube.js');
const { createPlatformStarter } = await import('../lib/platformStarter.js');
const { launchError } = await import('../lib/browser.js');

test.after(() => rmSync(empty, { recursive: true, force: true }));

test('no browser in the image: startYouTube rejects within seconds with one line naming the missing browser', async () => {
  const t0 = Date.now();
  await assert.rejects(startYouTube({ channelId: 'UCcaseytestchannel00000' }), (e) => {
    assert.match(e.message, /^browser missing: /);
    assert.doesNotMatch(e.message, /\n/, 'one line');
    assert.doesNotMatch(e.message, /[╔║╚]/, 'no Playwright box');
    return true;
  });
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms — it must not wait out a launch timeout`);
});

test('through the starter: the reader is `failed` with "browser missing: …", never `running`', async () => {
  const platforms = createPlatformStarter({
    starters: { youtube: () => startYouTube({ channelId: 'UCcaseytestchannel00000' }) },
    choose: () => ({ enabled: ['youtube'], unknown: [], note: 'youtube', signatures: { youtube: 'x' } }),
    log: { log() {}, warn() {}, error() {} },
  });
  await platforms.reconcile();
  const s = platforms.states().youtube;
  assert.equal(s.state, 'failed');
  assert.match(s.error, /^browser missing: /);
  assert.equal(platforms.handle('youtube'), null);
});

test('launchError: a launch timeout and an unknown failure are worded apart from a missing browser', () => {
  assert.match(launchError(new Error('browserType.launch: Timeout 30000ms exceeded.\n=== logs ===')).message, /^browser did not start within 30s: Timeout 30000ms exceeded\.$/);
  assert.match(launchError(new Error('browserType.launch: Target page, context or browser has been closed')).message, /^browser failed to start: Target page/);
  assert.match(launchError(new Error('browserType.launch: Host system is missing dependencies to run browsers.')).message, /^browser missing: Host system is missing dependencies/);
});
