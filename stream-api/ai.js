'use strict';
// stream-api's AI wrapper — the slot registry, live route resolution, usage counting, and the
// AI-routing view (GET /ai/routes).
//
// The adapter itself (./aiAdapter.generated.js, generated from config/ai-adapter.mjs) is pure.
// What lives here is state:
//   • the registry: the product's slots, plus any a plugin in THIS process registers (a plugin
//     never registers a product slot id);
//   • the config snapshot, read from the settings layer at CALL time — a route or key edit
//     applies on the next call, with no restart;
//   • usage counts, flushed into site.ai_usage once a minute;
//   • what stream-ingest last reported about ITS slots and routes (it resolves its own env pins,
//     which this process cannot see), for GET /ai/routes.

const { AI_ADAPTER } = require('./aiAdapter.generated.js');

const SLOT_ID = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){0,3}$/;
const PLUGIN_ID = /^[a-z0-9-]{1,24}$/;
const NEEDS = ['tools', 'serverWebSearch', 'vision', 'json'];
const SLUG = /^[a-z0-9-]{1,24}$/;
const MODEL = /^[\w.:/@-]{1,128}$/;
const NOT_RUNNING_MS = 10 * 60_000;
const FLUSH_MS = 60_000;
const REASONS = ['off', 'not_configured', 'needs_unmet', 'unknown_slot'];
const SOURCES = ['env', 'db', 'default'];

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const PROMPT_MAX = 16000;

/** A plugin slot's declared prompts (content keys `prompt.<key>`), reduced to their fixed shape.
 *  A key must sit under the plugin's own id and may not be a product slot id; anything else is
 *  dropped. The default is kept byte-exact — it is what the page shows as "default". */
function cleanPrompts(list, owner) {
  const pluginId = /^plugin:([a-z0-9-]{1,24})$/.exec(owner || '');
  if (!pluginId || !Array.isArray(list)) return [];
  const out = [];
  for (const p of list.slice(0, 16)) {
    if (!p || typeof p !== 'object' || typeof p.key !== 'string' || p.key.length > 64) continue;
    if (!SLOT_ID.test(p.key) || !p.key.startsWith(`${pluginId[1]}.`)) continue;
    if (AI_ADAPTER.PRODUCT_SLOTS.some((x) => x.id === p.key) || out.some((x) => x.key === p.key)) continue;
    const label = str(p.label, 80);
    if (!label || typeof p.defaultPrompt !== 'string' || !p.defaultPrompt.trim() || p.defaultPrompt.length > PROMPT_MAX) continue;
    out.push({ key: p.key, label, help: str(p.help, 300) || '', defaultPrompt: p.defaultPrompt });
  }
  return out;
}

/** A slot declaration reduced to its fixed shape, or null. Used for this process's plugins and
 *  for what another process reports — a buggy or forged report cannot store anything else. */
function cleanDeclaration(d, owner) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !SLOT_ID.test(d.id) || d.id.length > 64) return null;
  if (AI_ADAPTER.PRODUCT_SLOTS.some((p) => p.id === d.id)) return null;
  if (!['chat', 'embed'].includes(d.kind)) return null;
  const label = str(d.label, 80);
  if (!label) return null;
  const envNames = (n) => (Array.isArray(n) ? n.filter((x) => typeof x === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(x)).slice(0, 4) : undefined);
  const route = (r) => (r && SLUG.test(r.connection) && MODEL.test(r.model) ? { connection: r.connection, model: r.model } : undefined);
  const out = {
    id: d.id, kind: d.kind, owner,
    needs: (Array.isArray(d.needs) ? d.needs : []).filter((n) => NEEDS.includes(n)),
    label, description: str(d.description, 300) || '',
  };
  const em = envNames(d.envModel);
  if (em && em.length) out.envModel = em;
  if (typeof d.envConnection === 'string' && SLUG.test(d.envConnection)) out.envConnection = d.envConnection;
  const dr = route(d.defaultRoute);
  if (dr) out.defaultRoute = dr;
  for (const k of ['maxTokens', 'timeoutMs', 'retries']) if (Number.isInteger(d[k]) && d[k] >= 0 && d[k] <= 600000) out[k] = d[k];
  const prompts = cleanPrompts(d.prompts, owner);
  if (prompts.length) out.prompts = prompts;
  return out;
}

