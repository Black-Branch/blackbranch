// decideEnd: a failed live-lookup against a HEALTHY chat continuation is
// "unknown", never a step toward "ended" — a false end closes the chat
// mid-stream and leaves a blind gap.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideEnd, END_HOLD_MS, END_MISS_THRESHOLD } from './ytEndDecision.js';

test('healthy chat holds the miss counter at zero (no false end)', () => {
  // Chat delivered 2s ago while the lookup fails — the false-close shape.
  const d = decideEnd({ missCount: 2, msSinceChatOk: 2_000 });
  assert.equal(d.action, 'hold');
  assert.equal(d.missCount, 0, 'the hold RESETS the counter — stale misses must not bank');
});

test('quiet chat counts misses and closes at the threshold (real end unchanged)', () => {
  let missCount = 0;
  const stale = END_HOLD_MS + 1;
  let d = decideEnd({ missCount, msSinceChatOk: stale });
  assert.deepEqual(d, { action: 'count', missCount: 1 });
  d = decideEnd({ missCount: d.missCount, msSinceChatOk: stale });
  assert.deepEqual(d, { action: 'count', missCount: 2 });
  d = decideEnd({ missCount: d.missCount, msSinceChatOk: stale });
  assert.equal(d.action, 'close');
  assert.equal(d.missCount, 0, 'close resets for the next stream');
  assert.equal(END_MISS_THRESHOLD, 3, 'the pre-existing 3-miss debounce is preserved');
});

test('non-api read modes are unchanged: an unmeasured chat never holds', () => {
  // lastPollOkAt 0 → caller passes a huge elapsed value.
  const d = decideEnd({ missCount: 0, msSinceChatOk: Number.MAX_SAFE_INTEGER });
  assert.equal(d.action, 'count');
});
