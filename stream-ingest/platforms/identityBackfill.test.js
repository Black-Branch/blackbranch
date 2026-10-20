// The Data-API identity backfill gate + its error diagnostics.
// Run: node --test platforms/identityBackfill.test.js
//
// WHY THE GATE HAS A TEST. A gate written for one inline-channelId mode goes
// stale when another such mode is added: the resolver then runs on every
// stream, polls liveChatMessages.list with an API key (which answers 403),
// and spends ~150 quota units/hour filling a map that deliverText never
// consults (the inline channelId always wins in 'api'/'net').

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunIdentityBackfill, ytApiError } from './youtube.js';

test('the backfill runs ONLY in dom mode, and never for relays', () => {
  // 'dom' is the one read path with no inline channelId.
  assert.equal(shouldRunIdentityBackfill('dom', false), true);

  // 'api' (the default) and 'net' parse innertube JSON where every
  // message carries authorExternalChannelId — the resolver has nothing to add.
  assert.equal(shouldRunIdentityBackfill('api', false), false,
    'the resolver is running in api mode again — it will 403 every poll of every stream');
  assert.equal(shouldRunIdentityBackfill('net', false), false);

  // Relay connections skip the home pipeline entirely.
  assert.equal(shouldRunIdentityBackfill('dom', true), false);

  // An unknown future mode defaults to NOT burning quota.
  assert.equal(shouldRunIdentityBackfill('something-new', false), false);
});

test('a failed API response reports the reason, not just the status', async () => {
  // "HTTP 403" is ambiguous between quotaExceeded and an authorization
  // refusal. The error must carry the API's own reason when present.
  const quota = await ytApiError('liveChatMessages.list', {
    status: 403,
    json: async () => ({ error: { errors: [{ reason: 'quotaExceeded' }] } }),
  });
  assert.equal(quota.message, 'liveChatMessages.list HTTP 403 (quotaExceeded)');

  const forbidden = await ytApiError('videos.list', {
    status: 403,
    json: async () => ({ error: { status: 'PERMISSION_DENIED', errors: [] } }),
  });
  assert.equal(forbidden.message, 'videos.list HTTP 403 (PERMISSION_DENIED)');

  // An unreadable body must not turn a diagnostic helper into a new crash.
  const bare = await ytApiError('videos.list', {
    status: 500,
    json: async () => { throw new Error('not json'); },
  });
  assert.equal(bare.message, 'videos.list HTTP 500');
});