/** A resolved route as the page may see it: ids, model, source — never a key or a URL. */
function routeSummary(r) {
  if (!r || typeof r !== 'object') return null;
  if (!r.enabled) return { enabled: false, reason: REASONS.includes(r.reason) ? r.reason : 'not_configured' };
  const connection = typeof r.connection === 'string' ? r.connection : r.connection && r.connection.id;
  if (!SLUG.test(connection || '') || !MODEL.test(r.model || '')) return { enabled: false, reason: 'not_configured' };
  return {
    enabled: true, connection, model: r.model,
    source: SOURCES.includes(r.source) ? r.source : 'db',
    envName: typeof r.envName === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(r.envName) ? r.envName : null,
  };
}

/** A health record as another process reports it, reduced to its fixed shape (or null). */
function cleanHealth(h) {
  if (!h || typeof h !== 'object' || !Number.isInteger(h.consecutive) || h.consecutive < 0 || h.consecutive > 1e9) return null;
  const iso = (v) => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  return {
    consecutive: h.consecutive,
    failingSince: iso(h.failingSince),
    lastCode: AI_ADAPTER.ERROR_CODES.includes(h.lastCode) ? h.lastCode : null,
    lastOkAt: iso(h.lastOkAt),
  };
}

/** The chat bot's line in stream-ingest's report: where it can speak, and its counts. */
function cleanBotReport(b) {
  if (!b || typeof b !== 'object') return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 && v <= 1e9 ? v : 0);
  const so = b.speakOn && typeof b.speakOn === 'object' ? b.speakOn : {};
  const login = typeof so.twitch === 'string' && /^[a-z0-9_]{1,25}$/.test(so.twitch) ? so.twitch : null;
  return { speakOn: { site: so.site === true, twitch: login }, replies: n(b.replies), skippedUnlinked: n(b.skippedUnlinked), screened: n(b.screened), failed: n(b.failed), cooldown: n(b.cooldown) };
}

/** A health record as the page sees it: the record plus the chip's word. */
function healthView(h) {
  if (!h) return null;
  return { status: AI_ADAPTER.healthStatus(h), consecutive: h.consecutive, failingSince: h.failingSince, lastCode: h.lastCode, lastOkAt: h.lastOkAt };
}

function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }

/**
 * @test-only the factory exists so tests build an isolated wrapper with their own config, env,
 * fetch and pool; production uses the process singleton `ai` below.
 */
