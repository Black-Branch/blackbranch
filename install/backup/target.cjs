'use strict';
// Where backups go — read for the HOST. `blackbranch` runs this with node inside the
// stream-api image, on the bundle network, with stream-api's own environment (its database login
// and INSTANCE_MASTER_KEY): the backup.* keys resolve exactly as stream-api resolves them (env >
// database > the schema's default, the release's generated resolver), and the secret-tier keys are
// decrypted with stream-api's own decryptSecret. Nothing here is a route: no process hands a secret
// over the network, and the site's only part is the key it saved and the verb it asked for.
//
// Prints KEY=value lines on stdout for the host (which keeps them root-only); exits 1 with the reason
// on stderr when a value is unusable. The host checks every value again before restic sees it.

const APP = process.env.BB_APP_DIR || '/app';
const { Pool } = require(`${APP}/node_modules/pg`);
const { decryptSecret } = require(`${APP}/instance-config.js`);
const { INSTANCE_KEYS, resolveInstanceValue, checkBackupTarget } = require(`${APP}/instanceSchema.generated.js`);

/** schema key → the host's name for it. install/backup.test.mjs checks it covers every backup.* key. */
const OUT = {
  'backup.target': 'BK_TARGET',
  'backup.repository': 'BK_REPOSITORY',
  'backup.s3.region': 'BK_S3_REGION',
  'backup.s3.accessKeyId': 'BK_S3_ACCESS_KEY_ID',
  'backup.s3.secretAccessKey': 'BK_S3_SECRET_ACCESS_KEY',
  'backup.keepDaily': 'BK_KEEP_DAILY',
  'backup.keepWeekly': 'BK_KEEP_WEEKLY',
};

async function main() {
  const entries = INSTANCE_KEYS.filter((e) => Object.prototype.hasOwnProperty.call(OUT, e.key));
  if (entries.length !== Object.keys(OUT).length) throw new Error('this release\'s schema lacks a backup key');
  const keys = entries.map((e) => e.key);
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
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('INSTANCE_MASTER_KEY is not set, so the saved backup keys cannot be read');
      for (const r of secrets) {
        try { db[r.key] = decryptSecret(r.key, r.ciphertext, Buffer.from(hex, 'hex')); }
        catch { throw new Error(`${r.key} does not decrypt with INSTANCE_MASTER_KEY — save it again in the Admin Panel`); }
      }
    }
  } finally { await pool.end().catch(() => {}); }

  const lines = [];
  const val = {};
  for (const e of entries) {
    const r = resolveInstanceValue(e, process.env, db);
    if (r.error) throw new Error(`${e.key}: ${r.error}`);
    const v = r.value === null || r.value === undefined ? '' : String(r.value);
    // One line each; the host refuses anything else too.
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${e.key} holds a control character`);
    lines.push(`${OUT[e.key]}=${v}`);
    val[e.key] = v;
  }
  // The settings layer's own rule for the target and its address (the box checks it again, with the
  // resolved address, before restic runs).
  const t = checkBackupTarget(val['backup.target'] || 'local', val['backup.repository']);
  if (!t.ok) throw new Error(`the backup address is refused: ${t.error}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
