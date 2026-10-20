// One-time migration: encrypt existing plaintext Matrix tokens in site.users.
//
// Idempotent — rows already encrypted ("v1:") are skipped, so it is safe to
// re-run. MUST be run AFTER the web app that understands encrypted tokens is
// deployed, and with the SAME TOKEN_ENC_KEY the web app uses.
//
// Usage (from a machine that reaches the database):
//   TOKEN_ENC_KEY=<64 hex> DATABASE_URL=<pg url> node scripts/encrypt-tokens.mjs
//
// Dry run (no writes):  add  DRY_RUN=1

import { createCipheriv, randomBytes } from "node:crypto";
import pg from "pg";

const KEY_HEX = process.env.TOKEN_ENC_KEY;
const DB = process.env.DATABASE_URL;
const DRY = process.env.DRY_RUN === "1";

if (!KEY_HEX || !/^[0-9a-fA-F]{64}$/.test(KEY_HEX)) {
  console.error("TOKEN_ENC_KEY must be 64 hex chars (32 bytes)"); process.exit(1);
}
if (!DB) { console.error("DATABASE_URL required"); process.exit(1); }
const key = Buffer.from(KEY_HEX, "hex");

function enc(plaintext) {
  if (plaintext == null) return null;
  if (plaintext.startsWith("v1:")) return plaintext; // already encrypted
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

const pool = new pg.Pool({ connectionString: DB });

const { rows } = await pool.query(
  `SELECT matrix_id, mx_access_token, mx_refresh_token
   FROM site.users
   WHERE mx_access_token IS NOT NULL OR mx_refresh_token IS NOT NULL`
);

let updated = 0, skipped = 0;
for (const r of rows) {
  const aEnc = enc(r.mx_access_token);
  const rEnc = enc(r.mx_refresh_token);
  const aChanged = aEnc !== r.mx_access_token;
  const rChanged = rEnc !== r.mx_refresh_token;
  if (!aChanged && !rChanged) { skipped++; continue; }
  if (DRY) { console.log(`[dry] would encrypt ${r.matrix_id} (access:${aChanged} refresh:${rChanged})`); updated++; continue; }
  await pool.query(
    `UPDATE site.users SET mx_access_token = $1, mx_refresh_token = $2 WHERE matrix_id = $3`,
    [aEnc, rEnc, r.matrix_id]
  );
  console.log(`encrypted ${r.matrix_id}`);
  updated++;
}

console.log(`\nDone. rows=${rows.length} ${DRY ? "would-update" : "updated"}=${updated} already-encrypted/skipped=${skipped}`);
await pool.end();
