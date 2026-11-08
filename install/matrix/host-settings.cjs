'use strict';
// Settings the HOST renders into the sign-in service's config, read the way stream-api reads them.
// `blackbranch` runs a reader (mail.cjs, signin.cjs) with node inside the stream-api image, on the
// bundle network, with stream-api's own environment (its database login and INSTANCE_MASTER_KEY),
// exactly as the backup target is read (install/backup/target.cjs): each key resolves as stream-api
// resolves it (env > database > the schema's default), and a secret is decrypted with stream-api's
// own decryptSecret. Nothing here is a route.

const APP = process.env.BB_APP_DIR || '/app';
const { Pool } = require(`${APP}/node_modules/pg`);
const { decryptSecret } = require(`${APP}/instance-config.js`);
const { INSTANCE_KEYS, resolveInstanceValue, signinProviderId } = require(`${APP}/instanceSchema.generated.js`);

/** key → its resolved value as text ('' when unset). Throws with the reason when one is unusable. */
async function resolveKeys(keys, what) {
  const entries = keys.map((k) => INSTANCE_KEYS.find((e) => e.key === k));
  if (entries.some((e) => !e)) throw new Error(`this release's schema lacks a ${what} key`);
  const pool = new Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 1, connectionTimeoutMillis: 10_000,
  });
  const db = {};
  try {
    for (const r of (await pool.query('SELECT key, value FROM site.instance_config WHERE key = ANY($1)', [keys])).rows) db[r.key] = r.value;
    const secrets = (await pool.query('SELECT key, ciphertext FROM site.instance_secrets WHERE key = ANY($1)', [keys])).rows;
    if (secrets.length) {
      const hex = (process.env.INSTANCE_MASTER_KEY || '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`INSTANCE_MASTER_KEY is not set, so the saved ${what} secrets cannot be read`);
      for (const r of secrets) {
        try { db[r.key] = decryptSecret(r.key, r.ciphertext, Buffer.from(hex, 'hex')); }
        catch { throw new Error(`${r.key} does not decrypt with INSTANCE_MASTER_KEY — save it again in the Admin Panel`); }
      }
    }
  } finally { await pool.end().catch(() => {}); }

  const out = {};
  for (const e of entries) {
    const r = resolveInstanceValue(e, process.env, db);
    if (r.error) throw new Error(`${e.key}: ${r.error}`);
    const v = r.value === null || r.value === undefined ? '' : String(r.value);
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${e.key} holds a control character`);
    out[e.key] = v;
  }
  return out;
}

/** Runs `main`, which returns KEY=value lines for the host (it keeps them root-only), or exits 1
 *  with the reason on stderr when a value is unusable. render.sh checks every value again. */
function runReader(main) {
  main().then((lines) => { process.stdout.write(`${lines.join('\n')}\n`); },
    (e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}

module.exports = { INSTANCE_KEYS, resolveKeys, runReader, signinProviderId };
