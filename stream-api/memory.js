// ── Memory: what the bot may remember about a person, and forgetting them ────
//
// A PERSON is every identity linked to one site account or platform canonical id: the same
// one-hop expansion web/lib/socialCredit.ts `resolveIdentities` does (matrix ⇄ canonical through
// the native stream.links rows and site.platform_links).
//
// The product never names a plugin's tables. A plugin that keeps its own per-person memory
// registers a forget handler; `forget` runs the product deletes and every handler in ONE
// transaction, so a failure anywhere forgets nothing and says so.
//
// Fail closed. `mayRemember` throws on a database error rather than answering "yes" — the
// embedding writer then refuses the row. There is no cache to be stale after a restart.
//
// The store: POST /embedding is the one writer of stream.message_embeddings.
// The dimension has ONE source of truth, the column's type: it is read at boot and compared
// with memory.state (written by this module only). A mismatch, or an embedder that refuses the
// key, PAUSES memory with one alarm — memory never stops silently. Retention purges by age
// (memory.retentionDays; null = forever).

const { messageVisibleSql } = require('./instanceSchema.generated.js');
const { NATIVE_SQL } = require('./native-platform');

const PAUSE_REASONS = ['dim_mismatch', 'key_rejected', 'quota', 'model_not_found', 'store_refused'];
const PURGE_BATCH = 5000;
const PURGE_EVERY_MS = 24 * 60 * 60_000;
const PURGE_FIRST_MS = 10 * 60_000;
const HNSW_MAX_DIM = 2000;
const REDUCED_DIM = 1536;
const SWITCH_DRAIN_MS = 10_000;
const LATE_VECTOR_GRACE_MS = 60_000;
const REPROBE_AFTER_MS = [3_000, 10_000, 30_000];
const SEARCH_K = 5;
const SEARCH_MAX_DISTANCE = 0.55;
const SEARCH_ROW_CHARS = 300;
const SEARCH_TOTAL_CHARS = 1500;
const MODEL_ID = /^[\w.:/@-]{1,128}$/;
const SLUG = /^[a-z0-9-]{1,24}$/;

