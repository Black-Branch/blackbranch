'use strict';
// Instance CONTENT — the texts an install writes for its AI tasks, kept apart from settings.
//
//   prompt.<slot id>   an override of a chat task's default prompt
//   bot.behavior       the simple chat bot's behavior file (JSON text, validated by its module)
//   helpdesk.facts     the help desk's reference text
//
// This module is the ONE writer of site.instance_content. Every write and clear leaves a row in
// site.instance_history (tier 'content', the old and new body), so a change can be read back and
// undone by hand. Other processes read the whole set through GET /content (bearer secret only:
// a prompt is the install's own text, not public) and re-read on a `config_content_changed`
// frame, which goes to internal sockets only.

const MAX_BODY = 32768;
const PROMPT_MAX = 16000;
const KEY = /^(prompt\.[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){0,3}|bot\.behavior|helpdesk\.facts)$/;

function createContent({ pool, sendInternal = () => 0, log = console, validators = {}, slotKnown = async () => false }) {
  let rows = new Map();   // key → { body, updatedBy, updatedAt }
  let loadedAt = null;

  async function load() {
    const { rows: r } = await pool.query('SELECT key, body, updated_by, updated_at FROM site.instance_content');
    rows = new Map(r.map((x) => [x.key, { body: x.body, updatedBy: x.updated_by, updatedAt: x.updated_at }]));
    loadedAt = Date.now();
    return true;
  }

  /** This process's copy of one body, or null. */
  function get(key) {
    const r = rows.get(key);
    return r ? r.body : null;
  }

  function all() {
    return Object.fromEntries([...rows].map(([k, v]) => [k, { body: v.body, updatedBy: v.updatedBy, updatedAt: v.updatedAt }]));
  }

  /** null when the key may hold this body, else the reason. */
  async function refusal(key, body) {
    if (!KEY.test(key || '')) return `unknown content key ${String(key).slice(0, 80)}`;
    if (typeof body !== 'string') return 'body must be text';
    if (body.length > MAX_BODY) return `at most ${MAX_BODY} characters`;
    if (body.includes('\0')) return 'no NUL characters';
    if (key.startsWith('prompt.')) {
      if (!body.trim()) return 'an empty prompt — use Revert to go back to the default';
      if (body.length > PROMPT_MAX) return `a prompt is at most ${PROMPT_MAX} characters`;
      const slot = key.slice('prompt.'.length);
      if (!(await slotKnown(slot))) return `there is no chat task "${slot}" on this install`;
    }
    const v = validators[key];
    if (v) { const err = v(body); if (err) return err; }
    return null;
  }

  async function write(key, body, updatedBy) {
    if (typeof updatedBy !== 'string' || !updatedBy.trim() || updatedBy.length > 200) return { status: 400, body: { error: 'updatedBy is required' } };
    const why = await refusal(key, body);
    if (why) return { status: 400, body: { error: why } };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const old = await client.query('SELECT body FROM site.instance_content WHERE key = $1 FOR UPDATE', [key]);
      await client.query(
        `INSERT INTO site.instance_content (key, body, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, body, updatedBy.trim()]);
      await client.query(
        `INSERT INTO site.instance_history (key, tier, action, old_value, new_value, updated_by)
         VALUES ($1, 'content', 'set', $2::jsonb, $3::jsonb, $4)`,
        [key, old.rows[0] ? JSON.stringify(old.rows[0].body) : null, JSON.stringify(body), updatedBy.trim()]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return after(key);
  }

  async function clear(key, updatedBy) {
    if (typeof updatedBy !== 'string' || !updatedBy.trim() || updatedBy.length > 200) return { status: 400, body: { error: 'updatedBy is required' } };
    if (!KEY.test(key || '')) return { status: 400, body: { error: `unknown content key ${String(key).slice(0, 80)}` } };
    const client = await pool.connect();
    let removed = 0;
    try {
      await client.query('BEGIN');
      const r = await client.query('DELETE FROM site.instance_content WHERE key = $1 RETURNING body', [key]);
      removed = r.rowCount;
      if (removed) {
        await client.query(
          `INSERT INTO site.instance_history (key, tier, action, old_value, updated_by) VALUES ($1, 'content', 'clear', $2::jsonb, $3)`,
          [key, JSON.stringify(r.rows[0].body), updatedBy.trim()]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (!removed) return { status: 200, body: { ok: true, key, removed: false } };
    const r = await after(key);
    return r.status === 200 ? { status: 200, body: { ok: true, key, removed: true } } : r;
  }

  /** Re-read, then tell the other processes. A failed re-read is the writer's error (the row is
   *  committed, but this process would keep the old body). */
  async function after(key) {
    try { await load(); } catch (e) {
      log.error(`[content] re-read after write failed: ${e.message}`);
      return { status: 500, body: { error: 'saved, but stream-api could not re-read the content — check its journal' } };
    }
    sendInternal({ type: 'config_content_changed', keys: [key] });
    return { status: 200, body: { ok: true, key } };
  }

  function registerContentRoutes(app, { requireSecret, wrap }) {
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    app.get('/content', requireSecret, wrap(async (_req, res) => {
      noStore(res);
      if (loadedAt === null) await load();
      res.json({ content: all() });
    }));
    app.put('/content/:key', requireSecret, wrap(async (req, res) => {
      noStore(res);
      const r = await write(String(req.params.key), req.body?.body, req.body?.updatedBy);
      res.status(r.status).json(r.body);
    }));
    app.delete('/content/:key', requireSecret, wrap(async (req, res) => {
      noStore(res);
      const r = await clear(String(req.params.key), req.body?.updatedBy);
      res.status(r.status).json(r.body);
    }));
  }

  return { load, get, all, write, clear, registerContentRoutes };
}

module.exports = { createContent };
