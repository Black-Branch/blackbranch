// Matrix encrypted attachments (MSC / EncryptedFile v2) implemented with the
// browser's WebCrypto — no extra dependency. Files in E2EE rooms are uploaded
// as AES-CTR ciphertext; the key/iv/hash travel inside the (already Megolm-
// encrypted) event content's `file` field, and the recipient fetches the
// ciphertext from the media repo and decrypts it locally.

export type EncryptedFile = {
  url: string; // mxc:// of the ciphertext
  key: { kty: "oct"; alg: "A256CTR"; ext: true; k: string; key_ops: string[] };
  iv: string; // unpadded base64, 16 bytes
  hashes: { sha256: string }; // unpadded base64 of the ciphertext
  v: "v2";
};

function abToBinary(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function b64(buf: ArrayBuffer): string {
  return btoa(abToBinary(buf)).replace(/=+$/, "");
}
function b64url(buf: ArrayBuffer): string {
  return b64(buf).replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 ? "=".repeat(4 - (norm.length % 4)) : "";
  const bin = atob(norm + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Encrypt file bytes. Returns the ciphertext to upload and the EncryptedFile
// metadata (minus `url`, filled in once the ciphertext mxc is known).
export async function encryptAttachment(
  data: ArrayBuffer
): Promise<{ data: ArrayBuffer; file: Omit<EncryptedFile, "url"> }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  // 16-byte IV: random high 8 bytes; low 8 bytes (the 64-bit counter) start at 0
  // so AES-CTR has the full counter range — matches the spec's length: 64.
  const iv = new Uint8Array(16);
  iv.set(crypto.getRandomValues(new Uint8Array(8)), 0);

  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, true, [
    "encrypt",
    "decrypt",
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: iv, length: 64 },
    key,
    data
  );
  const sha = await crypto.subtle.digest("SHA-256", ciphertext);

  return {
    data: ciphertext,
    file: {
      key: {
        kty: "oct",
        alg: "A256CTR",
        ext: true,
        k: b64url(keyBytes.buffer),
        key_ops: ["encrypt", "decrypt"],
      },
      iv: b64(iv.buffer),
      hashes: { sha256: b64(sha) },
      v: "v2",
    },
  };
}

// Verify the ciphertext hash, then decrypt back to the original bytes.
export async function decryptAttachment(
  ciphertext: ArrayBuffer,
  file: EncryptedFile
): Promise<ArrayBuffer> {
  const sha = await crypto.subtle.digest("SHA-256", ciphertext);
  if (b64(sha) !== file.hashes.sha256.replace(/=+$/, "")) {
    throw new Error("attachment hash mismatch");
  }
  const key = await crypto.subtle.importKey("raw", fromB64(file.key.k), { name: "AES-CTR" }, false, [
    "decrypt",
  ]);
  return crypto.subtle.decrypt(
    { name: "AES-CTR", counter: fromB64(file.iv), length: 64 },
    key,
    ciphertext
  );
}
