// stream-ingest's AI wrapper — the slot registry, live route resolution, usage counting, and the
// report stream-api records.
//
// The adapter (./aiAdapter.generated.js, generated from config/ai-adapter.mjs) is pure; the
// state is here:
//   • the registry: the product's slots, plus what a plugin registers at boot (never a product
//     slot id). A plugin may also pin a PRODUCT slot to an env name of its own;
//   • the config snapshot, read from the settings layer at CALL time, so a model or key edit
//     applies on the next call with no restart;
//   • usage counts, and the report — this process's plugin slots and every slot's route, which
//     only this process can resolve (its env pins) — sent with the settings layer's report.

import { AI_ADAPTER } from './aiAdapter.generated.js';
import { instanceConfig } from './instanceConfig.js';
import { notifyOps } from './ops.js';

const SLOT_ID = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){0,3}$/;
const PLUGIN_ID = /^[a-z0-9-]{1,24}$/;
const NEEDS = ['tools', 'serverWebSearch', 'vision', 'json'];
const USAGE_EVERY_MS = 60_000;

const isProduct = (id) => AI_ADAPTER.PRODUCT_SLOTS.some((p) => p.id === id);
const PROMPT_MAX = 16000;

/** A plugin slot's prompts: `[{key, label, help?, defaultPrompt}]`, each an install-editable text
 *  stored as content `prompt.<key>`. The key sits under the plugin's own id and is never a product
 *  slot id. Refused loudly — a bad declaration is a plugin bug, not something to run without. */
function checkPrompts(pluginId, slotId, list) {
  if (list === undefined) return undefined;
  const bad = (why) => { throw new Error(`ai.registerSlots(${pluginId}): ${slotId}: ${why}`); };
  if (!Array.isArray(list)) bad('prompts must be a list');
  const seen = new Set();
  return list.map((p) => {
    if (!p || typeof p.key !== 'string' || !SLOT_ID.test(p.key) || !p.key.startsWith(`${pluginId}.`) || isProduct(p.key)) bad(`bad prompt key ${p && p.key}`);
    if (seen.has(p.key)) bad(`prompt ${p.key} declared twice`);
    seen.add(p.key);
    if (typeof p.label !== 'string' || !p.label.trim()) bad(`prompt ${p.key} has no label`);
    if (typeof p.defaultPrompt !== 'string' || !p.defaultPrompt.trim() || p.defaultPrompt.length > PROMPT_MAX) bad(`prompt ${p.key} needs a default of 1–${PROMPT_MAX} characters`);
    return { key: p.key, label: p.label, help: typeof p.help === 'string' ? p.help : '', defaultPrompt: p.defaultPrompt };
  });
}

function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }

/**
 * @test-only the factory exists so tests build an isolated wrapper with their own config, env
 * and fetch; production uses the process singleton `ai` below.
 */
