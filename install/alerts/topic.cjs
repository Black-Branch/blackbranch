'use strict';
// The site's alert topics (ntfy.wakeUrl / ntfy.quietUrl — Admin Panel → Site → Site, card Alerts to
// your phone), read for the HOST's own alerts when .env names no topic of its own. `blackbranch` runs
// this with node inside the stream-api image, with stream-api's own environment, exactly as the
// backup target is read (install/backup/target.cjs): env > database, decrypted with stream-api's
// decryptSecret, and one topic set takes both kinds, as stream-api's notify.js does.
//
// Prints NTFY_WAKE= and NTFY_QUIET= lines on stdout for the host (which keeps them root-only and
// never prints them); exits 1 with the reason on stderr when a stored topic cannot be read.

const APP = process.env.BB_APP_DIR || '/app';
const { Pool } = require(`${APP}/node_modules/pg`);
const { decryptSecret } = require(`${APP}/instance-config.js`);
const { INSTANCE_KEYS, resolveInstanceValue } = require(`${APP}/instanceSchema.generated.js`);

const KEYS = ['ntfy.wakeUrl', 'ntfy.quietUrl'];

async function main() {
  const entries = KEYS.map((k) => INSTANCE_KEYS.find((e) => e.key === k));
  if (entries.some((e) => !e)) throw new Error('this release\'s schema lacks an alert topic key');
  const pool = new Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 1, connectionTimeoutMillis: 10_000,
  });
  const db = {};
  try {
    const rows = (await pool.query('SELECT key, ciphertext FROM site.instance_secrets WHERE key = ANY($1)', [KEYS])).rows;
    if (rows.length) {
      const hex = (process.env.INSTANCE_MASTER_KEY || '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('INSTANCE_MASTER_KEY is not set, so the saved alert topics cannot be read');
      for (const r of rows) {
        try { db[r.key] = decryptSecret(r.key, r.ciphertext, Buffer.from(hex, 'hex')); }
        catch { throw new Error(`${r.key} does not decrypt with INSTANCE_MASTER_KEY — save it again in the Admin Panel`); }
      }
    }
  } finally { await pool.end().catch(() => {}); }

  const topic = (e) => {
    const r = resolveInstanceValue(e, process.env, db);
    const v = String(r.value ?? '').trim().replace(/\/+$/, '');
    // Only an http(s) address on one line is a topic (the host checks it again before curl sees it).
    return /^https?:\/\/[^\s"\\]+$/.test(v) ? v : '';
  };
  const [w, q] = entries.map(topic);
  process.stdout.write(`NTFY_WAKE=${w || q}\nNTFY_QUIET=${q || w}\n`);
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
