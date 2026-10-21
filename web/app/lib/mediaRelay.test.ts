// The Matrix media proxy's relay: the upstream body is
// streamed through with a byte cap and cancellation instead of buffered whole,
// and a small gate bounds how many relays run at once. Every fake is a few
// bytes against a cap set to less — never a large transfer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { relayMedia } from "./mediaRelay.ts";

const enc = new TextEncoder();

function upstreamOf(chunks: number, size: number, headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulled >= chunks) { c.close(); return; }
      state.pulled++;
      c.enqueue(enc.encode("x".repeat(size)));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, res: new Response(body, { status: 200, headers: { "content-type": "image/png", ...headers } }) };
}

const HEADERS = { "Content-Type": "image/png" };

test("a body within the cap is streamed through unchanged and releases its slot when done", async () => {
  let released = 0;
  const up = upstreamOf(4, 10);
  const res = relayMedia(up.res, { maxBytes: 100, headers: HEADERS, release: () => { released++; } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(await res.text(), "x".repeat(40));
  assert.equal(released, 1);
});

test("a declared content-length over the cap is refused with 413 before any byte is read", async () => {
  let released = 0;
  const up = upstreamOf(64, 10, { "content-length": "640" });
  const res = relayMedia(up.res, { maxBytes: 100, headers: HEADERS, release: () => { released++; } });
  assert.equal(res.status, 413);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(up.state.cancelled, "the upstream body must be cancelled");
  assert.equal(up.state.pulled, 0);
  assert.equal(released, 1);
});

test("a chunked body that grows past the cap is cut off while streaming, upstream cancelled", async () => {
  let released = 0;
  const up = upstreamOf(64, 10); // would be 640 bytes
  const res = relayMedia(up.res, { maxBytes: 100, headers: HEADERS, release: () => { released++; } });
  assert.equal(res.status, 200, "the headers are already out; the cap ends the body");
  const reader = res.body!.getReader();
  let got = 0;
  await assert.rejects(async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
    }
  }, /media_too_large/);
  assert.ok(got <= 100, `relayed ${got} bytes past a 100-byte cap`);
  assert.ok(up.state.pulled <= 12, `pulled ${up.state.pulled} chunks — the cap must stop the read`);
  assert.ok(up.state.cancelled);
  assert.equal(released, 1);
});

test("a client that goes away cancels the upstream and releases the slot", async () => {
  let released = 0;
  const up = upstreamOf(1000, 10);
  const res = relayMedia(up.res, { maxBytes: 1_000_000, headers: HEADERS, release: () => { released++; } });
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  assert.ok(up.state.cancelled);
  assert.ok(up.state.pulled < 10);
  assert.equal(released, 1);
});

test("release runs exactly once whatever happens", async () => {
  let released = 0;
  const up = upstreamOf(64, 10);
  const res = relayMedia(up.res, { maxBytes: 100, headers: HEADERS, release: () => { released++; } });
  const reader = res.body!.getReader();
  await reader.read().catch(() => {});
  await reader.cancel().catch(() => {});
  await reader.cancel().catch(() => {});
  assert.equal(released, 1);
});

// A viewer that keeps the connection open but stops reading never asks the
// relay for more, so nothing inside a pull ever sees the upstream end. The
// relay is bounded on its own clock and by the upstream deadline's signal.

test("a viewer that reads nothing has its slot released at the relay bound", async () => {
  let released = 0;
  const up = upstreamOf(1000, 10);
  const res = relayMedia(up.res, { maxBytes: 1_000_000, headers: HEADERS, release: () => { released++; }, maxMs: 30 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(released, 1, "the slot must come back without the viewer reading");
  assert.ok(up.state.cancelled, "the upstream is cancelled");
  await assert.rejects(res.text(), /media_relay_timeout/, "the viewer sees a failed transfer, never a short file");
  assert.equal(released, 1);
});

test("an upstream deadline releases a paused viewer's slot at once", async () => {
  let released = 0;
  const up = upstreamOf(1000, 10);
  const deadline = new AbortController();
  const res = relayMedia(up.res, {
    maxBytes: 1_000_000, headers: HEADERS, release: () => { released++; }, maxMs: 60_000, signal: deadline.signal,
  });
  assert.equal(released, 0);
  deadline.abort(new Error("upstream_timeout"));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(released, 1);
  assert.ok(up.state.cancelled);
  await assert.rejects(res.text());
});

test("a signal already aborted when the relay starts releases at once", async () => {
  let released = 0;
  const up = upstreamOf(1000, 10);
  const res = relayMedia(up.res, {
    maxBytes: 1_000_000, headers: HEADERS, release: () => { released++; }, maxMs: 60_000, signal: AbortSignal.abort(),
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(released, 1);
  await assert.rejects(res.text());
});

test("a transfer that finishes inside the bound is not cut, and the bound never fires after it", async () => {
  let released = 0;
  const up = upstreamOf(4, 10);
  const deadline = new AbortController();
  const res = relayMedia(up.res, {
    maxBytes: 100, headers: HEADERS, release: () => { released++; }, maxMs: 40, signal: deadline.signal,
  });
  assert.equal(await res.text(), "x".repeat(40));
  await new Promise((r) => setTimeout(r, 80));
  deadline.abort();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(released, 1);
  assert.equal(up.state.cancelled, false);
});

test("the media route relays through the gate and the cap, never arrayBuffer()", () => {
  const src = readFileSync(join(import.meta.dirname, "../api/matrix/media/[...path]/route.ts"), "utf8");
  assert.match(src, /return new Response\(null, \{ status: 404 \}\);\s*\}\s*$/, "END of the media route not read");
  assert.doesNotMatch(src, /\.arrayBuffer\(\)/, "the upstream body is streamed, never buffered whole");
  assert.match(src, /relayMedia\(/);
  assert.match(src, /mediaGate\.acquire\(/);
  const relays = src.match(/relayMedia\([^;]*\);/g) ?? [];
  assert.equal(relays.length, 2, "both relay sites read");
  for (const r of relays) {
    assert.match(r, /maxMs: RELAY_MAX_MS/, "every relay is bounded on its own clock");
    assert.match(r, /\bsignal(?:: \w+)?,?\s*\}\)/, "every relay observes its upstream deadline");
  }
});
