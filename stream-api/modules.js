// The module switches, as stream-api acts on them (config/modules.mjs).
//
// A module is started once, on the settings layer's FIRST SUCCESSFUL load — never at require time,
// and never on env + defaults alone: a slow first query must not boot the owner's install with
// OBS off. Switches apply at the next restart (`reload: 'restart'`), and by config/modules.mjs's
// ONE RULE this process's start is when they apply EVERYWHERE: the website shows a module that
// stream-api serves (the radio) from what this process runs — its GET /config `self` — not from
// the saved switch.
//
// Routes of a module go on the Router this returns, which index.js mounts at the module's place —
// so a route registered after boot still sits before the error handler.

'use strict';
const express = require('express');
const { MODULES: ALL_MODULES } = require('./instanceSchema.generated.js');

// The manifests stream-api acts on. A module only the website or the ingest service reads (e.g.
// youtube, stripe, paypal) owns nothing here — no starter, no routes, no boot-line entry.
const MODULES = ALL_MODULES.filter((m) => m.packages.includes('stream-api'));

/**
 * @param {object} o
 * @param {{ get(key: string): any, loaded: Promise<unknown> }} o.instanceConfig
 * @param {Record<string, (ctx: { router: import('express').Router }) => void>} o.starters  the product's, by manifest id
 * @param {Record<string, (ctx: { router: import('express').Router }) => void>} [o.ownerStarters]  the owner plugin's
 *
 * Every product module ('module' kind) needs a product starter. An owner-only module ('owner'
 * kind) is started by whichever side provides it; with no starter at all it is NOT INSTALLED —
 * the public build, which has no owner folder. Its switch is then ignored.
 */
function createModules({ instanceConfig, starters, ownerStarters = {}, log = console }) {
  const router = express.Router();
  const running = new Set();
  const all = { ...ownerStarters, ...starters };
  for (const id of Object.keys(starters)) {
    if (id in ownerStarters) throw new Error(`module ${id} is started by both the product and the owner plugin`);
  }
  for (const m of MODULES) {
    if (m.kind !== 'owner' && typeof starters[m.id] !== 'function') throw new Error(`no starter for module ${m.id}`);
  }
  for (const id of Object.keys(all)) {
    if (!MODULES.some((m) => m.id === id)) throw new Error(`starter for unknown module ${id}`);
    if (typeof all[id] !== 'function') throw new Error(`starter for module ${id} is not a function`);
  }
  const installed = (m) => typeof all[m.id] === 'function';

  const isOn = (id) => instanceConfig.get(`modules.${id}`) === true;

  function startAll() {
    for (const m of MODULES) {
      if (!installed(m) || !isOn(m.id)) continue;
      try { all[m.id]({ router }); running.add(m.id); }
      catch (e) { log.error(`[modules] ${m.id} failed to start: ${e && e.message}`); }
    }
    const on = MODULES.filter((m) => running.has(m.id)).map((m) => m.id);
    const off = MODULES.filter((m) => installed(m) && !running.has(m.id)).map((m) => m.id);
    const absent = MODULES.filter((m) => !installed(m)).map((m) => m.id);
    log.log(`[modules] on: ${on.join(', ') || '—'} · off: ${off.join(', ') || '—'}${absent.length ? ` · not installed: ${absent.join(', ')}` : ''}`);
  }

  /** Start every switched-on module once the settings have loaded. Resolves when done. */
  const started = instanceConfig.loaded.then(startAll);

  return { router, started, running: (id) => running.has(id) };
}

module.exports = { createModules, STREAM_API_MODULES: MODULES };
