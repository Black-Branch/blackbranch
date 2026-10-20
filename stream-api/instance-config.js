'use strict';
// The instance settings layer — stream-api's reader, and the ONE writer of its tables.
//
// Keys are declared once in config/instance-schema.mjs; ./instanceSchema.generated.js is this package's generated copy.
//
// Precedence for every key, in THIS process: env > database > the schema's neutral default.
// Install-tier keys never read the database. `get(key)` is synchronous and safe before the
// first load (it then answers from env and defaults, exactly like process.env always did) —
// but that state is VISIBLE: `snapshot().state` says whether the layer is loaded and since when.
//
// Tables: site.instance_config (plain JSONB), site.instance_secrets (AES-256-GCM
// under INSTANCE_MASTER_KEY — held by this process ONLY), site.instance_history (every write;
// never a secret value), site.instance_secret_tests (last provider check per key per process).
//
// Security posture:
//   • Every /config route is `requireSecret` — the bearer STREAM_API_SECRET, never the
//     127.0.0.1 allowlist, never a browser (auth.js says why).
//   • Control frames go ONLY to sockets that authenticated with the secret at upgrade
//     (`sendInternal`), never to browsers or overlays.
//   • A provider check's result is a fixed code + numbers (`normalizeCheckResult`); no text a
//     provider returned is stored or shown.
// Fail LOUD, not open:
//   • INSTANCE_MASTER_KEY malformed, or missing / wrong while credentials are stored → exit.
//   • ONE stored credential that will not decrypt → that key resolves as an ERROR (never as the
//     env-less default), shows as an error in /config, and fires an ops alert.
//   • A write whose re-read fails answers 500 and tells nobody to re-read; writes are refused
//     while this process has not loaded the layer.
// INSTANCE_MASTER_KEY is deliberately a separate key from TOKEN_ENC_KEY.

const crypto = require('crypto');
const {
  INSTANCE_KEYS, instanceEntry, parseInstanceValue, resolveInstanceValue, runProviderCheck,
  normalizeCheckResult, describeCheck,
} = require('./instanceSchema.generated.js');

const SELF = 'stream-api';
const OTHERS = ['web', 'stream-ingest'];
const CIPHER_PREFIX = 'v1:';
const READY_TIMEOUT_MS = 10_000;
const RETRY_MS = 30_000;
const TEST_COOLDOWN_MS = 5_000;
const INGEST_TEST_WAIT_MS = 15_000;
const SOURCES = ['env', 'database', 'default', 'unset'];
const TESTS_SQL = 'SELECT key, package, tested_at, ok, detail, source, last4 FROM site.instance_secret_tests';
const UPSERT_TEST_SQL =
  `INSERT INTO site.instance_secret_tests (key, package, tested_at, ok, detail, source, last4)
   VALUES ($1, $2, now(), $3, $4, $5, $6)
   ON CONFLICT (key, package) DO UPDATE SET tested_at = now(), ok = EXCLUDED.ok, detail = EXCLUDED.detail,
     source = EXCLUDED.source, last4 = EXCLUDED.last4`;

// ── crypto ────────────────────────────────────────────────────────────────────────────────
function readMasterKey(env) {
  const hex = (env.INSTANCE_MASTER_KEY || '').trim();
  if (!hex) return { state: 'missing', key: null };
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { state: 'malformed', key: null };
  return { state: 'ok', key: Buffer.from(hex, 'hex') };
}

/** `v1:<iv>:<tag>:<ct>`, base64url. The key NAME is the additional authenticated data, so a
 *  ciphertext moved onto another row fails authentication instead of decrypting.
 *  @test-only exported so the cipher's properties (AAD, tamper, fresh IV) are tested directly. */