export function createAi({
  config = instanceConfig,
  env = null,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  notify = notifyOps,
  log = console,
} = {}) {
  const envOf = () => env || process.env;
  const slots = Object.fromEntries(AI_ADAPTER.PRODUCT_SLOTS.map((s) => [s.id, { ...s }]));
  const pins = {};
  const plugins = new Map();   // pluginId → { providesBot, locks: {slotId: reason} }
  const usage = new Map();     // `${day}|${slot}|${conn}|${model}` → counts
  const health = new Map();    // slotId → health record (adapter nextHealth), reported to stream-api

  /** A plugin's slots. Declarations carry `envModel` (env names, first non-empty wins) with
   *  `envConnection`, and a `defaultRoute` — the plugin's own mechanisms for keeping an
   *  install's models. A product slot id is refused. */
  function registerSlots(pluginId, declarations, { providesBot = null, locks = null } = {}) {
    if (!PLUGIN_ID.test(pluginId)) throw new Error(`ai.registerSlots: bad plugin id ${pluginId}`);
    for (const d of declarations || []) {
      if (!d || !SLOT_ID.test(d.id || '') || isProduct(d.id) || !['chat', 'embed'].includes(d.kind) || !d.label) {
        throw new Error(`ai.registerSlots(${pluginId}): refused slot ${d && d.id} (bad shape, or a product slot id)`);
      }
      const prompts = checkPrompts(pluginId, d.id, d.prompts);
      slots[d.id] = { ...d, owner: `plugin:${pluginId}`, needs: (d.needs || []).filter((n) => NEEDS.includes(n)), ...(prompts ? { prompts } : {}) };
    }
    plugins.set(pluginId, { providesBot: providesBot || null, locks: locks && typeof locks === 'object' ? { ...locks } : {} });
  }

  /** A plugin keeps an env pin on a PRODUCT slot: an install that sets that env keeps it. */
  function pinProductSlot(slotId, envNames, connection) {
    if (!isProduct(slotId)) throw new Error(`ai.pinProductSlot: ${slotId} is not a product slot`);
    pins[slotId] = { env: [...envNames], connection };
  }

  function cfg() {
    return {
      mode: config.get('ai.mode'), default: config.get('ai.default'), connections: config.get('ai.connections'),
      tasks: config.get('ai.tasks'), embeddings: config.get('ai.embeddings'),
    };
  }

  /** The route a slot runs on right now. A multi-round pass resolves once and reuses it. */
  function route(slotId) {
    return AI_ADAPTER.resolveRoute(slotId, cfg(), envOf(), { slots, pins });
  }

  function deps() {
    return { fetchImpl, getSecret: (name) => { try { return config.get(name); } catch { return null; } }, now };
  }

  /** Health per slot, and ONE ops alert per failure episode: a hard code at once,
   *  anything else after a run. Ids, codes and the model name only — it rides to a lock screen. */
  function track(r, outcome) {
    const { health: h, alert } = AI_ADAPTER.nextHealth(health.get(r.slot) || null, outcome, new Date(now()).toISOString());
    health.set(r.slot, h);
    // The embedder's failures already raise memory's own ONE alarm and pause.
    if (!alert || (slots[r.slot] && slots[r.slot].kind === 'embed')) return;
    const label = (slots[r.slot] && slots[r.slot].label) || r.slot;
    const what = alert === 'failing' ? `${h.consecutive} consecutive failures (last: ${h.lastCode})` : alert;
    log.warn(`[ai] ${r.slot} failing on ${r.connection.id}/${r.model}: ${what}`);
    notify(`ai.${r.slot}.failing`, `AI task failing: ${label}`, `stream-ingest: ${r.slot} on ${r.connection.id}/${r.model} — ${what}. See the AI page.`);
  }

  function count(r, ok, u, code = null) {
    if (!r || !r.enabled) return;
    track(r, ok ? { ok: true } : { ok: false, code });
    const k = `${dayOf(now())}|${r.slot}|${r.connection.id}|${r.model}`;
    const c = usage.get(k) || { calls: 0, errors: 0, unchecked: 0, in: 0, out: 0 };
    c.calls++;
    if (!ok) c.errors++;
    if (u) { c.in += u.in || 0; c.out += u.out || 0; }
    usage.set(k, c);
  }

  /** A check that let its message through unjudged (automod's fail-open, or a shed message):
   *  counted as `unchecked` on the slot's current route. */
  function noteUnchecked(slotId) {
    const r = route(slotId);
    if (!r.enabled) return;
    const k = `${dayOf(now())}|${r.slot}|${r.connection.id}|${r.model}`;
    const c = usage.get(k) || { calls: 0, errors: 0, unchecked: 0, in: 0, out: 0 };
    c.unchecked++;
    usage.set(k, c);
  }

  /** One chat call on a slot id or a resolved route. Rejects with an AiError (`.code`). */
  async function chat(slotOrRoute, req) {
    const r = typeof slotOrRoute === 'string' ? route(slotOrRoute) : slotOrRoute;
    try {
      const out = await AI_ADAPTER.chat(r, req, deps());
      count(r, true, out.usage);
      return out;
    } catch (e) {
      if (!(e && e.code === 'aborted')) count(r, false, null, e && e.code);
      throw e;
    }
  }

  /** Embed on the product `embeddings` slot (or a given route). */
  async function embed(texts, opts = {}) {
    const r = opts.route || route('embeddings');
    try {
      const out = await AI_ADAPTER.embed(r, texts, opts, deps());
      count(r, true, out.usage);
      return out;
    } catch (e) {
      if (!(e && e.code === 'aborted')) count(r, false, null, e && e.code);
      throw e;
    }
  }

  function providesBot() {
    for (const p of plugins.values()) if (p.providesBot) return p.providesBot;
    return null;
  }

  /** The AI part of this process's settings report: plugin slots, every slot's route, usage since
   *  the last report, which product slots a plugin locks. `requeue` puts the usage back when the
   *  report did not land. */
  function report() {
    const rows = [...usage.entries()].map(([k, c]) => {
      const [day, slot, connection, model] = k.split('|');
      return { day, slot, connection, model, ...c };
    });
    usage.clear();
    const routes = {};
    for (const id of Object.keys(slots)) {
      const r = route(id);
      routes[id] = r.enabled
        ? { enabled: true, connection: r.connection.id, model: r.model, source: r.source, envName: r.envName }
        : { enabled: false, reason: r.reason };
    }
    const locks = {};
    for (const p of plugins.values()) Object.assign(locks, p.locks);
    const body = {
      slots: Object.values(slots).filter((s) => s.owner !== 'product').map((s) => ({
        id: s.id, kind: s.kind, owner: s.owner, needs: s.needs, label: s.label, description: s.description || '',
        envModel: s.envModel, envConnection: s.envConnection, defaultRoute: s.defaultRoute,
        ...(s.prompts ? { prompts: s.prompts } : {}),
      })),
      routes, locks, providesBot: providesBot(), usage: rows,
      ...Object.fromEntries([...parts].map(([n, fn]) => { try { return [n, fn()]; } catch { return [n, null]; } })),
      health: Object.fromEntries([...health].map(([id, h]) => [id, { consecutive: h.consecutive, failingSince: h.failingSince, lastCode: h.lastCode, lastOkAt: h.lastOkAt }])),
    };
    const requeue = () => {
      for (const r of rows) {
        const k = `${r.day}|${r.slot}|${r.connection}|${r.model}`;
        const c = usage.get(k) || { calls: 0, errors: 0, unchecked: 0, in: 0, out: 0 };
        for (const f of ['calls', 'errors', 'unchecked', 'in', 'out']) c[f] += r[f];
        usage.set(k, c);
      }
    };
    return { body, requeue };
  }

  function hasUsage() { return usage.size > 0; }

  // A product module's own line in the report (the chat bot: where it can speak, its counts).
  const parts = new Map();
  function setReportPart(name, fn) { parts.set(name, fn); }

  /** The AI page's Detect / Test, run in this process (stream-api asks over the internal socket:
   *  this process holds the keys and runs the tasks). */
  function runCheck(op, id, opts = {}) {
    const conns = config.get('ai.connections');
    const conn = op === 'test' ? null : AI_ADAPTER.findConnection(id, Array.isArray(conns) ? conns : []);
    if (op === 'embed') return AI_ADAPTER.runCheck('embed', conn ? AI_ADAPTER.candidateEmbedRoute(conn, opts.model) : null, deps(), { dimensions: opts.dimensions });
    return AI_ADAPTER.runCheck(op, op === 'detect' ? conn : route(id), deps());
  }

  return { registerSlots, pinProductSlot, route, chat, embed, report, hasUsage, providesBot, runCheck, setReportPart, noteUnchecked };
}

/** The process singleton every stream-ingest module calls through. */
export const ai = createAi();

/** Ride the settings layer's report, and send one a minute while there is usage to send. */
export function startAiReporting(cfg = instanceConfig, wrapper = ai) {
  cfg.setProbeHandler((op, id, opts) => wrapper.runCheck(op, id, opts));
  cfg.setReportExtra(() => {
    const { body, requeue } = wrapper.report();
    return { extra: { ai: body }, onFailure: requeue };
  });
  const timer = setInterval(() => { if (wrapper.hasUsage()) cfg.reportNow(); }, USAGE_EVERY_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
