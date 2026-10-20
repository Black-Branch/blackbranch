// Instance content (content.js) against a REAL Postgres: prompt overrides, the
// help desk's facts, the bot's behavior file. The one writer validates, keeps history (tier
// 'content', old and new body), re-reads, and tells the other processes — on internal sockets.
// Fixtures: every content row and history row is emptied before and after, so this must only
// ever point at a THROWAWAY database.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test content.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createContent } = require('./content');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const quiet = { log() {}, warn() {}, error() {} };

test('content store against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  // Same lock as the other site.instance_* writers: they empty instance_history.
  const lock = await pool.connect();
  await lock.query('SELECT pg_advisory_lock(135135)');
  const clean = async () => {
    await pool.query('DELETE FROM site.instance_content');
    await pool.query("DELETE FROM site.instance_history WHERE tier = 'content'");
  };
  await clean();
  t.after(async () => { await clean(); await lock.query('SELECT pg_advisory_unlock(135135)'); lock.release(); await pool.end(); });

  const frames = [];
  const c = createContent({
    pool, log: quiet, sendInternal: (f) => { frames.push(f); return 1; },
    slotKnown: async (id) => ['helpdesk.answer', 'automod.classify', 'zz.plugin'].includes(id),
    validators: { 'bot.behavior': (b) => (b.startsWith('{') ? null : 'expected JSON') },
  });
  await c.load();

  await t.test('a prompt override is stored, re-read, announced, with a history row', async () => {
    const r = await c.write('prompt.helpdesk.answer', 'You are {{bot.name}}.', '@admin:example.tv');
    assert.equal(r.status, 200);
    assert.equal(c.get('prompt.helpdesk.answer'), 'You are {{bot.name}}.');
    assert.deepEqual(frames.at(-1), { type: 'config_content_changed', keys: ['prompt.helpdesk.answer'] });
    const h = await pool.query("SELECT action, old_value, new_value, updated_by FROM site.instance_history WHERE tier = 'content' ORDER BY id");
    assert.deepEqual(h.rows.map((x) => [x.action, x.old_value, x.new_value, x.updated_by]),
      [['set', null, 'You are {{bot.name}}.', '@admin:example.tv']]);
  });

  await t.test('an edit records the old body; revert deletes the row and records it too', async () => {
    await c.write('prompt.helpdesk.answer', 'Second.', '@admin:example.tv');
    const r = await c.clear('prompt.helpdesk.answer', '@admin:example.tv');
    assert.deepEqual(r.body, { ok: true, key: 'prompt.helpdesk.answer', removed: true });
    assert.equal(c.get('prompt.helpdesk.answer'), null);
    const h = await pool.query("SELECT action, old_value, new_value FROM site.instance_history WHERE tier = 'content' ORDER BY id");
    assert.deepEqual(h.rows.slice(1).map((x) => [x.action, x.old_value, x.new_value]),
      [['set', 'You are {{bot.name}}.', 'Second.'], ['clear', 'Second.', null]]);
    const again = await c.clear('prompt.helpdesk.answer', '@admin:example.tv');
    assert.equal(again.body.removed, false, 'a second revert removes nothing');
  });

  await t.test('refusals: unknown key, unknown task, empty prompt, oversize, a validator, no author', async () => {
    const n0 = frames.length;
    assert.match((await c.write('prompt.nope.task', 'x', '@a:b')).body.error, /no chat task "nope.task"/);
    assert.match((await c.write('site.secret', 'x', '@a:b')).body.error, /unknown content key/);
    assert.match((await c.write('prompt.automod.classify', '   ', '@a:b')).body.error, /empty prompt/);
    assert.match((await c.write('helpdesk.facts', 'x'.repeat(32769), '@a:b')).body.error, /at most 32768/);
    assert.match((await c.write('prompt.automod.classify', 'x'.repeat(16001), '@a:b')).body.error, /at most 16000/);
    assert.match((await c.write('bot.behavior', 'not json', '@a:b')).body.error, /expected JSON/);
    assert.equal((await c.write('helpdesk.facts', 'ok', '')).status, 400);
    assert.equal(frames.length, n0, 'nothing refused is announced');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM site.instance_content');
    assert.equal(rows[0].n, 0, 'nothing refused is stored');
  });

  await t.test('a plugin task\'s prompt and the facts are content too; all() is what other processes read', async () => {
    assert.equal((await c.write('prompt.zz.plugin', 'plugin text', '@a:b')).status, 200);
    assert.equal((await c.write('helpdesk.facts', '# Facts', '@a:b')).status, 200);
    const all = c.all();
    assert.deepEqual(Object.keys(all).sort(), ['helpdesk.facts', 'prompt.zz.plugin']);
    assert.equal(all['helpdesk.facts'].body, '# Facts');
    assert.equal(all['helpdesk.facts'].updatedBy, '@a:b');
  });
});
