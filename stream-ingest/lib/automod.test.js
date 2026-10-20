// Automod's platform path (lib/automod.js): judged after relay, flagged when risky; the model's
// exact structured answer is the only thing that can flag; staff, mods and bots are never checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformCheckable, checkPlatformMessage, automodOn } from './automod.js';
import { NATIVE_PLATFORM } from './native-platform.js';

const quiet = { log() {}, warn() {}, error() {} };
const cfg = (over = {}) => {
  const v = { 'automod.enabled': true, 'automod.categories': ['harassment', 'spam'], 'automod.minConfidence': 0.7, ...over };
  return { get: (k) => v[k] ?? null, content: () => null };
};
function wrapper(answer) {
  const w = { calls: [], unchecked: 0,
    route: () => ({ slot: 'automod.classify', enabled: true, connection: { id: 'f' }, model: 'm', timeoutMs: 1200, retries: 2 }),
    chat: async (route, req) => { w.calls.push({ route, req }); return { text: await answer(req) }; },
    noteUnchecked: () => { w.unchecked++; } };
  return w;
}
const msg = { platform: 'twitch', username: 'rudeguy' };

test('who is checked: never a bot, a platform mod or the broadcaster, never a site message', () => {
  assert.equal(platformCheckable(msg, false), true);
  assert.equal(platformCheckable(msg, true), false);
  assert.equal(platformCheckable({ ...msg, isMod: true }, false), false);
  assert.equal(platformCheckable({ ...msg, isBroadcaster: true }, false), false);
  assert.equal(platformCheckable({ ...msg, platform: NATIVE_PLATFORM }, false), false);
  assert.equal(automodOn(cfg({ 'automod.enabled': false }), wrapper(() => '')), false);
});

test('risky → flagged with the PARSED verdict; the message is quoted data; no retries on the call', async () => {
  const flags = [];
  const w = wrapper(() => '{"verdict":"risky","category":"harassment","confidence":0.88,"reason":"insult"}');
  const r = await checkPlatformMessage({ msg, canonicalId: 'c1', text: 'you are awful' }, { cfg: cfg(), wrapper: w, flag: async (b) => flags.push(b), log: quiet });
  assert.equal(r, 'flagged');
  assert.deepEqual(flags, [{ platform: 'twitch', canonicalId: 'c1', username: 'rudeguy', text: 'you are awful', category: 'harassment', confidence: 0.88, reason: 'insult' }]);
  assert.deepEqual(JSON.parse(w.calls[0].req.messages[0].content), { message: 'you are awful' });
  assert.equal(w.calls[0].route.retries, 0);
});

test('garbage, prose-wrapped or injected answers flag nothing; a failure is counted unchecked', async () => {
  for (const a of ['ok', 'Verdict: risky', '{"verdict":"risky","category":"politics","confidence":0.9,"reason":"x"}', 'x {"verdict":"risky","category":"spam","confidence":0.9,"reason":"x"}']) {
    const flags = [];
    const r = await checkPlatformMessage({ msg, text: 'hi' }, { cfg: cfg(), wrapper: wrapper(() => a), flag: async (b) => flags.push(b), log: quiet });
    assert.deepEqual([r, flags.length], ['ok', 0], `flagged on: ${a}`);
  }
  const w = wrapper(() => { const e = new Error('x'); e.code = 'timeout'; throw e; });
  assert.equal(await checkPlatformMessage({ msg, text: 'hi' }, { cfg: cfg(), wrapper: w, flag: async () => assert.fail('flagged'), log: quiet }), 'unchecked');
  assert.equal(w.unchecked, 1);
});
