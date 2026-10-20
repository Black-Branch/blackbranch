// `blackbranch restore <snapshot> --verify`'s judge. run.sh restores the snapshot into a
// scratch folder, loads its dumps into a scratch Postgres and writes what it saw (facts.json); this
// file reads the restored files and says whether the backup would bring the site back:
//   dumps       each of the three databases loaded without an error
//   tables      each database has as many tables as when it was backed up (a missing table = red)
//   token       one stored token decrypts with the TOKEN_ENC_KEY in the snapshot's own .env
//               (none stored yet = said so, not red)
//   signingKey  the homeserver's signing key is there, readable, and the one that was backed up —
//               its loss is unrecoverable
//   masKeys     MAS's keys are there and unchanged
//   env         the snapshot's .env holds the secrets a restore needs
//   media       the media store came back whole — when the disk had room to read it back. When it
//               had not, that is said (never "checked"): the result's mediaChecked is false, and
//               mediaSample is the percent of the stored data run.sh read and checked instead
// Prints one line `BBRESULT {json}` (counts, ids and fixed words only — never a secret) and exits
// 1 when any check fails. Imports nothing but node's own modules.
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DATABASES = ["stream", "synapse", "mas"];
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** One value from .env text (unquoted as Compose reads it), or "". */
export function envValue(text, key) {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text || "");
  if (!m) return "";
  const v = m[1].trim();
  return /^".*"$/.test(v) || /^'.*'$/.test(v) ? v.slice(1, -1) : v;
}

/** The site's token format (web/app/lib/tokenCrypto.ts): v1:<iv>:<tag>:<ciphertext>, AES-256-GCM. */
export function decryptToken(stored, hexKey) {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey || "")) return false;
  const [, iv, tag, ct] = String(stored).split(":");
  try {
    const d = createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
    return true;
  } catch { return false; }
}

/** Synapse's signing.key: `ed25519 <version> <unpadded base64 of a 32-byte seed>`. */
function signingKeyProblem(text) {
  const line = (text || "").split("\n")[0].trim();
  const m = /^ed25519 ([A-Za-z0-9_]+) ([A-Za-z0-9+/]+=*)$/.exec(line);
  if (!m) return "not in Synapse's signing key format";
  if (Buffer.from(m[2], "base64").length !== 32) return "its key is not 32 bytes";
  return null;
}

/**
 * The verdict. Pure: every input is text or numbers already read.
 * @param {{ manifest: any, facts: any, env: string|null, signingKey: string|null, masKeys: string|null, at?: string }} x
 */
