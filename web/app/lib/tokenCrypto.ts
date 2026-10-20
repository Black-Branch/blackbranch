// At-rest encryption for Matrix access/refresh tokens stored in site.users.
//
// Design goals:
//  - Zero-downtime, backward-compatible rollout. decToken() transparently reads
//    BOTH legacy plaintext rows and encrypted ("v1:") rows, so deploying this
//    before migrating existing rows is safe.
//  - Outside production, a missing TOKEN_ENC_KEY makes both functions
//    passthrough, so local dev never stores ciphertext it can't later read.
//    In PRODUCTION a missing or malformed key makes encToken throw — see there.
//
// Format: `v1:<iv_b64url>:<authTag_b64url>:<ciphertext_b64url>` (AES-256-GCM).
// Key: TOKEN_ENC_KEY = 64 hex chars (32 bytes). Server-only — never expose.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const PREFIX = "v1:";

function getKey(): Buffer | null {
  const hex = process.env.TOKEN_ENC_KEY;
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    console.error("[tokenCrypto] TOKEN_ENC_KEY must be 64 hex chars (32 bytes); ignoring");
    return null;
  }
  return Buffer.from(hex, "hex");
}

const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

/**
 * Encrypt a token for storage.
 *
 * With no usable key this REFUSES in production: handing the plaintext back
 * stored every platform OAuth token and Matrix refresh token readable, and the
 * only signal was a console line. A deployment that forgot the key should fail
 * at the first link, loudly, not months later in a database dump. Outside
 * production (local dev runs without a key) it still passes through.
 */
export function encToken(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  const key = getKey();
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("[tokenCrypto] TOKEN_ENC_KEY is missing or malformed — refusing to store a token unencrypted");
    }
    return plaintext; // dev only: no key → store as-is
  }
  if (plaintext.startsWith(PREFIX)) return plaintext; // already encrypted
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
}

/** Decrypt a stored token. Returns plaintext rows unchanged; null on failure. */
export function decToken(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  const key = getKey();
  if (!key) {
    console.error("[tokenCrypto] encrypted token present but TOKEN_ENC_KEY unset");
    return null;
  }
  try {
    const [, ivB, tagB, ctB] = stored.split(":");
    if (!ivB || !tagB || !ctB) return null; // malformed ciphertext → re-authenticate
    const decipher = createDecipheriv("aes-256-gcm", key, fromB64u(ivB));
    decipher.setAuthTag(fromB64u(tagB));
    const pt = Buffer.concat([decipher.update(fromB64u(ctB)), decipher.final()]);
    return pt.toString("utf8");
  } catch (e) {
    // Bad key / corrupted value → treat as missing so the user re-authenticates.
    console.error("[tokenCrypto] decrypt failed:", (e as Error).message);
    return null;
  }
}
