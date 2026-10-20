// Read a body with a hard byte cap, WITHOUT buffering past it — an incoming request's, or a fetch
// response's from an upstream we do not control (a federated homeserver, any arbitrary URL).
//
// Why not `text()` / `json()` / `arrayBuffer()` + a length check: a chunked body carries no
// Content-Length, so a header check passes it, and those methods then buffer the WHOLE body
// before anything can measure it. A timeout bounds how long that takes, not how much it holds.
// This reads the stream with a running count and cancels the reader the moment the cap is passed.
// The cap is the CALLER's — the right one differs by orders of magnitude between a profile read
// and a thumbnail — so there is deliberately no default.

type Body = { headers: Headers; body: ReadableStream<Uint8Array> | null };

/** The ceiling for the small Matrix / OAuth control-plane JSON a server-side call reads from a
 *  homeserver: profile fields, .well-known, token, whoami and registration answers. Each is a
 *  few hundred bytes to a few KB; Matrix itself caps a whole event at 64 KiB. */
export const MATRIX_JSON_MAX_BYTES = 64 * 1024;

/** The ceiling for an OAuth token / registration / whoami answer from an outside server: a few
 *  hundred bytes in practice (an access token, a refresh token, an expiry, a client id). */
export const OAUTH_REPLY_MAX_BYTES = 16 * 1024;

/** How much of an outside server's error body is worth a log line. */
export const ERROR_LOG_MAX_BYTES = 2 * 1024;

/** The first `maxBytes` of a body as text — for a log line about an error answer. Never more is
 *  read: the rest is cancelled, so a huge or never-ending error body costs `maxBytes`. "" when
 *  there is no body or it cannot be read. */
export async function readBodyPrefix(src: Body, maxBytes: number): Promise<string> {
  if (!src.body) return "";
  const reader = src.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, maxBytes - total);
      chunks.push(take);
      total += take.byteLength;
    }
  } catch {
    // What was read so far is still worth the log line.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/** The body's bytes, or null when it is missing, over the cap, or unreadable. */
export async function readBytesCapped(src: Body, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = src.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    // Release the upstream connection instead of leaving the body unread.
    await src.body?.cancel().catch(() => {});
    return null;
  }
  if (!src.body) return null;
  const reader = src.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    reader.releaseLock?.();
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf;
}

/** The body decoded as UTF-8 text, or null (see readBytesCapped). */
export async function readBodyCapped(src: Body, maxBytes: number): Promise<string | null> {
  const bytes = await readBytesCapped(src, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** The body parsed as JSON, or null when it is over the cap, unreadable, or not JSON. */
export async function readJsonCapped(src: Body, maxBytes: number): Promise<unknown> {
  const text = await readBodyCapped(src, maxBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
