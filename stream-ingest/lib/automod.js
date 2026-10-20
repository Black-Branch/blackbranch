// Automod for platform messages.
//
// A relayed Twitch / YouTube / Kick / stream.place message is already public on its platform and
// cannot be held, so it is judged AFTER relay, in the pipeline's enrichment pool (no added
// relay latency), and a risky one is FLAGGED for moderators (stream-api POST /automod/ai). The
// pool is shed under a delivery backlog, so some messages go unchecked; that is counted.
// Staff and mods on their platform, and bots, are never checked. The verdict is parsed strictly
// by the adapter (anything but the model's exact structured answer is `ok`), and stream-api
// re-validates the category and confidence before it writes the row.

import { AI_ADAPTER } from './aiAdapter.generated.js';
import { instanceConfig } from './instanceConfig.js';
import { ai } from './ai.js';
import { flagAutomod } from './api.js';
import { isNativePlatform } from './native-platform.js';

const SLOT = 'automod.classify';
const TIMEOUT_MS = 15_000;

/** Is automod on, with a task that resolves? Read per message. */
export function automodOn(cfg = instanceConfig, wrapper = ai) {
  return cfg.get('automod.enabled') === true && wrapper.route(SLOT).enabled;
}

/** Should this relayed message be checked? Server-side roles only — never a name. Pure. */
export function platformCheckable(msg, isBot) {
  return !isBot && !msg.isMod && !msg.isBroadcaster && !isNativePlatform(msg.platform);
}

/** Judge one relayed message; flag it when risky. Resolves 'flagged' | 'ok' | 'unchecked'. */
export async function checkPlatformMessage({ msg, canonicalId, text }, { cfg = instanceConfig, wrapper = ai, flag = flagAutomod, log = console } = {}) {
  const base = wrapper.route(SLOT);
  if (!base.enabled) return 'unchecked';
  const content = cfg.content('prompt.automod.classify') || AI_ADAPTER.PRODUCT_SLOTS.find((s) => s.id === SLOT).defaultPrompt;
  const cats = cfg.get('automod.categories') || [];
  let out;
  try {
    out = await wrapper.chat({ ...base, timeoutMs: TIMEOUT_MS, retries: 0 }, { ...AI_ADAPTER.automodRequest(content, cats, text), temperature: 0 });
  } catch (e) {
    wrapper.noteUnchecked(SLOT);
    log.warn(`[automod] platform check failed: ${e.code || e.message}`);
    return 'unchecked';
  }
  const v = AI_ADAPTER.parseAutomodVerdict(out.text, cats, cfg.get('automod.minConfidence'));
  if (v.verdict !== 'risky') return 'ok';
  await flag({ platform: msg.platform, canonicalId: canonicalId || null, username: msg.username, text, category: v.category, confidence: v.confidence, reason: v.reason });
  return 'flagged';
}