function createMemory({ pool, config = null, notify = () => {}, log = console, ai = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const cfg = () => config || require('./instance-config').instanceConfig;
  let columnDim = null;
  let pausing = null;
  let purgeTimer = null;
  /** @type {Map<string, (who: { matrixIds: string[], canonicalIds: string[], names: string[], db: any }) => Promise<number>>} */
  const forgetHandlers = new Map();

  /** A plugin's per-person forget. Re-registering a name replaces it (a hot reload must not double-delete). */
  function registerForgetHandler(name, fn) {
    forgetHandlers.set(String(name), fn);
  }

  async function resolveIdentities({ matrixId = null, canonicalId = null } = {}, db = pool) {
    const matrixIds = new Set(matrixId ? [String(matrixId)] : []);
    const canonicalIds = new Set(canonicalId ? [String(canonicalId)] : []);
    if (matrixIds.size) {
      const { rows } = await db.query(
        `SELECT canonical AS id FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = ANY($1)
         UNION SELECT canonical_id FROM site.platform_links WHERE matrix_id = ANY($1)`,
        [[...matrixIds]]
      );
      rows.forEach((r) => r.id && canonicalIds.add(r.id));
    }
    if (canonicalIds.size) {
      const { rows } = await db.query(
        `SELECT platform_id AS id FROM stream.links WHERE platform IN ${NATIVE_SQL} AND canonical = ANY($1)
         UNION SELECT matrix_id FROM site.platform_links WHERE canonical_id = ANY($1)`,
        [[...canonicalIds]]
      );
      rows.forEach((r) => r.id && matrixIds.add(r.id));
    }
    return { matrixIds: [...matrixIds], canonicalIds: [...canonicalIds] };
  }

  /**
   * Names the person PROVABLY owns: stream.nameidx rows mapped to one of their canonical ids.
   * name_lower is nameidx's primary key (a name's first owner), so no other person holds the
   * same mapping. These are the ONLY names a deletion may match — a display name or nickname
   * is self-chosen, and deleting by one would let a person wipe someone else's rows by
   * renaming themselves.
   */
  async function ownedNames({ canonicalIds }, db = pool) {
    if (!canonicalIds.length) return [];
    const { rows } = await db.query(
      `SELECT name_lower AS n FROM stream.nameidx WHERE canonical = ANY($1)`, [canonicalIds]
    );
    return rows.map((r) => r.n).filter(Boolean);
  }

  /**
   * Every lower-cased name the person goes by, owned or chosen. For REFUSING to embed only:
   * a false match there just means a line is not remembered, the safe direction. Never a
   * deletion key (see ownedNames).
   */
  async function namesOf({ matrixIds, canonicalIds }, db = pool) {
    const names = new Set();
    if (canonicalIds.length) {
      const { rows } = await db.query(
        `SELECT name_lower AS n FROM stream.nameidx WHERE canonical = ANY($1)
         UNION SELECT lower(nickname) FROM stream.users WHERE id = ANY($1) AND nickname IS NOT NULL`,
        [canonicalIds]
      );
      rows.forEach((r) => r.n && names.add(r.n));
    }
    if (matrixIds.length) {
      const { rows } = await db.query(
        `SELECT lower(display_name) AS n FROM site.users WHERE matrix_id = ANY($1) AND display_name IS NOT NULL`,
        [matrixIds]
      );
      rows.forEach((r) => r.n && names.add(r.n));
      // The localpart is the name a site account chats under before it sets a display name.
      for (const m of matrixIds) {
        const lp = /^@([^:]+):/.exec(m);
        if (lp) names.add(lp[1].toLowerCase());
      }
    }
    return [...names];
  }

  // Two places hold an opt-out: the site account's (site.memory_opt_outs, by matrix id), and a
  // DELETED account's, carried onto each platform id it was linked to
  // (stream.memory_opt_out_platform_ids, written by account-erase.js) — the person may keep
  // chatting there under a fresh identity, and memory must stay off for them.
  async function isOptedOut({ matrixIds, canonicalIds = [] }, db = pool) {
    if (!matrixIds.length && !canonicalIds.length) return false;
    const { rows } = await db.query(
      `SELECT 1 FROM site.memory_opt_outs WHERE matrix_id = ANY($1)
       UNION ALL
       SELECT 1 FROM stream.links l JOIN stream.memory_opt_out_platform_ids o
         ON o.platform = l.platform AND o.platform_id = l.platform_id
        WHERE l.canonical = ANY($2)
       LIMIT 1`, [matrixIds, canonicalIds]
    );
    return rows.length > 0;
  }

  /** Has anyone linked to this matrix id / canonical id switched memory off? */
  async function isPersonOptedOut(person) {
    if (!(await anyOptOuts())) return false;
    return isOptedOut(await resolveIdentities(person));
  }

  async function anyOptOuts() {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM site.memory_opt_outs) OR EXISTS (SELECT 1 FROM stream.memory_opt_out_platform_ids) AS any`);
    return rows[0].any === true;
  }

  /**
   * Whose message is this memory row? Platform rows by the chat_log author, native rows by the
   * site.chat_messages author, the bot's own lines by who they were said to (name-based).
   * null = nobody we can name, which nothing can have opted out.
   */
  async function personOfRow({ source, source_id, target_name }) {
    if (source === 'platform') {
      const { rows } = await pool.query(`SELECT user_id FROM stream.chat_log WHERE id = $1`, [source_id]);
      return rows[0]?.user_id ? { canonicalId: rows[0].user_id } : null;
    }
    if (source === 'native') {
      const { rows } = await pool.query(`SELECT matrix_id FROM site.chat_messages WHERE id = $1`, [source_id]);
      return rows[0]?.matrix_id ? { matrixId: rows[0].matrix_id } : null;
    }
    const name = String(target_name || '').trim().replace(/^@/, '').toLowerCase();
    if (!name) return null;
    const { rows } = await pool.query(`SELECT canonical FROM stream.nameidx WHERE name_lower = $1`, [name]);
    return rows[0]?.canonical ? { canonicalId: rows[0].canonical } : null;
  }

  /** May this row be embedded and stored? Throws on a database error (fail closed). */
  async function mayRemember(row) {
    if (!(await anyOptOuts())) return true;
    const person = await personOfRow(row);
    if (!person) return true;
    return !(await isOptedOut(await resolveIdentities(person)));
  }

  /**
   * Forget a person: delete their message embeddings (all linked identities) and run every
   * plugin forget handler, in one transaction. Idempotent — a second call deletes nothing.
   * Writes site.mod_log `memory_forget`. Returns the number of rows removed.
   *
   * `scope` is passed to the handlers: 'self' (the person's own opt-out — the default, and
   * the narrow one) or 'admin' (the usercard button, which may also remove SHARED memory
   * that names them). `dryRun` counts inside the transaction and rolls it back.
   * A handler returns a count, or `{ count, ...details }`; details are reported per handler.
   */
  async function forget(person, { actor, reason = null, scope = 'self', dryRun = false, identities = null } = {}) {
    if (!actor) throw new Error('forget: actor required');
    const target = person?.matrixId || person?.canonicalId;
    if (!target) throw new Error('forget: a matrixId or canonicalId is required');
    const client = await pool.connect();
    let rollbackErr = null;
    try {
      await client.query('BEGIN');
      // A caller that has already decided exactly whose rows these are (account deletion: only
      // the identities exclusively that account's) passes them; nothing is re-resolved.
      const ids = identities
        ? { matrixIds: [...(identities.matrixIds || [])], canonicalIds: [...(identities.canonicalIds || [])] }
        : await resolveIdentities(person, client);
      const names = await ownedNames(ids, client);
      let deleted = 0;
      if (ids.canonicalIds.length) {
        const r = await client.query(
          `DELETE FROM stream.message_embeddings me
            USING stream.chat_log cl
            WHERE me.source = 'platform' AND cl.id = me.source_id AND cl.user_id = ANY($1)`,
          [ids.canonicalIds]
        );
        deleted += r.rowCount;
      }
      if (ids.matrixIds.length) {
        const r = await client.query(
          `DELETE FROM stream.message_embeddings me
            USING site.chat_messages cm
            WHERE me.source = 'native' AND cm.id = me.source_id AND cm.matrix_id = ANY($1)`,
          [ids.matrixIds]
        );
        deleted += r.rowCount;
      }
      if (names.length) {
        // The bot's own lines, by who they were said to. Any source that is not a person's
        // message is the bot's — this module does not name the bot's source value.
        const r = await client.query(
          `DELETE FROM stream.message_embeddings
            WHERE source NOT IN ('platform', 'native') AND lower(target_name) = ANY($1)`,
          [names]
        );
        deleted += r.rowCount;
      }
      const byHandler = {};
      for (const [name, fn] of forgetHandlers) {
        const out = await fn({ ...ids, names, scope: scope === 'admin' ? 'admin' : 'self', db: client });
        const n = Number(typeof out === 'object' && out ? out.count : out) || 0;
        byHandler[name] = typeof out === 'object' && out ? out : { count: n };
        deleted += n;
      }
      if (dryRun) {
        await client.query('ROLLBACK');
        return { deleted, byHandler, identities: ids.matrixIds.length + ids.canonicalIds.length, dryRun: true };
      }
      await client.query(
        `INSERT INTO site.mod_log (action, target_id, performed_by, reason)
         VALUES ('memory_forget', $1, $2, $3)`,
        [target, String(actor), `${reason ? `${reason}: ` : ''}${deleted} memory rows removed`]
      );
      await client.query('COMMIT');
      return { deleted, byHandler, identities: ids.matrixIds.length + ids.canonicalIds.length };
    } catch (e) {
      // A failed ROLLBACK leaves the connection mid-transaction; release(err) destroys it.
      await client.query('ROLLBACK').catch((re) => { rollbackErr = re; });
      throw e;
    } finally {
      client.release(rollbackErr);
    }
  }

  /**
   * The per-account setting "Let the bot remember my messages". Off = a row in
   * site.memory_opt_outs, committed FIRST so no new row can be embedded, then forget.
   */
  async function setOptOut(matrixId, optedOut) {
    if (optedOut) {
      await pool.query(
        `INSERT INTO site.memory_opt_outs (matrix_id) VALUES ($1) ON CONFLICT (matrix_id) DO NOTHING`,
        [matrixId]
      );
      const { deleted } = await forget({ matrixId }, { actor: matrixId, reason: 'opted out' });
      return { optedOut: true, deleted };
    }
    await pool.query(`DELETE FROM site.memory_opt_outs WHERE matrix_id = $1`, [matrixId]);
    return { optedOut: false, deleted: 0 };
  }

  /** Everyone who opted out, expanded to all their identities and names — for the offline
   *  backfills, which read thousands of rows at once and filter with `rowIsOptedOut`. */
  async function optedOutPeople() {
    const { rows } = await pool.query(`SELECT matrix_id FROM site.memory_opt_outs`);
    const people = { matrixIds: new Set(), canonicalIds: new Set(), names: new Set() };
    for (const { matrix_id } of rows) {
      const ids = await resolveIdentities({ matrixId: matrix_id });
      ids.matrixIds.forEach((m) => people.matrixIds.add(m));
      ids.canonicalIds.forEach((c) => people.canonicalIds.add(c));
      (await namesOf(ids)).forEach((n) => people.names.add(n));
    }
    // A deleted account's opt-out, by platform id: the identities those ids resolve to now.
    const carried = await pool.query(
      `SELECT DISTINCT l.canonical FROM stream.links l JOIN stream.memory_opt_out_platform_ids o
         ON o.platform = l.platform AND o.platform_id = l.platform_id`);
    for (const { canonical } of carried.rows) {
      const ids = await resolveIdentities({ canonicalId: canonical });
      ids.matrixIds.forEach((m) => people.matrixIds.add(m));
      ids.canonicalIds.forEach((c) => people.canonicalIds.add(c));
      (await namesOf(ids)).forEach((n) => people.names.add(n));
    }
    return people;
  }

  // ── the store: dimension, state, pause / resume, retention ──────────────────────────────
  /** The column's dimension, from its type — `vector(1536)` → 1536. */
  async function readColumnDim(db = pool) {
    const { rows } = await db.query(
      `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
        WHERE attrelid = 'stream.message_embeddings'::regclass AND attname = 'embedding'`);
    const m = /^vector\((\d+)\)$/.exec(rows[0]?.t || '');
    return m ? Number(m[1]) : null;
  }

  function state() {
    try { return cfg().get('memory.state') || null; } catch { return null; }
  }

  /** The vector length the store takes now: memory.state's, else the column's. */
  function dim() {
    return state()?.dim ?? columnDim;
  }

  async function writeState(next, by) {
    const r = await cfg().writeInternal('memory.state', next, by);
    if (r.status !== 200) throw new Error(`memory.state not written: ${r.body?.error || r.status}`);
  }

  /** memory.enabled + an embedder + no state yet + a store that already holds ONLY that model's
   *  vectors → record what exists (the column's dim, the oldest row) as the state. Never DDL.
   *  An empty store is not adopted: the first embedder is set by the probe flow. */
  async function adopt() {
    const c = cfg();
    const route = c.get('ai.embeddings');
    if (c.get('memory.enabled') !== true || !route || state()) return null;
    const { rows } = await pool.query(
      `SELECT count(*)::bigint AS n, min(created_at) AS oldest, count(DISTINCT model)::int AS models, min(model) AS model
         FROM stream.message_embeddings`);
    const r = rows[0];
    if (Number(r.n) === 0 || r.models !== 1 || r.model !== route.model || !columnDim) {
      log.warn(`[memory] memory is switched on but has no state, and the store is not a ${route.model} store ` +
        `(${r.n} rows, ${r.models} model(s)) — not adopting; turn memory on from the memory panel`);
      return null;
    }
    const next = { model: route.model, connection: route.connection, dim: columnDim, since: new Date(r.oldest).toISOString(), status: 'on' };
    await writeState(next, 'stream-api:memory-adopt');
    log.log(`[memory] adopted the existing store: ${r.n} rows of ${route.model}, vector(${columnDim}), since ${next.since} — no DDL`);
    return next;
  }

  /** Boot: read the column, adopt an existing store, compare. A mismatch pauses (one alarm). */
  async function boot() {
    columnDim = await readColumnDim();
    let s = state();
    if (!s) s = await adopt();
    if (!s) { log.log(`[memory] column vector(${columnDim}); memory is off (no memory.state)`); return; }
    if (s.dim !== columnDim) {
      log.error(`[memory] dim check FAILED: column vector(${columnDim}) ≠ memory.state ${s.dim} (${s.model})`);
      await pause('dim_mismatch');
      return;
    }
    log.log(`[memory] dim check passed: column vector(${columnDim}) = memory.state ${s.dim} (${s.model}, ${s.status})`);
  }

  /** Pause memory: ONE state write and ONE alarm per pause. Only an 'on' memory can pause. */
  async function pause(reason) {
    const why = PAUSE_REASONS.includes(reason) ? reason : 'store_refused';
    if (pausing) return pausing;
    pausing = (async () => {
      const s = state();
      if (!s || s.status !== 'on') return { paused: false, status: s?.status ?? 'off' };
      await writeState({ ...s, status: 'paused', pausedReason: why, pausedAt: new Date().toISOString() }, 'stream-api:memory');
      log.error(`[memory] PAUSED (${why}) — no message is remembered until memory is resumed`);
      notify('memory.paused', 'Memory paused',
        `Message memory stopped (${why}). Nothing new is remembered until it is resumed; the bot answers without memory meanwhile.`);
      return { paused: true, reason: why };
    })();
    try { return await pausing; } finally { pausing = null; }
  }

  /** Resume a paused memory — only once a probe of its own embedder answers at its own length
   *  and the column agrees: resuming onto a key that is still refused would only pause again.
   *  With no memory.state, adopt an existing store. */
  async function resume() {
    columnDim = await readColumnDim();
    const s = state() || (await adopt());
    if (!s) return { ok: false, error: 'memory is not configured' };
    if (s.status === 'on') return { ok: true, status: 'on' };
    if (s.status === 'switching') return { ok: false, error: 'memory is switching embedders' };
    if (s.dim !== columnDim) return { ok: false, error: 'dim_mismatch', column: columnDim, state: s.dim };
    if (ai) {
      const p = await ai.probeEmbed(s.connection, s.model, s.reduced ? s.dim : undefined);
      if (!p.ok) return { ok: false, error: p.code || 'probe_failed', probe: p };
      if (p.dim !== s.dim) return { ok: false, error: 'dim_mismatch', probe: p, state: s.dim };
    }
    const { pausedReason: _r, pausedAt: _a, ...rest } = s;
    await writeState({ ...rest, status: 'on' }, 'stream-api:memory-resume');
    log.log(`[memory] resumed (was paused: ${s.pausedReason || 'unknown'})${ai ? ' after a probe answered' : ''}`);
    return { ok: true, status: 'on' };
  }

  // ── the memory panel's flows ──────────────────────────────────────────────────────────────
  /** A flow that changes the embedder refuses while a plugin locks the slot — and while
   *  stream-ingest is not reporting, because a lock is only known from its report. */
  function changeRefusal() {
    if (!ai) return { status: 503, body: { error: 'the AI wrapper is not wired' } };
    if (!ai.ingestReporting()) return { status: 503, body: { error: 'stream-ingest is not reporting — the embedder cannot be changed until it is (a plugin lock would be invisible)' } };
    const lock = ai.lockOf('embeddings');
    if (lock) return { status: 409, body: { error: 'locked', lockedBy: lock } };
    return null;
  }

  /** Probe a candidate: its length, and — over pgvector's HNSW limit — a second probe asking for
   *  1,536 (models that accept `dimensions`). `{ok, dim, reduced}` or `{ok:false, status, body}`. */
  async function probeCandidate(connection, model) {
    const p = await ai.probeEmbed(connection, model);
    if (!p.ok) return { ok: false, status: 422, body: { error: p.code === 'needs_unmet' ? 'this connection cannot embed — pick an OpenAI-compatible one (Anthropic has no embeddings endpoint)' : `the probe failed: ${p.code}`, code: p.code, package: p.package } };
    if (p.dim <= HNSW_MAX_DIM) return { ok: true, dim: p.dim, reduced: false, package: p.package };
    const again = await ai.probeEmbed(connection, model, REDUCED_DIM);
    if (again.ok && again.dim === REDUCED_DIM) return { ok: true, dim: REDUCED_DIM, reduced: true, package: again.package };
    return { ok: false, status: 422, body: { error: `this model returns ${p.dim} dimensions; pgvector's HNSW index holds at most ${HNSW_MAX_DIM} — pick a smaller model, or one that accepts a dimensions setting`, code: 'too_many_dimensions', dim: p.dim } };
  }

  async function storeShape(db = pool) {
    const { rows } = await db.query(
      `SELECT count(*)::bigint AS n, min(created_at) AS oldest, array_remove(array_agg(DISTINCT model), NULL) AS models
         FROM stream.message_embeddings`);
    return { rows: Number(rows[0].n), oldest: rows[0].oldest ? new Date(rows[0].oldest).toISOString() : null, models: rows[0].models || [] };
  }

  /** Retype the empty column, inside one transaction that re-checks it is empty under a lock.
   *  `dim` is an integer from a probe (1–2000), never text. False when rows appeared. */
  async function retypeEmpty(dim, { truncate = false } = {}) {
    if (!Number.isInteger(dim) || dim < 1 || dim > HNSW_MAX_DIM) throw new Error(`bad dimension ${dim}`);
    const client = await pool.connect();
    let rollbackErr = null;
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE stream.message_embeddings IN ACCESS EXCLUSIVE MODE');
      if (truncate) await client.query('TRUNCATE stream.message_embeddings');
      const { rows } = await client.query('SELECT EXISTS (SELECT 1 FROM stream.message_embeddings) AS any');
      if (rows[0].any) { await client.query('ROLLBACK'); return false; }
      if ((await readColumnDim(client)) !== dim) {
        await client.query(`ALTER TABLE stream.message_embeddings ALTER COLUMN embedding TYPE vector(${dim})`);
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch((re) => { rollbackErr = re; });
      throw e;
    } finally {
      client.release(rollbackErr);
    }
  }

  async function writeOn({ connection, model, dim, reduced }, by) {
    const c = cfg();
    let r = await c.writeInternal('ai.embeddings', { connection, model }, by);
    if (r.status !== 200) throw new Error(`ai.embeddings not written: ${r.body?.error || r.status}`);
    await writeState({ model, connection, dim, since: new Date().toISOString(), status: 'on', ...(reduced ? { reduced: true } : {}) }, by);
    r = await c.writeInternal('memory.enabled', true, by);
    if (r.status !== 200) throw new Error(`memory.enabled not written: ${r.body?.error || r.status}`);
    columnDim = dim;
  }

  const badRoute = (connection, model) => !SLUG.test(connection || '') || !MODEL_ID.test(model || '');

  /** Turn memory on: probe → the first embedder sets the column's dimension, only
   *  while the store is empty. A store that holds anything else is a change → start fresh. */
  async function enable({ connection, model, actor }) {
    if (badRoute(connection, model)) return { status: 400, body: { error: 'connection and model are required' } };
    const refused = changeRefusal();
    if (refused) return refused;
    const s = state();
    if (s && s.status === 'switching') return { status: 409, body: { error: 'memory is switching embedders' } };
    if (s && s.model === model && s.connection === connection) {
      if (s.status === 'paused') return { status: 409, body: { error: 'memory is paused — use Resume (it probes first)' } };
      if (cfg().get('memory.enabled') === true) return { status: 200, body: { ok: true, already: true, dim: s.dim } };
    }
    if (s && (s.model !== model || s.connection !== connection)) {
      return { status: 409, body: { error: `memory already uses ${s.connection} · ${s.model} — changing it is "Start fresh"`, needsStartFresh: true, ...(await storeShape()) } };
    }
    const p = await probeCandidate(connection, model);
    if (!p.ok) return p;
    const col = await readColumnDim();
    const shape = await storeShape();
    const foreign = shape.models.some((m) => m !== model);
    if (shape.rows > 0 && (foreign || p.dim !== col)) {
      return { status: 409, body: { error: `the store holds ${shape.rows} memories from another embedder — changing it is "Start fresh"`, needsStartFresh: true, ...shape } };
    }
    if (p.dim !== col && !(await retypeEmpty(p.dim))) {
      return { status: 409, body: { error: 'memories arrived while turning on — try again', needsStartFresh: true } };
    }
    await writeOn({ connection, model, dim: p.dim, reduced: p.reduced }, `stream-api:memory-enable (${actor})`);
    log.log(`[memory] turned on by ${actor}: ${connection}/${model}, vector(${p.dim})${p.dim !== col ? ` (column retyped from ${col})` : ' (no DDL)'}${p.reduced ? ', reduced' : ''}`);
    return { status: 200, body: { ok: true, dim: p.dim, reduced: p.reduced, retyped: p.dim !== col, probedIn: p.package } };
  }

  /** Change the embedder: clears every stored memory. Without `confirm` (or with the
   *  wrong number) it only reports the exact count, which the confirm dialog must show. */
  async function startFresh({ connection, model, confirm, actor }) {
    if (badRoute(connection, model)) return { status: 400, body: { error: 'connection and model are required' } };
    const refused = changeRefusal();
    if (refused) return refused;
    const shape = await storeShape();
    // The count read (no confirm yet) is an answer, not a failure; a WRONG count is refused.
    if (confirm !== shape.rows) return { status: confirm == null ? 200 : 409, body: { ...(confirm == null ? {} : { error: 'confirm with the exact count' }), needConfirm: true, count: shape.rows, oldest: shape.oldest } };
    const p = await probeCandidate(connection, model);
    if (!p.ok) return p;
    const by = `stream-api:memory-start-fresh (${actor})`;
    const s = state();
    // Stop embedding first: ingest reads the state per call, and the flip is announced.
    await writeState(s ? { ...s, status: 'switching' } : { model, connection, dim: p.dim, since: new Date().toISOString(), status: 'switching' }, by);
    await sleep(SWITCH_DRAIN_MS);
    if (!(await retypeEmpty(p.dim, { truncate: true }))) throw new Error('start fresh: the store was not empty after TRUNCATE');
    await writeOn({ connection, model, dim: p.dim, reduced: p.reduced }, by);
    await pool.query(
      `INSERT INTO site.mod_log (action, target_id, performed_by, reason) VALUES ('memory_start_fresh', 'memory', $1, $2)`,
      [String(actor), `${shape.rows} memories cleared; now ${connection}/${model} vector(${p.dim})`]).catch((e) => log.warn(`[memory] mod_log: ${e.message}`));
    log.log(`[memory] START FRESH by ${actor}: ${shape.rows} rows cleared; now ${connection}/${model}, vector(${p.dim})`);
    return { status: 200, body: { ok: true, cleared: shape.rows, dim: p.dim, reduced: p.reduced } };
  }

  /** A write that could fix a paused embedder (its key, its connection) re-probes and resumes. */
  function onSettingsWritten(keys) {
    const s = state();
    if (!s || s.status !== 'paused' || !Array.isArray(keys)) return;
    const keyName = s.connection === 'openai' ? 'openai.apiKey' : `ai.connection.${s.connection}.apiKey`;
    if (!keys.some((k) => k === keyName || k === 'ai.connections')) return;
    // The probe runs in stream-ingest, which re-reads the settings a moment AFTER this write —
    // so it is tried on a short schedule, and stops at the first resume or once not paused.
    const attempt = async (i) => {
      const now = state();
      if (!now || now.status !== 'paused') return;
      const r = await resume().catch((e) => ({ ok: false, error: e.message }));
      if (r.ok || i + 1 >= REPROBE_AFTER_MS.length) {
        log.log(`[memory] re-probe after ${keys.join(', ')} changed: ${r.ok ? 'resumed' : `still paused (${r.error})`}`);
        return;
      }
      setTimeout(() => { attempt(i + 1); }, REPROBE_AFTER_MS[i + 1] - REPROBE_AFTER_MS[i]).unref?.();
    };
    setTimeout(() => { attempt(0); }, REPROBE_AFTER_MS[0]).unref?.();
  }

  /** Delete rows older than memory.retentionDays, in batches. null = forever = nothing. Runs only
   *  on a LOADED settings layer and a configured memory: an unloaded layer answers the default
   *  (90 days), and acting on a default that was never this install's choice would delete it. */
  async function purgeExpired() {
    const c = cfg();
    if (!c.snapshot().state.loaded || !state()) return 0;
    const days = c.get('memory.retentionDays');
    if (days == null) return 0;
    let total = 0;
    for (;;) {
      const r = await pool.query(
        `DELETE FROM stream.message_embeddings WHERE id IN (
           SELECT id FROM stream.message_embeddings WHERE created_at < now() - make_interval(days => $1::int)
            ORDER BY created_at LIMIT ${PURGE_BATCH})`, [days]);
      total += r.rowCount;
      if (r.rowCount < PURGE_BATCH) break;
    }
    if (total) log.log(`[memory] retention: removed ${total} rows older than ${days} days`);
    return total;
  }

  /** The AI page's memory panel (read-only): what the store holds, its column's dimension, the
   *  resolved settings, and how many rows the next retention run would remove. */
  async function stats() {
    const c = cfg();
    const days = c.get('memory.retentionDays');
    const { rows } = await pool.query(
      `SELECT count(*)::bigint AS n, min(created_at) AS oldest,
              count(*) FILTER (WHERE $1::int IS NOT NULL AND created_at < now() - make_interval(days => $1::int))::bigint AS expiring,
              count(*) FILTER (WHERE created_at < now() - interval '30 days')::bigint AS d30,
              count(*) FILTER (WHERE created_at < now() - interval '90 days')::bigint AS d90,
              count(*) FILTER (WHERE created_at < now() - interval '365 days')::bigint AS d365
         FROM stream.message_embeddings`, [days]);
    const r = rows[0];
    return {
      state: state(), enabled: c.get('memory.enabled') === true, retentionDays: days,
      rows: Number(r.n), oldest: r.oldest ? new Date(r.oldest).toISOString() : null,
      columnDim: await readColumnDim(), nextPurge: days == null ? 0 : Number(r.expiring),
      // What each retention choice on the panel would remove at its next daily run.
      olderThan: { 30: Number(r.d30), 90: Number(r.d90), 365: Number(r.d365) },
    };
  }

  // ── retrieval for the product bot ───────────────────────────────────────────────────────
  /**
   * The nearest remembered PEOPLE's lines to `vector`: never a deleted message (nor one whose
   * source message is gone — an orphan cannot be checked, so it is not returned), never one past
   * retention, never one from the last 10 minutes (recent chat already carries those), never a
   * bot's own line — by the settings the caller passes (its names, its Matrix ids) plus this
   * install's bot.matrixId. Cosine distance ≤ 0.55, top `k` (≤ 5), each ≤ 300 characters and
   * ≤ 1,500 in total. Memory off or paused → nothing.
   */
  async function search({ vector, k = SEARCH_K, excludeNames = [], excludeMatrixIds = [] }) {
    const s = state();
    if (!s || s.status !== 'on' || cfg().get('memory.enabled') !== true) return { rows: [], off: true };
    if (!Array.isArray(vector) || vector.length !== s.dim || !vector.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return { rows: [], error: 'dim_mismatch' };
    }
    const names = [...new Set((Array.isArray(excludeNames) ? excludeNames : []).filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().replace(/^@/, '').toLowerCase()))].slice(0, 50);
    const botId = cfg().get('bot.matrixId');
    const ids = [...new Set([...(Array.isArray(excludeMatrixIds) ? excludeMatrixIds : []), ...(botId ? [botId] : [])].filter(isMatrixId))].slice(0, 20);
    const days = cfg().get('memory.retentionDays');
    const limit = Math.min(Math.max(parseInt(k, 10) || SEARCH_K, 1), SEARCH_K);
    const client = await pool.connect();
    let rollbackErr = null;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL hnsw.iterative_scan = 'strict_order'`);
      const r = await client.query(
        `SELECT me.username, me.message, me.created_at, (me.embedding <=> $1::vector) AS distance
           FROM stream.message_embeddings me
           LEFT JOIN stream.chat_log cl ON me.source = 'platform' AND cl.id = me.source_id
           LEFT JOIN site.chat_messages cm ON me.source = 'native' AND cm.id = me.source_id
          WHERE me.source IN ('platform', 'native')
            AND ((me.source = 'platform' AND cl.id IS NOT NULL AND ${messageVisibleSql('cl')})
              OR (me.source = 'native' AND cm.id IS NOT NULL AND ${messageVisibleSql('cm')}))
            AND me.created_at < now() - interval '10 minutes'
            AND ($2::int IS NULL OR me.created_at >= now() - make_interval(days => $2::int))
            AND NOT (lower(coalesce(me.username, '')) = ANY($3::text[]))
            AND NOT (me.source = 'native' AND cm.matrix_id = ANY($4::text[]))
          ORDER BY me.embedding <=> $1::vector
          LIMIT $5`,
        [`[${vector.join(',')}]`, days ?? null, names, ids, limit]);
      await client.query('COMMIT');
      let total = 0;
      const rows = [];
      for (const x of r.rows) {
        if (Number(x.distance) > SEARCH_MAX_DISTANCE) continue;
        const text = String(x.message).slice(0, SEARCH_ROW_CHARS);
        if (total + text.length > SEARCH_TOTAL_CHARS) break;
        total += text.length;
        rows.push({ username: x.username, message: text, at: new Date(x.created_at).toISOString(), distance: Number(Number(x.distance).toFixed(3)) });
      }
      return { rows };
    } catch (e) {
      await client.query('ROLLBACK').catch((re) => { rollbackErr = re; });
      throw e;
    } finally {
      client.release(rollbackErr);
    }
  }

  function startRetention() {
    const run = () => purgeExpired().catch((e) => log.warn(`[memory] retention run failed: ${e.message}`));
    const first = setTimeout(() => {
      run();
      purgeTimer = setInterval(run, PURGE_EVERY_MS);
      purgeTimer.unref?.();
    }, PURGE_FIRST_MS);
    first.unref?.();
  }

  async function store({ source, source_id, username, target_name, message, embedding, model }) {
    const s = state();
    if (!s || cfg().get('memory.enabled') !== true) return { status: 409, body: { error: 'memory_off' } };
    if (s.status !== 'on') return { status: 409, body: { error: 'memory_paused', status: s.status } };
    // Just after a start fresh, a vector from the old model may still arrive: refused, not alarmed.
    if (Array.isArray(embedding) && embedding.length !== s.dim && Date.now() - Date.parse(s.since) < LATE_VECTOR_GRACE_MS) {
      return { status: 409, body: { error: 'stale_vector' } };
    }
    if (!Array.isArray(embedding) || embedding.length !== s.dim) {
      await pause('dim_mismatch');
      return { status: 400, body: { error: 'dim_mismatch', expected: s.dim } };
    }
    // The person behind the row switched memory off. Answered 200 so the fire-and-forget caller
    // does not log it as a failure; a DB error here is a 500 and no write.
    if (!(await mayRemember({ source, source_id, target_name }))) return { status: 200, body: { ok: true, skipped: 'opted_out' } };
    await pool.query(
      `INSERT INTO stream.message_embeddings (source, source_id, username, target_name, message, embedding, model)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
       ON CONFLICT (source, source_id)
         DO UPDATE SET embedding = EXCLUDED.embedding, message = EXCLUDED.message,
                       model = EXCLUDED.model, target_name = EXCLUDED.target_name`,
      [source, source_id, username ?? null, target_name ?? null, message, `[${embedding.join(',')}]`, model || s.model]);
    return { status: 200, body: { ok: true } };
  }

  const isMatrixId = (v) => typeof v === 'string' && /^@[^:\s]+:\S+$/.test(v);

  function registerMemoryRoutes(app, { requireInternal, requireSecret, wrap }) {
    // POST /embedding { source, source_id, username?, target_name?, message, embedding, model? } —
    // the embedder (stream-ingest) stores one message's vector. 409 = memory off or paused (the
    // caller skips); 400 dim_mismatch = a vector of the wrong length, which pauses memory.
    app.post('/embedding', requireInternal, wrap(async (req, res) => {
      const b = req.body || {};
      if (!b.source || b.source_id == null || !b.message) return res.status(400).json({ error: 'source, source_id, message required' });
      const r = await store(b);
      res.status(r.status).json(r.body);
    }));

    // POST /memory/pause { reason } — the embedder hit a condition that will not clear by itself
    // (a rejected key, no quota, a model gone, a wrong-length vector). One pause, one alarm.
    app.post('/memory/pause', requireInternal, wrap(async (req, res) => {
      const reason = String(req.body?.reason || '');
      if (!PAUSE_REASONS.includes(reason)) return res.status(400).json({ error: `reason must be one of ${PAUSE_REASONS.join(', ')}` });
      res.json({ ok: true, ...(await pause(reason)) });
    }));

    // POST /memory/resume — the memory panel's Resume: a probe of the embedder first.
    app.post('/memory/resume', requireSecret, wrap(async (_req, res) => {
      const r = await resume();
      res.status(r.ok ? 200 : 409).json(r);
    }));

    // POST /memory/enable { connection, model, actor } — Turn on memory (the probe flow).
    app.post('/memory/enable', requireSecret, wrap(async (req, res) => {
      const { connection, model, actor } = req.body || {};
      if (!isMatrixId(actor)) return res.status(400).json({ error: 'actor required' });
      const r = await enable({ connection, model, actor });
      res.status(r.status).json(r.body);
    }));

    // POST /memory/start-fresh { connection, model, confirm, actor } — change the embedder; clears
    // every memory. Without the exact `confirm` count it only answers that count.
    app.post('/memory/start-fresh', requireSecret, wrap(async (req, res) => {
      const { connection, model, confirm, actor } = req.body || {};
      if (!isMatrixId(actor)) return res.status(400).json({ error: 'actor required' });
      const r = await startFresh({ connection, model, confirm: Number.isInteger(confirm) ? confirm : null, actor });
      res.status(r.status).json(r.body);
    }));

    // POST /memory/forget { matrixId? | canonicalId?, actor, dryRun? } — the admin usercard's
    // "Forget this person's AI memory" (scope 'admin'; the web route verifies the admin and
    // sends their matrix id as `actor`). dryRun: the counts the confirm shows, nothing removed.
    app.post('/memory/forget', requireInternal, wrap(async (req, res) => {
      const { matrixId, canonicalId, actor } = req.body || {};
      if (!isMatrixId(actor)) return res.status(400).json({ error: 'actor required' });
      if (matrixId != null && !isMatrixId(matrixId)) return res.status(400).json({ error: 'bad matrixId' });
      if (!matrixId && !(typeof canonicalId === 'string' && canonicalId.trim()))
        return res.status(400).json({ error: 'matrixId or canonicalId required' });
      const dryRun = req.body?.dryRun === true;
      const out = await forget(matrixId ? { matrixId } : { canonicalId: canonicalId.trim() }, { actor, scope: 'admin', dryRun });
      if (!dryRun) console.log(`[memory] forget by ${actor}: ${out.deleted} rows across ${out.identities} identities`);
      res.json({ ok: true, deleted: out.deleted, byHandler: out.byHandler, dryRun });
    }));

    // PUT /memory/opt-out { matrixId, optedOut } — the person's own setting (web checks the session).
    app.put('/memory/opt-out', requireInternal, wrap(async (req, res) => {
      const { matrixId, optedOut } = req.body || {};
      if (!isMatrixId(matrixId) || typeof optedOut !== 'boolean')
        return res.status(400).json({ error: 'matrixId and optedOut:boolean required' });
      const out = await setOptOut(matrixId, optedOut);
      res.json({ ok: true, ...out });
    }));

    // POST /memory/search { vector, k?, excludeNames?, excludeMatrixIds? } — the chat bot's
    // recall. Rows of people's lines only; memory off or paused = no rows.
    app.post('/memory/search', requireInternal, wrap(async (req, res) => {
      res.json(await search(req.body || {}));
    }));

    // POST /memory/allowed { source, source_id, target_name? } — asked by the embedder BEFORE it
    // sends a message's text out to be embedded. A 5xx here means "don't".
    app.post('/memory/allowed', requireInternal, wrap(async (req, res) => {
      const { source, source_id, target_name } = req.body || {};
      if (!source || source_id == null) return res.status(400).json({ error: 'source, source_id required' });
      res.json({ allowed: await mayRemember({ source, source_id, target_name }) });
    }));
  }

  return {
    registerForgetHandler, isPersonOptedOut, mayRemember, forget, setOptOut, optedOutPeople, registerMemoryRoutes, resolveIdentities,
    boot, dim, pause, resume, purgeExpired, startRetention, store, readColumnDim, stats,
    enable, startFresh, onSettingsWritten, search,
  };
}

/**
 * For an offline backfill that embeds with its OWN model: refuse unless the store is on and holds
 * exactly that model at the vectors' length. Two embedding models in one column compare as noise,
 * not similarity — and nothing at insert time can tell. Returns null (ok) or the reason.
 */
async function storeRefusesModel(pool, model) {
  const { rows } = await pool.query(`SELECT value FROM site.instance_config WHERE key = 'memory.state'`);
  const s = rows[0]?.value;
  if (!s) return 'memory is not on (no memory.state) — a backfill would fill a store nobody configured';
  if (s.status !== 'on') return `memory is ${s.status} — resume it first`;
  if (s.model !== model) return `the store holds ${s.model}, this backfill embeds with ${model}`;
  return null;
}

/**
 * Is this backfill row (platform: user_id · native: matrix_id · bot line: target_name) an opted-out person's?
 * @parked plugin API: an install's site plugin filters its offline embedding backfills (its
 * bulk-embed scripts) with it, so a backfill honours the opt-out exactly as the live writer does.
 * Nothing in the product backfills.
 */
function rowIsOptedOut(people, row) {
  if (row.source === 'platform') return people.canonicalIds.has(row.user_id);
  if (row.source === 'native') return people.matrixIds.has(row.matrix_id);
  return !!row.target_name && people.names.has(String(row.target_name).toLowerCase());
}

module.exports = { createMemory, rowIsOptedOut, storeRefusesModel };
