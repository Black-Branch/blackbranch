// The Matrix media proxy's relay (app/api/matrix/media/[...path]/route.ts).
//
// Reading every upstream body whole with arrayBuffer() before answering — no
// byte cap and no bound on how many run at once — lets a few large or parallel
// attachments fill the web process's memory inside the upstream deadline. So
// the body is streamed through: at
// most `maxBytes` of it, cancelled upstream the moment the cap is passed or the
// viewer goes away, and a small gate bounds how many relays are open at once.

import type { Release } from "./concurrencyGate.ts";

/** Stream `upstream`'s body to the viewer, at most `maxBytes` of it.
 *  A declared Content-Length over the cap is refused with 413 before a byte is
 *  read; a body that grows past it is cut off (the stream errors, so the viewer
 *  sees a failed transfer, never a silently truncated file). `release` runs
 *  exactly once, when the transfer ends in any way.
 *
 *  The relay is pull-based: a viewer that keeps the connection open but stops
 *  reading never calls pull() again, so nothing in it would ever see the
 *  upstream fail or time out, and the slot would be held until the viewer left.
 *  So the relay also ends on its own clock (`maxMs`) and when the upstream's
 *  deadline `signal` fires, whether or not anyone is reading. */
export function relayMedia(
  upstream: Response,
  opts: {
    maxBytes: number; headers: Record<string, string>; release: Release;
    maxMs?: number; signal?: AbortSignal;
  },
): Response {
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const finish = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    opts.release();
  };

  const declared = Number(upstream.headers.get("content-length"));
  if (!upstream.body || (Number.isFinite(declared) && declared > opts.maxBytes)) {
    void upstream.body?.cancel().catch(() => {});
    finish();
    return new Response(null, { status: upstream.body ? 413 : 502 });
  }

  const reader = upstream.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const end = (reason: unknown) => {
        if (released) return;
        void reader.cancel(reason).catch(() => {});
        finish();
        c.error(reason);
      };
      if (opts.maxMs !== undefined) timer = setTimeout(() => end(new Error("media_relay_timeout")), opts.maxMs);
      const signal = opts.signal;
      if (signal) {
        onAbort = () => end(signal.reason ?? new Error("media_upstream_aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    },
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          c.close();
          return;
        }
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel().catch(() => {});
          finish();
          c.error(new Error("media_too_large"));
          return;
        }
        c.enqueue(value);
      } catch (e) {
        await reader.cancel().catch(() => {});
        finish();
        c.error(e);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      finish();
    },
  }, { highWaterMark: 0 });

  return new Response(body, { status: 200, headers: opts.headers });
}