function createAi({
  config = () => require('./instance-config').instanceConfig,
  env = null,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  log = console,
  notify = (...a) => require('./notify.js').notify(...a),
} = {}) {
  const ic = () => (typeof config === 'function' ? config() : config);
  const envOf = () => env || process.env;
  const slots = Object.fromEntries(AI_ADAPTER.PRODUCT_SLOTS.map((s) => [s.id, { ...s }]));
  const pins = {};
  const plugins = new Map();     // pluginId → { providesBot, locksSlot, forget? }
  const usage = new Map();       // `${day}|${slot}|${conn}|${model}` → counts
  const reported = new Map();    // package → { at, slots: [...], routes: {slotId: summary}, providesBot, locks, health }
  const health = new Map();      // slotId → this process's health record (adapter nextHealth)
  let pool = null;
  let memoryStats = null;        // () => Promise<object> — memory.js stats(), wired by start()
  let flushTimer = null;

  function registerSlots(pluginId, declarations, { providesBot = null, locksSlot = null } = {}) {
    if (!PLUGIN_ID.test(pluginId)) throw new Error(`ai.registerSlots: bad plugin id ${pluginId}`);
    for (const d of declarations || []) {
      const clean = cleanDeclaration(d, `plugin:${pluginId}`);
      if (!clean) throw new Error(`ai.registerSlots(${pluginId}): refused slot ${d && d.id} (bad shape, or a product slot id)`);
      slots[clean.id] = clean;
    }
    plugins.set(pluginId, { providesBot: str(providesBot, 80), locksSlot: typeof locksSlot === 'string' ? locksSlot : null });
  }

  /** A plugin keeps an env pin on a PRODUCT slot: an install that sets it keeps it. */
  function pinProductSlot(slotId, envNames, connection) {
    if (!AI_ADAPTER.PRODUCT_SLOTS.some((p) => p.id === slotId)) throw new Error(`ai.pinProductSlot: ${slotId} is not a product slot`);
    pins[slotId] = { env: [...envNames], connection };
  }

  function cfg() {
    const c = ic();
    return {
      mode: c.get('ai.mode'), default: c.get('ai.default'), connections: c.get('ai.connections'),
      tasks: c.get('ai.tasks'), embeddings: c.get('ai.embeddings'),
    };
  }

  function route(slotId) {
    return AI_ADAPTER.resolveRoute(slotId, cfg(), envOf(), { slots, pins });
  }

  function deps() {
    return { fetchImpl, getSecret: (name) => { try { return ic().get(name); } catch { return null; } }, now };
  }

  function count(r, { ok, usage: u, unchecked = false, code: errCode = null }) {
    if (!r || !r.enabled) return;
    const k = `${dayOf(now())}|${r.slot}|${r.connection.id}|${r.model}`;
    const c = usage.get(k) || { calls: 0, errors: 0, unchecked: 0, in: 0, out: 0 };
    c.calls++;
    if (!ok) c.errors++;
    if (unchecked) c.unchecked++;
    if (u) { c.in += u.in || 0; c.out += u.out || 0; }
    usage.set(k, c);
    track(r, ok ? { ok: true } : { ok: false, code: errCode });
  }

  /** Health per slot, and ONE ops alert per failure episode: a hard code (key
   *  rejected, out of credit, model gone) at once, anything else after a run. Ids, codes and the
   *  model name only — the alert rides to a lock screen. */
  function track(r, outcome) {
    const { health: h, alert } = AI_ADAPTER.nextHealth(health.get(r.slot) || null, outcome, new Date(now()).toISOString());
    health.set(r.slot, h);
    // The embedder's failures already raise memory's own ONE alarm and pause.
    if (!alert || (slots[r.slot] && slots[r.slot].kind === 'embed')) return;
    const label = (slots[r.slot] && slots[r.slot].label) || r.slot;
    const what = alert === 'failing' ? `${h.consecutive} consecutive failures (last: ${h.lastCode})` : alert;
    log.warn(`[ai] ${r.slot} failing on ${r.connection.id}/${r.model}: ${what}`);
    notify(`ai.${r.slot}.failing`, `AI task failing: ${label}`, `stream-api: ${r.slot} on ${r.connection.id}/${r.model} — ${what}. See the AI page.`);
  }

  /** A check that was skipped or failed and let its message through (automod's fail-open):
   *  counted as `unchecked` on the slot's current route, beside its calls and errors. */
  function noteUnchecked(slotId) {
    const r = route(slotId);
    if (!r.enabled) return;
    const k = `${dayOf(now())}|${r.slot}|${r.connection.id}|${r.model}`;
    const c = usage.get(k) || { calls: 0, errors: 0, unchecked: 0, in: 0, out: 0 };
    c.unchecked++;
    usage.set(k, c);
  }

  /** One chat call on a slot (or on a route resolved once for a multi-round pass). */
  async function chat(slotOrRoute, req) {
    const r = typeof slotOrRoute === 'string' ? route(slotOrRoute) : slotOrRoute;
    try {
      const out = await AI_ADAPTER.chat(r, req, deps());
      count(r, { ok: true, usage: out.usage });
      return out;
    } catch (e) {
      if (!(e && e.code === 'aborted')) count(r, { ok: false, code: e && e.code });
      throw e;
    }
  }

  async function embed(texts, opts = {}) {
    const r = opts.route || route('embeddings');
    try {
      const out = await AI_ADAPTER.embed(r, texts, opts, deps());
      count(r, { ok: true, usage: out.usage });
      return out;
    } catch (e) {
      if (!(e && e.code === 'aborted')) count(r, { ok: false, code: e && e.code });
      throw e;
    }
  }

  // ── what other processes report (riding POST /config/report) ─────────────────────────────
  /** Sanitise and keep another package's AI report; upsert its plugin slots and usage. */
  async function acceptReport(pkg, body) {
    if (!body || typeof body !== 'object') return;
    const cleanSlots = (Array.isArray(body.slots) ? body.slots : []).slice(0, 64).map((d) => {
      const owner = typeof d?.owner === 'string' && /^plugin:[a-z0-9-]{1,24}$/.test(d.owner) ? d.owner : null;
      return owner ? cleanDeclaration(d, owner) : null;
    }).filter(Boolean);
    const routes = {};
    if (body.routes && typeof body.routes === 'object') {
      for (const [id, r] of Object.entries(body.routes).slice(0, 80)) {
        if (SLOT_ID.test(id)) routes[id] = routeSummary(r);
      }
    }
    const locks = {};
    if (body.locks && typeof body.locks === 'object') {
      for (const [id, by] of Object.entries(body.locks).slice(0, 8)) if (SLOT_ID.test(id)) locks[id] = str(by, 200);
    }
    const hl = {};
    if (body.health && typeof body.health === 'object') {
      for (const [id, h] of Object.entries(body.health).slice(0, 80)) if (SLOT_ID.test(id)) { const c = cleanHealth(h); if (c) hl[id] = c; }
    }
    reported.set(pkg, { at: now(), slots: cleanSlots, routes, locks, health: hl, providesBot: str(body.providesBot, 80), bot: cleanBotReport(body.bot) });
    if (pool) {
      await upsertSlots(pkg, cleanSlots, str(body.providesBot, 80));
      await addUsage((Array.isArray(body.usage) ? body.usage : []).slice(0, 500));
    }
  }

  async function upsertSlots(pkg, list, providesBot) {
    for (const s of list) {
      await pool.query(
        `INSERT INTO site.ai_slots (slot_id, package, owner, kind, needs, label, description, provides_bot, last_reported_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (slot_id) DO UPDATE SET package = EXCLUDED.package, owner = EXCLUDED.owner, kind = EXCLUDED.kind,
           needs = EXCLUDED.needs, label = EXCLUDED.label, description = EXCLUDED.description,
           provides_bot = EXCLUDED.provides_bot, last_reported_at = now()`,
        [s.id, pkg, s.owner, s.kind, s.needs, s.label, s.description, providesBot]);
    }
  }

  function usageRows() {
    return [...usage.entries()].map(([k, c]) => {
      const [day, slot, connection, model] = k.split('|');
      return { day, slot, connection, model, calls: c.calls, errors: c.errors, unchecked: c.unchecked, in: c.in, out: c.out };
    });
  }

  async function addUsage(rows) {
    const today = now();
    for (const r of rows) {
      if (!r || !SLOT_ID.test(r.slot || '') || !SLUG.test(r.connection || '') || !MODEL.test(r.model || '')) continue;
      if (typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || Math.abs(Date.parse(r.day) - today) > 2 * 86400_000) continue;
      const n = (v) => (Number.isInteger(v) && v >= 0 && v <= 1e9 ? v : 0);
      await pool.query(
        `INSERT INTO site.ai_usage (day, slot_id, connection_id, model, calls, errors, unchecked, tokens_in, tokens_out)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (day, slot_id, connection_id, model) DO UPDATE SET
           calls = site.ai_usage.calls + EXCLUDED.calls, errors = site.ai_usage.errors + EXCLUDED.errors,
           unchecked = site.ai_usage.unchecked + EXCLUDED.unchecked,
           tokens_in = site.ai_usage.tokens_in + EXCLUDED.tokens_in, tokens_out = site.ai_usage.tokens_out + EXCLUDED.tokens_out`,
        [r.day, r.slot, r.connection, r.model, n(r.calls), n(r.errors), n(r.unchecked), n(r.in), n(r.out)]);
    }
  }

  /** This process's own counts → site.ai_usage. A failed write keeps them for the next flush. */
  async function flush() {
    if (!pool || !usage.size) return;
    const rows = usageRows();
    usage.clear();
    try { await addUsage(rows); } catch (e) {
      log.warn(`[ai] usage flush failed: ${e.message} — kept for the next one`);
      for (const r of rows) {
        const k = `${r.day}|${r.slot}|${r.connection}|${r.model}`;
        const c = usage.get(k) || { calls: 0, errors: 0, unchecked: 0, in: 0, out: 0 };
        c.calls += r.calls; c.errors += r.errors; c.unchecked += r.unchecked; c.in += r.in; c.out += r.out;
        usage.set(k, c);
      }
    }
  }

  /** Wire the pool, record this process's plugin slots, start the usage flush. */
  async function start(deps0) {
    pool = deps0.pool;
    if (typeof deps0.memoryStats === 'function') memoryStats = deps0.memoryStats;
    const mine = Object.values(slots).filter((s) => s.owner !== 'product');
    try {
      for (const [id, p] of plugins) {
        await upsertSlots('stream-api', mine.filter((s) => s.owner === `plugin:${id}`), p.providesBot);
      }
    } catch (e) { log.warn(`[ai] could not record this process's slots: ${e.message}`); }
    flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
    flushTimer.unref?.();
  }

  async function stop() {
    if (flushTimer) clearInterval(flushTimer);
    await flush().catch(() => {});
  }

  /** GET /ai/routes — every slot, its route in each process that runs it, and whether that
   *  process is reporting. Ids, models and sources only; never a key or an endpoint. */
  async function routesView() {
    const selfRoutes = Object.fromEntries(Object.keys(slots).map((id) => [id, routeSummary(route(id))]));
    let rows = [];
    if (pool) rows = (await pool.query(`SELECT slot_id, package, owner, kind, needs, label, description, provides_bot, last_reported_at FROM site.ai_slots ORDER BY slot_id`)).rows;
    const ingest = reported.get('stream-ingest');
    const t = now();
    const selfHealth = (id) => healthView(health.get(id) ? cleanHealth(health.get(id)) : null);
    const ingestHealth = (id) => healthView(ingest && ingest.health ? ingest.health[id] || null : null);
    const out = AI_ADAPTER.PRODUCT_SLOTS.map((s) => ({
      id: s.id, kind: s.kind, owner: 'product', label: s.label, description: s.description, needs: s.needs,
      defaultPrompt: s.defaultPrompt || null,
      routes: { 'stream-api': selfRoutes[s.id], 'stream-ingest': ingest ? ingest.routes[s.id] || null : null },
      health: { 'stream-api': selfHealth(s.id), 'stream-ingest': ingestHealth(s.id) },
      lockedBy: (ingest && ingest.locks[s.id]) || null,
    }));
    for (const r of rows) {
      const fromSelf = r.package === 'stream-api';
      const at = fromSelf ? t : ingest && r.package === 'stream-ingest' ? ingest.at : new Date(r.last_reported_at).getTime();
      const decl = fromSelf ? slots[r.slot_id] : ingest && r.package === 'stream-ingest' ? ingest.slots.find((x) => x.id === r.slot_id) : null;
      out.push({
        id: r.slot_id, kind: r.kind, owner: r.owner, package: r.package, label: r.label, description: r.description, needs: r.needs,
        ...(decl && decl.prompts ? { prompts: decl.prompts } : {}),
        routes: { [r.package]: fromSelf ? selfRoutes[r.slot_id] || null : (ingest && r.package === 'stream-ingest' ? ingest.routes[r.slot_id] || null : null) },
        health: { [r.package]: fromSelf ? selfHealth(r.slot_id) : r.package === 'stream-ingest' ? ingestHealth(r.slot_id) : null },
        lastReportedAt: new Date(r.last_reported_at).toISOString(),
        running: t - at < NOT_RUNNING_MS,
      });
    }
    return {
      slots: out,
      usage: await usageToday(),
      memory: memoryStats ? await memoryStats().catch((e) => ({ error: `could not read the store: ${e.message.slice(0, 120)}` })) : null,
      providesBot: (ingest && ingest.providesBot) || [...plugins.values()].map((p) => p.providesBot).find(Boolean) || null,
      bot: (ingest && ingest.bot) || null,
      reportedAt: ingest ? new Date(ingest.at).toISOString() : null,
    };
  }

  /** Today's (UTC) calls per slot, every process and model summed — the stored rows plus this
   *  process's counts not yet flushed. */
  async function usageToday() {
    const day = dayOf(now());
    const by = {};
    const add = (slot, c) => {
      const u = by[slot] || (by[slot] = { calls: 0, errors: 0, unchecked: 0, tokensIn: 0, tokensOut: 0 });
      u.calls += Number(c.calls) || 0; u.errors += Number(c.errors) || 0; u.unchecked += Number(c.unchecked) || 0;
      u.tokensIn += Number(c.in) || 0; u.tokensOut += Number(c.out) || 0;
    };
    if (pool) {
      const { rows } = await pool.query(
        `SELECT slot_id, sum(calls)::bigint AS calls, sum(errors)::bigint AS errors, sum(unchecked)::bigint AS unchecked,
                sum(tokens_in)::bigint AS "in", sum(tokens_out)::bigint AS out
           FROM site.ai_usage WHERE day = $1 GROUP BY slot_id`, [day]);
      for (const r of rows) add(r.slot_id, r);
    }
    for (const r of usageRows()) if (r.day === day) add(r.slot, r);
    return { day, slots: by };
  }

  // ── edits: what a write MEANS (the settings layer checks the shape) ─────────────────────
  const BUILTIN_IDS = AI_ADAPTER.BUILTIN_CONNECTIONS.map((c) => c.id);
  const customConnections = () => { const v = ic().get('ai.connections'); return Array.isArray(v) ? v : []; };
  const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

  /** A slot this install knows: a product slot, one registered in this process, one stream-ingest
   *  reported, or one recorded in site.ai_slots. `{kind, needs, owner, package}` or null. */
  async function slotInfo(id) {
    if (!SLOT_ID.test(id || '')) return null;
    if (slots[id]) return { kind: slots[id].kind, needs: slots[id].needs || [], owner: slots[id].owner, package: 'stream-api' };
    const ingest = reported.get('stream-ingest');
    const rep = ingest && ingest.slots.find((x) => x.id === id);
    if (rep) return { kind: rep.kind, needs: rep.needs, owner: rep.owner, package: 'stream-ingest' };
    if (!pool) return null;
    const { rows } = await pool.query('SELECT kind, needs, owner, package FROM site.ai_slots WHERE slot_id = $1', [id]);
    return rows[0] ? { kind: rows[0].kind, needs: rows[0].needs || [], owner: rows[0].owner, package: rows[0].package } : null;
  }

  /** A prompt a running plugin declared (`prompt.<key>` is then a content key this install
   *  uses): in this process's registry or in stream-ingest's last report. */
  function promptKnown(key) {
    const has = (list) => list.some((s) => Array.isArray(s.prompts) && s.prompts.some((p) => p.key === key));
    if (has(Object.values(slots))) return true;
    const ingest = reported.get('stream-ingest');
    return !!ingest && has(ingest.slots);
  }

  /** Where a connection is in use: the default, a task, the embedder. */
  function usesOf(id) {
    const c = ic();
    const out = [];
    const d = c.get('ai.default');
    if (d && d.connection === id) out.push('the default model');
    const t = c.get('ai.tasks') || {};
    for (const [slot, task] of Object.entries(t)) if (task && task.connection === id) out.push(slot);
    const e = c.get('ai.embeddings');
    if (e && e.connection === id) out.push('memory');
    return out;
  }

  /**
   * The settings layer's write guard for the AI keys. `value` is
   * the parsed value, or undefined for a clear. Returns null (fine), `{error}` (refused), or
   * `{clearSecrets}` (keys that no longer belong to anything, deleted in the same transaction).
   */
  async function writeGuard(key, value) {
    const conns = customConnections();
    const exists = (id) => BUILTIN_IDS.includes(id) || conns.some((x) => x.id === id);
    if (key === 'ai.default') {
      if (value !== undefined && !exists(value.connection)) return { error: `ai.default: there is no connection "${value.connection}"` };
      return null;
    }
    if (key === 'ai.embeddings') return { error: 'the memory embedder is changed through the memory panel, not by an edit' };
    if (key === 'ai.tasks') {
      for (const [id, t] of Object.entries(value || {})) {
        const info = await slotInfo(id);
        if (!info) return { error: `ai.tasks: there is no task "${id}" on this install` };
        if (info.kind === 'embed') return { error: `ai.tasks: ${id} is the memory embedder — it is set in the memory panel` };
        if (!t.connection) continue;
        if (!exists(t.connection)) return { error: `ai.tasks: ${id}: there is no connection "${t.connection}"` };
        if (info.needs.includes('serverWebSearch') && t.connection !== 'anthropic') {
          return { error: `ai.tasks: ${id} needs server web search, which only the Anthropic connection has` };
        }
      }
      return null;
    }
    if (key === 'ai.connections') {
      const next = value || [];
      const removed = conns.filter((o) => !next.some((n) => n.id === o.id));
      for (const o of removed) {
        const uses = usesOf(o.id);
        if (uses.length) return { error: `connection "${o.id}" is still used by ${uses.join(', ')} — move those first` };
      }
      const moved = conns.filter((o) => next.some((n) => n.id === o.id && originOf(n.baseUrl) !== originOf(o.baseUrl)));
      return { clearSecrets: [...removed, ...moved].map((o) => `ai.connection.${o.id}.apiKey`) };
    }
    const m = /^ai\.connection\.([a-z0-9-]{1,24})\.apiKey$/.exec(key);
    if (m && value !== undefined && !conns.some((x) => x.id === m[1])) {
      return { error: `there is no connection "${m[1]}" — add the connection first, then its key` };
    }
    return null;
  }

  // ── Detect + Test: run where the keys are ──────────────────────────────────────────────────
  // stream-ingest runs the AI tasks and holds every AI key on a standard install (this process
  // may not hold the OpenAI one), so a check goes there over the internal socket. When it is not
  // connected — or the slot is this process's own — it runs here. The answer is a fixed code,
  // ids and numbers, never provider text, and it says which process answered.
  const lastCheck = new Map();
  const CHECK_COOLDOWN_MS = 3000;
  const MAX_LATENCY = 600_000;

  function cleanProbe(op, raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, code: 'bad_response' };
    const code = raw.code === 'ok' || AI_ADAPTER.ERROR_CODES.includes(raw.code) ? raw.code : 'bad_response';
    const out = { ok: raw.ok === true && code === 'ok', code };
    if (op === 'detect') {
      out.models = (Array.isArray(raw.models) ? raw.models : []).filter((x) => typeof x === 'string' && MODEL.test(x)).slice(0, 500);
    } else {
      if (Number.isInteger(raw.latencyMs) && raw.latencyMs >= 0 && raw.latencyMs <= MAX_LATENCY) out.latencyMs = raw.latencyMs;
      if (Number.isInteger(raw.dim) && raw.dim > 0 && raw.dim <= 100000) out.dim = raw.dim;
    }
    return out;
  }

  /** Run one check in THIS process (the adapter's runCheck on this process's view). */
  function runCheck(op, id) {
    return AI_ADAPTER.runCheck(op, op === 'detect' ? AI_ADAPTER.findConnection(id, customConnections()) : route(id), deps());
  }

  async function check(op, id) {
    const k = `${op}:${id}`;
    if (now() - (lastCheck.get(k) || 0) < CHECK_COOLDOWN_MS) return { status: 429, body: { error: 'checked a moment ago — wait a few seconds' } };
    lastCheck.set(k, now());
    let here = false;
    if (op === 'detect') {
      if (!BUILTIN_IDS.includes(id) && !customConnections().some((c) => c.id === id)) return { status: 404, body: { error: `there is no connection "${id}"` } };
    } else {
      const info = await slotInfo(id);
      if (!info) return { status: 404, body: { error: `there is no task "${id}" on this install` } };
      here = info.package === 'stream-api' && info.owner !== 'product';
    }
    if (!here && typeof ic().ask === 'function') {
      const { delivered, result } = await ic().ask({ type: 'config_ai_probe', op, id });
      if (delivered) {
        if (!result) return { status: 200, body: { package: 'stream-ingest', ok: false, code: 'timeout', unanswered: true } };
        return { status: 200, body: { package: 'stream-ingest', ...cleanProbe(op, result) } };
      }
    }
    return { status: 200, body: { package: 'stream-api', ...cleanProbe(op, await runCheck(op, id)) } };
  }

  /**
   * Probe a candidate embedder (the memory panel): one short string, and the vector's
   * length. Runs in stream-ingest when it is connected (it holds the embedder's key on a
   * standard install), here otherwise. `{package, ok, code, dim?, latencyMs?}`.
   */
  async function probeEmbed(connectionId, model, dimensions) {
    if (!BUILTIN_IDS.includes(connectionId) && !customConnections().some((c) => c.id === connectionId)) {
      return { package: 'stream-api', ok: false, code: 'not_configured' };
    }
    if (typeof ic().ask === 'function') {
      const { delivered, result } = await ic().ask({ type: 'config_ai_probe', op: 'embed', id: connectionId, model, ...(dimensions ? { dimensions } : {}) });
      if (delivered) {
        if (!result) return { package: 'stream-ingest', ok: false, code: 'timeout', unanswered: true };
        return { package: 'stream-ingest', ...cleanProbe('test', result) };
      }
    }
    const conn = AI_ADAPTER.findConnection(connectionId, customConnections());
    const out = await AI_ADAPTER.runCheck('embed', AI_ADAPTER.candidateEmbedRoute(conn, model), deps(), { dimensions });
    return { package: 'stream-api', ...cleanProbe('test', out) };
  }

  /** What a plugin says about a product slot it locks (stream-ingest's report). */
  function lockOf(slotId) {
    const ingest = reported.get('stream-ingest');
    return (ingest && ingest.locks && ingest.locks[slotId]) || null;
  }

  /** Has stream-ingest reported recently? A lock is only known from its report, so a flow a
   *  lock forbids must refuse while it is not — never read silence as "no lock". */
  function ingestReporting() {
    const ingest = reported.get('stream-ingest');
    return !!ingest && now() - ingest.at < NOT_RUNNING_MS;
  }

  function registerAiRoutes(app, { requireSecret, wrap }) {
    app.get('/ai/routes', requireSecret, wrap(async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await routesView());
    }));
    app.post('/ai/detect/:connection', requireSecret, wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const r = await check('detect', String(req.params.connection));
      res.status(r.status).json(r.body);
    }));
    app.post('/ai/test/:slot', requireSecret, wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const r = await check('test', String(req.params.slot));
      res.status(r.status).json(r.body);
    }));
  }

  return {
    registerSlots, pinProductSlot, route, chat, embed, acceptReport, start, stop, flush, routesView, registerAiRoutes, usageRows,
    writeGuard, check, runCheck, slotInfo, promptKnown, probeEmbed, lockOf, ingestReporting, noteUnchecked,
  };
}

/** The process singleton every stream-api module calls through. */
const ai = createAi();

module.exports = { ai, createAi };