function encryptSecret(name, plaintext, mk) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', mk, iv);
  c.setAAD(Buffer.from(name, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `${CIPHER_PREFIX}${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

/** Throws on a malformed value, a wrong key, a tampered value or a value from another row.
 *  @test-only exported so the cipher's refusals are tested directly. */
function decryptSecret(name, stored, mk) {
  if (typeof stored !== 'string' || !stored.startsWith(CIPHER_PREFIX)) throw new Error('not a v1 ciphertext');
  const [ivB, tagB, ctB] = stored.slice(CIPHER_PREFIX.length).split(':');
  if (!ivB || !tagB || !ctB) throw new Error('malformed ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', mk, Buffer.from(ivB, 'base64url'));
  d.setAAD(Buffer.from(name, 'utf8'));
  d.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ctB, 'base64url')), d.final()]).toString('utf8');
}

/** What may be shown of a secret: its last four characters, and only when it is long enough
 *  that four characters say nothing useful about the rest. */
function lastFour(value) {
  const s = String(value ?? '');
  return s.length >= 12 ? s.slice(-4) : '';
}

/** The page-safe rendering of a resolved value: the value for plain keys, `…abcd` for secrets. */
function display(entry, value) {
  if (value === null || value === undefined) return null;
  if (entry.secret) { const l4 = lastFour(value); return l4 ? `…${l4}` : '(set)'; }
  return value;
}

/** A reported `…abcd` / `(set)` display, or null — a reporter cannot store anything longer. */
function safeSecretDisplay(v) {
  return typeof v === 'string' && /^(…[\x21-\x7e]{4}|\(set\))$/.test(v) ? v : null;
}

/** A reported loaded/stale state, reduced to its fixed shape. */
function safeState(s) {
  if (!s || typeof s !== 'object') return null;
  const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  return { loaded: s.loaded === true, loadedAt: iso(s.loadedAt), failingSince: iso(s.failingSince) };
}

/**
 * @test-only the factory exists so tests build an isolated instance with their own env, pool
 * and fetch; production uses the process singleton `instanceConfig` below.
 */
function createInstanceConfig({
  env = null,
  exit = (code) => process.exit(code),
  log = console,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
} = {}) {
  let pool = null;
  let sendInternal = () => 0;
  let notify = () => {};
  let localChecks = {};          // { obs: () => result, homeassistant: async () => result }
  let onAiReport = null;         // (package, body.ai) => Promise — the AI wrapper's (ai.js)
  let writeGuard = null;         // (key, value | undefined) => Promise<null | {error} | {clearSecrets}> — ai.js's
  let plain = {};                // key → value (instance tier rows)
  let plainMeta = {};            // key → { updatedBy, updatedAt }
  let secrets = {};              // key → decrypted value
  let secretMeta = {};           // key → { last4, updatedBy, updatedAt }
  let unreadable = {};           // key → reason (a stored credential that would not decrypt)
  let tests = [];                // instance_secret_tests rows
  const reports = new Map();     // package → { at, state, keys }
  const lastTestAt = new Map();  // key → ms
  const lastCheckAt = new Map(); // key → ms, the doctor's unrecorded runs
  const waiters = new Map();     // nonce → resolve
  let loadedAt = null;           // ms of the last successful load
  let applied = null;            // restart-applied keys, as the first load resolved them
  let failingSince = null;       // ms of the first failure since the last success
  let retryTimer = null;
  // The env is read LIVE for the singleton (env = null): tests and tools replace process.env
  // wholesale, and a captured reference would answer from the object they replaced.
  const envOf = () => env || process.env;
  let master = readMasterKey(envOf());
  function checkMaster() {
    master = readMasterKey(envOf());
    if (master.state === 'malformed') {
      log.error('[instance-config] FATAL: INSTANCE_MASTER_KEY must be 64 hex characters (32 bytes)');
      exit(1);
    }
  }
  if (env) checkMaster();

  // A fixed key, or a concrete key of a pattern (ai.connection.<id>.apiKey) — instanceEntry says which.
  function entryOf(key) { return instanceEntry(key); }

  /** env > DB > default — except that a stored credential which will not decrypt is an ERROR
   *  (unless env overrides it): falling back to the default would hide that the saved value
   *  is gone. */
  function resolveEntry(e) {
    const r = resolveInstanceValue(e, envOf(), e.secret ? secrets : plain);
    if (e.secret && r.source !== 'env' && unreadable[e.key]) {
      return { value: null, source: 'database', envName: null, error: `stored credential cannot be read: ${unreadable[e.key]}` };
    }
    return r;
  }
  function resolve(key) {
    const e = entryOf(key);
    if (!e) throw new Error(`unknown instance key ${key}`);
    return resolveEntry(e);
  }
  function get(key) { return resolve(key).value; }

  function state() {
    return {
      loaded: loadedAt !== null,
      loadedAt: loadedAt !== null ? new Date(loadedAt).toISOString() : null,
      failingSince: failingSince !== null ? new Date(failingSince).toISOString() : null,
      masterKey: master.state,
    };
  }

  async function load() {
    if (!pool) return false;
    let c; let s; let t;
    try {
      [c, s, t] = await Promise.all([
        pool.query('SELECT key, value, updated_by, updated_at FROM site.instance_config'),
        pool.query('SELECT key, ciphertext, last4, updated_by, updated_at FROM site.instance_secrets'),
        pool.query(TESTS_SQL),
      ]);
    } catch (err) {
      if (failingSince === null) failingSince = now();
      throw err;
    }
    const nextPlain = {}; const nextPlainMeta = {};
    for (const r of c.rows) {
      const e = entryOf(r.key);
      if (!e || e.secret || e.tier === 'install') { log.warn(`[instance-config] ignoring stored key ${r.key} (not an instance-tier key in this schema)`); continue; }
      nextPlain[r.key] = r.value;
      nextPlainMeta[r.key] = { updatedBy: r.updated_by, updatedAt: r.updated_at };
    }
    const nextSecrets = {}; const nextSecretMeta = {}; const nextUnreadable = {};
    for (const r of s.rows) {
      const e = entryOf(r.key);
      if (!e || !e.secret) { log.warn(`[instance-config] ignoring stored secret ${r.key} (not a secret key in this schema)`); continue; }
      nextSecretMeta[r.key] = { last4: r.last4, updatedBy: r.updated_by, updatedAt: r.updated_at };
      if (master.state !== 'ok') { nextUnreadable[r.key] = 'INSTANCE_MASTER_KEY is not set'; continue; }
      try { nextSecrets[r.key] = decryptSecret(r.key, r.ciphertext, master.key); }
      catch (err) {
        nextUnreadable[r.key] = ['not a v1 ciphertext', 'malformed ciphertext'].includes(err.message)
          ? err.message : 'authentication failed (wrong key or altered value)';
      }
    }
    const stored = Object.keys(nextSecretMeta).length;
    const bad = Object.keys(nextUnreadable);
    if (stored > 0 && bad.length === stored) {
      log.error(`[instance-config] FATAL: ${stored} stored credential(s) and ` +
        (master.state === 'ok' ? 'INSTANCE_MASTER_KEY decrypts none of them (wrong key?)' : 'INSTANCE_MASTER_KEY is not set') +
        ' — refusing to run with those credentials silently gone. Restore the INSTANCE_MASTER_KEY they were saved under.');
      exit(1);
      return false;
    }
    const newlyBad = bad.filter((k) => !unreadable[k]);
    plain = nextPlain; plainMeta = nextPlainMeta; secrets = nextSecrets; secretMeta = nextSecretMeta;
    unreadable = nextUnreadable; tests = t.rows;
    loadedAt = now(); failingSince = null;
    if (applied === null) {
      // What a restart-applied key is run with: taken once, at the first load (selfStatus).
      applied = {};
      for (const e of INSTANCE_KEYS) if (e.reload === 'restart' && e.packages.includes(SELF)) applied[e.key] = resolveEntry(e).value;
    }
    markLoaded(true);
    if (newlyBad.length) {
      for (const k of newlyBad) {
        log.error(`[instance-config] stored credential ${k} cannot be read: ${unreadable[k]} — it resolves as an ERROR until it is saved again or env overrides it`);
      }
      // Key NAMES only: ntfy topics are unauthenticated, so anyone who knows one can read it.
      notify('instance.credential-unreadable', 'Stored credential unreadable',
        `stream-api cannot decrypt: ${newlyBad.join(', ')}. Re-save it in the Admin Panel, or check INSTANCE_MASTER_KEY.`);
    }
    return true;
  }

  let markReady;
  const ready = new Promise((r) => { markReady = r; });
  // Settles on the FIRST successful load only — never on the timeout or a failure. What must not
  // act on env + defaults alone (the module switches) waits on this.
  let markLoaded;
  const loaded = new Promise((r) => { markLoaded = r; });

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      load().then((ok) => { if (!ok) scheduleRetry(); else log.log('[instance-config] loaded after retry'); })
        .catch((e) => { log.warn(`[instance-config] load retry failed: ${e.message}`); scheduleRetry(); });
    }, RETRY_MS);
    retryTimer.unref?.();
  }

  /** Wire the pool, the internal-socket sender and the notifier, and start the first load.
   *  `ready` settles on the first load's outcome or after READY_TIMEOUT_MS — a DB blip at boot
   *  must not stop the process; until a load lands, env and defaults answer, and
   *  `state().loaded` says so. */
  function init(deps) {
    checkMaster();
    pool = deps.pool;
    if (deps.sendInternal) sendInternal = deps.sendInternal;
    if (deps.notify) notify = deps.notify;
    if (deps.localChecks) localChecks = deps.localChecks;
    if (deps.onAiReport) onAiReport = deps.onAiReport;
    if (deps.writeGuard) writeGuard = deps.writeGuard;
    if (master.state === 'missing') {
      log.warn('[instance-config] INSTANCE_MASTER_KEY is not set — stored credentials cannot be read or saved (env credentials still work)');
    }
    const timer = setTimeout(() => {
      log.warn(`[instance-config] first load still pending after ${READY_TIMEOUT_MS / 1000}s — continuing on env + defaults`);
      markReady(false);
    }, READY_TIMEOUT_MS);
    timer.unref?.();
    load()
      .then((ok) => { clearTimeout(timer); markReady(ok); if (ok) logBoot(); else scheduleRetry(); })
      .catch((e) => { clearTimeout(timer); log.warn(`[instance-config] first load failed: ${e.message} — retrying every ${RETRY_MS / 1000}s`); markReady(false); scheduleRetry(); });
    return ready;
  }

  function logBoot() {
    const bySource = {};
    for (const e of INSTANCE_KEYS) {
      if (!e.packages.includes(SELF)) continue;
      const r = resolveEntry(e);
      if (r.error) log.error(`[instance-config] ${e.key}: ${r.error}`);
      bySource[r.source] = (bySource[r.source] || 0) + 1;
    }
    log.log(`[instance-config] loaded — ${Object.keys(plain).length} stored value(s), ${Object.keys(secretMeta).length} stored credential(s); ` +
      `this process: ${Object.entries(bySource).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }

  /** This process's own view of every key it consumes: source, the env name that won, the
   *  page-safe display, any error. Never a secret value. A `reload: 'restart'` key shows the value
   *  this process took at its first load — what it RUNS — so a saved change reads as pending until
   *  the restart (the Admin Panel's "Pending restart"). */
  function selfStatus() {
    const out = {};
    for (const e of INSTANCE_KEYS) {
      if (!e.packages.includes(SELF)) continue;
      const r = resolveEntry(e);
      const value = applied && e.reload === 'restart' && Object.prototype.hasOwnProperty.call(applied, e.key) ? applied[e.key] : r.value;
      out[e.key] = { source: r.source, envName: r.envName, display: display(e, value), error: r.error };
    }
    return out;
  }

  function refuse(status, error) { return { status, body: { error } }; }
  function checkWritable(key, updatedBy, internal = false) {
    const e = entryOf(key);
    if (!e) return { refusal: refuse(404, `unknown key ${key}`) };
    if (e.tier === 'install') return { refusal: refuse(400, `${key} is install-tier: it is set in env by the installer, not here`) };
    // A key with a declared writer (memory.state) is written by that process's own flows only.
    if (e.writer && !internal) return { refusal: refuse(400, `${key} is written by ${e.writer} itself, not by an edit`) };
    if (typeof updatedBy !== 'string' || !updatedBy.trim() || updatedBy.length > 200) {
      return { refusal: refuse(400, 'updatedBy (who is making this change) is required') };
    }
    // A process that has not loaded the layer would write history against nothing and then
    // keep answering from env + defaults while every other process reads the new row.
    if (loadedAt === null) return { refusal: refuse(503, 'stream-api has not loaded the settings layer yet — try again shortly') };
    return { entry: e };
  }

  // ── writes ───────────────────────────────────────────────────────────────────────────────
  async function write(key, value, updatedBy, { internal = false } = {}) {
    const { entry: e, refusal } = checkWritable(key, updatedBy, internal);
    if (refusal) return refusal;
    const parsed = parseInstanceValue(e, value);
    if (!parsed.ok) return refuse(400, `${key}: ${parsed.error}`);
    if (e.secret && master.state !== 'ok') return refuse(503, 'INSTANCE_MASTER_KEY is not set on stream-api — credentials cannot be stored');
    // A key's meaning beyond its shape (does that slot exist? is that connection still used?) is
    // the owning module's check. A process's own flows (`internal`) are that module already.
    const guard = writeGuard && !internal ? await writeGuard(key, parsed.value) : null;
    if (guard && guard.error) return refuse(guard.status || 400, guard.error);
    const toClear = guard && Array.isArray(guard.clearSecrets) ? guard.clearSecrets.filter((k) => entryOf(k)?.secret) : [];
    let alsoClear = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      alsoClear = await clearSecretsIn(client, toClear, updatedBy.trim());
      if (e.secret) {
        const ct = encryptSecret(key, parsed.value, master.key);
        const l4 = lastFour(parsed.value);
        await client.query(
          `INSERT INTO site.instance_secrets (key, ciphertext, last4, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (key) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, last4 = EXCLUDED.last4,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, ct, l4, updatedBy.trim()]);
        await client.query(
          `INSERT INTO site.instance_history (key, tier, action, last4, updated_by) VALUES ($1, 'secret', 'set', $2, $3)`,
          [key, l4, updatedBy.trim()]);
      } else {
        const old = await client.query('SELECT value FROM site.instance_config WHERE key = $1 FOR UPDATE', [key]);
        await client.query(
          `INSERT INTO site.instance_config (key, value, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(parsed.value), updatedBy.trim()]);
        await client.query(
          `INSERT INTO site.instance_history (key, tier, action, old_value, new_value, updated_by)
           VALUES ($1, 'instance', 'set', $2::jsonb, $3::jsonb, $4)`,
          [key, old.rows[0] ? JSON.stringify(old.rows[0].value) : null, JSON.stringify(parsed.value), updatedBy.trim()]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const failed = await afterWrite([key, ...alsoClear]);
    if (failed) return failed;
    return { status: 200, body: { ok: true, key, ...(alsoClear.length ? { cleared: alsoClear } : {}), self: e.packages.includes(SELF) ? selfStatus()[key] ?? null : null } };
  }

  async function clear(key, updatedBy) {
    const { entry: e, refusal } = checkWritable(key, updatedBy);
    if (refusal) return refusal;
    const guard = writeGuard ? await writeGuard(key, undefined) : null;
    if (guard && guard.error) return refuse(guard.status || 400, guard.error);
    const toClear = guard && Array.isArray(guard.clearSecrets) ? guard.clearSecrets.filter((k) => entryOf(k)?.secret) : [];
    let alsoClear = [];
    const client = await pool.connect();
    let removed = 0;
    try {
      await client.query('BEGIN');
      alsoClear = await clearSecretsIn(client, toClear, updatedBy.trim());
      removed += alsoClear.length;
      if (e.secret) {
        const r = await client.query('DELETE FROM site.instance_secrets WHERE key = $1', [key]);
        removed = r.rowCount;
        if (removed) {
          await client.query(`INSERT INTO site.instance_history (key, tier, action, updated_by) VALUES ($1, 'secret', 'clear', $2)`,
            [key, updatedBy.trim()]);
        }
      } else {
        const r = await client.query('DELETE FROM site.instance_config WHERE key = $1 RETURNING value', [key]);
        removed = r.rowCount;
        if (removed) {
          await client.query(
            `INSERT INTO site.instance_history (key, tier, action, old_value, updated_by) VALUES ($1, 'instance', 'clear', $2::jsonb, $3)`,
            [key, JSON.stringify(r.rows[0].value), updatedBy.trim()]);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (removed) {
      const failed = await afterWrite([key, ...alsoClear]);
      if (failed) return failed;
    }
    return { status: 200, body: { ok: true, key, removed: removed > 0, ...(alsoClear.length ? { cleared: alsoClear } : {}) } };
  }

  /** Delete stored credentials inside the caller's transaction, with a history row each — the
   *  write guard's "this key no longer belongs to anything" (a removed connection, or one whose
   *  address changed: a key is bound to its origin). Resolves the keys that
   *  were actually stored and are now gone. */
  async function clearSecretsIn(client, keys, by) {
    const gone = [];
    for (const k of keys) {
      const r = await client.query('DELETE FROM site.instance_secrets WHERE key = $1', [k]);
      if (r.rowCount) {
        gone.push(k);
        await client.query(`INSERT INTO site.instance_history (key, tier, action, updated_by) VALUES ($1, 'secret', 'clear', $2)`, [k, by]);
      }
    }
    return gone;
  }

  /** Re-read, then — only on success — tell the other processes. A failed re-read is the
   *  writer's error: the row IS committed, but this process would keep answering the old value,
   *  so "saved" (or telling others to re-read) would misdescribe the whole install. The retry
   *  loop picks it up; the others' periodic re-read is their backstop. */
  async function afterWrite(keys) {
    let ok = false;
    try { ok = await load(); } catch (err) { log.error(`[instance-config] re-read after write failed: ${err.message}`); }
    if (!ok) { scheduleRetry(); return refuse(500, 'saved, but stream-api could not re-read the settings — it is retrying; check its journal'); }
    sendInternal({ type: 'config_changed', keys });
    for (const fn of writeListeners) { try { fn(keys); } catch (err) { log.warn(`[instance-config] write listener: ${err.message}`); } }
    return null;
  }
  // This process's own modules told after every committed write (memory re-probes a paused
  // embedder when its key or connection changes).
  const writeListeners = new Set();
  function onWrite(fn) { writeListeners.add(fn); return () => writeListeners.delete(fn); }

  // ── reports + tests ──────────────────────────────────────────────────────────────────────
  /** Another process's env report and/or test results. Sanitised to fixed shapes: only keys
   *  that package consumes, a `…abcd` display at most for a secret, a value that parses for a
   *  plain key, a check result reduced by normalizeCheckResult — a buggy or forged reporter
   *  cannot store a value or a text. */
  async function report(body) {
    const pkg = body && body.package;
    if (!OTHERS.includes(pkg)) return refuse(400, 'package must be web or stream-ingest');
    if (body.keys && typeof body.keys === 'object') {
      const keys = {};
      for (const [k, v] of Object.entries(body.keys)) {
        const e = entryOf(k);
        if (!e || !e.packages.includes(pkg) || !v || typeof v !== 'object') continue;
        const source = SOURCES.includes(v.source) ? v.source : 'unset';
        const envName = typeof v.envName === 'string' && e.env.includes(v.envName) ? v.envName : null;
        let shown;
        if (e.secret) shown = safeSecretDisplay(v.display);
        else { const p = v.display == null ? null : parseInstanceValue(e, v.display); shown = p && p.ok ? p.value : null; }
        keys[k] = { source, envName, display: shown, error: v.error ? 'this process reports an error for this key — see its journal' : null };
      }
      reports.set(pkg, { at: new Date(now()).toISOString(), state: safeState(body.state), keys });
    }
    if (pkg === 'stream-ingest' && body.ai && onAiReport) {
      try { await onAiReport(pkg, body.ai); } catch (err) { log.warn(`[instance-config] AI report from ${pkg} not recorded: ${err.message}`); }
    }
    // An answer to ask(): the asker sanitises it (it alone knows the shape it asked for).
    if (pkg === 'stream-ingest' && body.reply && typeof body.reply === 'object' && typeof body.reply.nonce === 'string' && waiters.has(body.reply.nonce)) {
      waiters.get(body.reply.nonce)(body.reply.result);
    }
    for (const t of Array.isArray(body.tests) ? body.tests : []) {
      const e = t && entryOf(t.key);
      if (!e || !e.secret || !e.packages.includes(pkg)) continue;
      const row = await saveTest(e.key, pkg, t.result,
        SOURCES.includes(t.source) ? t.source : null,
        typeof t.last4 === 'string' && /^[\x21-\x7e]{4}$/.test(t.last4) ? t.last4 : null);
      if (typeof t.nonce === 'string' && waiters.has(t.nonce)) waiters.get(t.nonce)(row);
    }
    return { status: 200, body: { ok: true } };
  }

  async function saveTest(key, pkg, raw, source, last4) {
    const result = normalizeCheckResult(raw);
    const row = { key, package: pkg, ok: result.ok, detail: describeCheck(result), source, last4 };
    await pool.query(UPSERT_TEST_SQL, [row.key, row.package, row.ok, row.detail, row.source, row.last4]);
    tests = (await pool.query(TESTS_SQL)).rows;
    return row;
  }

  /** Run a key's provider check in every consuming process this side can reach: here, and
   *  stream-ingest through a `config_test` frame on the INTERNAL sockets only (it answers on
   *  /config/report). Web runs its own and reports it.
   *  record:false — the doctor's read-only run: this process's check only, nothing stored; a
   *  stream-ingest key is not run (its answer arrives as a stored report). */
  async function test(key, { record = true } = {}) {
    const e = entryOf(key);
    if (!e || !e.secret) return refuse(404, `unknown credential ${key}`);
    if (!e.test) return refuse(400, `no test available for ${key}`);
    const stamps = record ? lastTestAt : lastCheckAt;
    const last = stamps.get(key) || 0;
    if (now() - last < TEST_COOLDOWN_MS) return refuse(429, 'tested a moment ago — wait a few seconds');
    stamps.set(key, now());
    const results = [];
    if (e.packages.includes(SELF)) {
      const r = resolve(key);
      let raw;
      if (localChecks[e.test]) raw = await Promise.resolve().then(() => localChecks[e.test]()).catch(() => ({ ok: false, code: 'request_failed' }));
      else raw = await runProviderCheck(e.test, get, fetchImpl);
      if (record) results.push(await saveTest(key, SELF, raw || { ok: false, code: 'no_check' }, r.source, lastFour(r.value) || null));
      else {
        const result = normalizeCheckResult(raw || { ok: false, code: 'no_check' });
        results.push({ key, package: SELF, ok: result.ok, detail: describeCheck(result), source: r.source, last4: lastFour(r.value) || null });
      }
    }
    if (e.packages.includes('stream-ingest') && !record) {
      results.push({ key, package: 'stream-ingest', ok: null, detail: 'not run by the doctor (stream-ingest stores its result)', unrun: true });
    } else if (e.packages.includes('stream-ingest')) {
      const nonce = crypto.randomBytes(9).toString('base64url');
      let settle;
      const answer = new Promise((res) => { settle = res; });
      const timer = setTimeout(() => settle(null), INGEST_TEST_WAIT_MS);
      timer.unref?.();
      waiters.set(nonce, (v) => settle(v));
      const delivered = sendInternal({ type: 'config_test', key, nonce });
      const a = delivered > 0 ? await answer : null;
      clearTimeout(timer);
      waiters.delete(nonce);
      results.push(a || {
        key, package: 'stream-ingest', ok: false, source: null, last4: null,
        detail: delivered > 0 ? describeCheck({ code: 'unanswered' }) : 'stream-ingest is not connected to stream-api',
        unanswered: true,
      });
    }
    return { status: 200, body: { ok: true, key, results } };
  }

  /** Ask stream-ingest to run something only it can (it holds keys this process may not), over
   *  the INTERNAL sockets only; it answers on /config/report as `reply`. Resolves the raw
   *  result, or null when it is not connected or does not answer in time. The frame type must
   *  start `config_` (ingest's socket only parses those). */
  async function ask(frame, waitMs = INGEST_TEST_WAIT_MS) {
    const nonce = crypto.randomBytes(9).toString('base64url');
    let settle;
    const answer = new Promise((res) => { settle = res; });
    const timer = setTimeout(() => settle(null), waitMs);
    timer.unref?.();
    waiters.set(nonce, (v) => settle(v === undefined ? null : v));
    const delivered = sendInternal({ ...frame, nonce });
    const a = delivered > 0 ? await answer : null;
    clearTimeout(timer);
    waiters.delete(nonce);
    return { delivered: delivered > 0, result: a };
  }

  /** GET /config — the DB layer (plain values only), this process's state and view, the other
   *  processes' reports, the last tests. NEVER a secret value: secrets appear as their stored
   *  last4, who/when, and whether this process can read them. */
  function snapshot() {
    const secretsOut = {};
    for (const [k, m] of Object.entries(secretMeta)) {
      secretsOut[k] = { last4: m.last4, updatedBy: m.updatedBy, updatedAt: m.updatedAt, readable: !unreadable[k], error: unreadable[k] || null };
    }
    return {
      state: state(),
      values: { ...plain },
      meta: { ...plainMeta },
      secrets: secretsOut,
      self: selfStatus(),
      reports: Object.fromEntries(reports),
      tests: tests.map((t) => ({ key: t.key, package: t.package, testedAt: t.tested_at, ok: t.ok, detail: t.detail, source: t.source, last4: t.last4 })),
      // What this process can do that an older one cannot: web asks before it relies on it.
      features: ['test-unrecorded'],
    };
  }

  /** GET /config/secrets?package= — decrypted stored credentials for the keys that package
   *  consumes, plus the NAMES of stored ones this process could not read (so the caller
   *  resolves them as errors too, not as defaults). */
  function secretsFor(pkg) {
    const values = {};
    const unreadableKeys = [];
    for (const e of INSTANCE_KEYS) {
      if (!e.secret || !e.packages.includes(pkg)) continue;
      if (Object.prototype.hasOwnProperty.call(secrets, e.key)) values[e.key] = secrets[e.key];
      else if (unreadable[e.key]) unreadableKeys.push(e.key);
    }
    // Pattern keys (one per custom AI connection) are not in INSTANCE_KEYS: send the stored ones.
    for (const k of new Set([...Object.keys(secrets), ...Object.keys(unreadable)])) {
      const e = entryOf(k);
      if (!e || !e.secret || INSTANCE_KEYS.some((f) => f.key === k) || !e.packages.includes(pkg)) continue;
      if (Object.prototype.hasOwnProperty.call(secrets, k)) values[k] = secrets[k];
      else unreadableKeys.push(k);
    }
    return { values, unreadable: unreadableKeys, state: state() };
  }

  function registerConfigRoutes(app, { requireSecret, wrap }) {
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    app.get('/config', requireSecret, (_req, res) => {
      noStore(res);
      res.json(snapshot());
    });
    app.get('/config/secrets', requireSecret, (req, res) => {
      noStore(res);
      const pkg = String(req.query.package || '');
      if (!OTHERS.includes(pkg)) return res.status(400).json({ error: 'package must be web or stream-ingest' });
      return res.json(secretsFor(pkg));
    });
    app.put('/config/:key', requireSecret, wrap(async (req, res) => {
      noStore(res);
      const r = await write(req.params.key, req.body?.value, req.body?.updatedBy);
      res.status(r.status).json(r.body);
    }));
    app.delete('/config/:key', requireSecret, wrap(async (req, res) => {
      noStore(res);
      const r = await clear(req.params.key, req.body?.updatedBy);
      res.status(r.status).json(r.body);
    }));
    app.post('/config/report', requireSecret, wrap(async (req, res) => {
      noStore(res);
      const r = await report(req.body);
      res.status(r.status).json(r.body);
    }));
    app.post('/config/test/:key', requireSecret, wrap(async (req, res) => {
      noStore(res);
      const r = await test(req.params.key, { record: req.body?.record !== false });
      res.status(r.status).json(r.body);
    }));
  }

  /** This process's own write to a key it is the declared writer of (memory.state). */
  function writeInternal(key, value, updatedBy) {
    return write(key, value, updatedBy, { internal: true });
  }

  return { init, ready, loaded, get, resolve, registerConfigRoutes, write, writeInternal, clear, report, test, snapshot, secretsFor, load, ask, onWrite };
}

/** The process singleton every stream-api module reads through. */
const instanceConfig = createInstanceConfig();

module.exports = { instanceConfig, createInstanceConfig, encryptSecret, decryptSecret };