export function judgeVerify(x) {
  const m = x.manifest || {};
  const f = x.facts || {};
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  const notLoaded = DATABASES.filter((db) => !(f.loaded && f.loaded[db] === true));
  add("dumps", notLoaded.length === 0, notLoaded.length ? `${notLoaded.join(", ")} did not load` : "all three loaded");

  const tableIssues = [];
  for (const db of DATABASES) {
    const want = m.databases && m.databases[db] ? m.databases[db].tables : null;
    const got = f.tables ? f.tables[db] : null;
    if (typeof want !== "number") tableIssues.push(`${db}: the backup recorded no table count`);
    else if (typeof got !== "number") tableIssues.push(`${db}: not loaded`);
    else if (got !== want) tableIssues.push(`${db}: ${got} tables, the backup recorded ${want}${got < want ? " (a table is missing)" : ""}`);
    else if (got === 0) tableIssues.push(`${db}: no tables at all`);
  }
  add("tables", tableIssues.length === 0, tableIssues.length ? tableIssues.join("; ")
    : DATABASES.map((db) => `${db} ${f.tables[db]}`).join(" · "));

  let token = "none";
  if (typeof f.token === "string" && f.token) {
    token = decryptToken(f.token, envValue(x.env, "TOKEN_ENC_KEY")) ? "ok" : "fail";
  }
  add("token", token !== "fail", token === "ok" ? "one stored token decrypts with the snapshot's TOKEN_ENC_KEY"
    : token === "none" ? "none stored yet" : "a stored token does not decrypt with the snapshot's TOKEN_ENC_KEY");

  if (x.signingKey == null) add("signingKey", false, "missing — the homeserver's identity cannot be recovered without it");
  else {
    const bad = signingKeyProblem(x.signingKey);
    const want = m.signingKey && m.signingKey.sha256;
    if (bad) add("signingKey", false, bad);
    else if (!want) add("signingKey", false, "the backup recorded no signing key");
    else if (sha256(x.signingKey) !== want) add("signingKey", false, "differs from the key that was backed up");
    else add("signingKey", true, `readable, ${m.signingKey.keyId || "unchanged"}`);
  }

  if (x.masKeys == null || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(x.masKeys)) add("masKeys", false, "MAS's keys are missing");
  else if (m.masKeys && m.masKeys.sha256 && sha256(x.masKeys) !== m.masKeys.sha256) add("masKeys", false, "differ from the keys that were backed up");
  else add("masKeys", true, "present");

  const envMissing = x.env == null ? ["the file"]
    : ["TOKEN_ENC_KEY", "INSTANCE_MASTER_KEY", "POSTGRES_PASSWORD", "BACKUP_PASSPHRASE"].filter((k) => !envValue(x.env, k));
  add("env", envMissing.length === 0, envMissing.length ? `.env lacks ${envMissing.join(", ")}` : "holds the secrets a restore needs");

  const wantMedia = m.media && typeof m.media.files === "number" ? m.media.files : null;
  const sample = typeof f.mediaSample === "number" ? f.mediaSample : null;
  if (typeof f.mediaFiles !== "number") {
    add("media", true, `not read back (not enough free disk for it beside the install)${sample !== null
      ? `; ${sample}% of the stored data was read and checked instead` : " — nothing of it was checked"}`);
  } else add("media", wantMedia === null || f.mediaFiles === wantMedia,
    wantMedia === null || f.mediaFiles === wantMedia ? `${f.mediaFiles} files` : `${f.mediaFiles} files, the backup recorded ${wantMedia}`);

  const failed = checks.filter((c) => !c.ok).map((c) => c.id);
  return {
    v: 1, at: x.at || new Date().toISOString().replace(/\.\d+Z$/, "Z"), ok: failed.length === 0,
    snapshot: typeof f.snapshot === "string" ? f.snapshot : null, snapshotTime: typeof f.snapshotTime === "string" ? f.snapshotTime : null,
    tables: f.tables || null, token, media: typeof f.mediaFiles === "number" ? f.mediaFiles : null,
    mediaChecked: typeof f.mediaFiles === "number", mediaSample: sample,
    rows: { chat: f.chat ?? null, events: f.events ?? null, accounts: f.accounts ?? null },
    checks, failed,
    message: failed.length ? `the backup would not bring the site back: ${checks.filter((c) => !c.ok).map((c) => `${c.id} — ${c.detail}`).join("; ")}`
      : typeof f.mediaFiles === "number" ? "the newest backup restores"
      : `the newest backup restores, but the media store was not read back (no room on the disk)${sample !== null ? `; a ${sample}% sample of the stored data was read and checked instead` : ""}`,
  };
}

function readOr(file) { try { return readFileSync(file, "utf8"); } catch { return null; } }

function main([restored, factsFile]) {
  let manifest = null; let facts = null;
  try { manifest = JSON.parse(readFileSync(path.join(restored, "bb/db/manifest.json"), "utf8")); } catch { /* judged as missing */ }
  try { facts = JSON.parse(readFileSync(factsFile, "utf8")); } catch { /* judged as missing */ }
  const v = judgeVerify({
    manifest, facts,
    env: readOr(path.join(restored, "bb/home/.env")),
    signingKey: readOr(path.join(restored, "bb/synapse/signing.key")),
    masKeys: readOr(path.join(restored, "bb/home/matrix/mas-keys.yaml")),
  });
  for (const c of v.checks) process.stderr.write(`   ${c.ok ? "ok  " : "FAIL"}  ${c.id.padEnd(10)}  ${c.detail}\n`);
  process.stdout.write(`BBRESULT ${JSON.stringify(v)}\n`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
