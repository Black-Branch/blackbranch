// Article extraction under hostile publishers (external review S7).
//
// Only links already in site.rss_items are fetched, but the publisher behind one
// can stall. With a global cap of three slots and no deadline, three stalled
// responses held every slot and every other reader got 503 until a socket
// timeout — and a huge body reached the synchronous parse. Every fake here is
// small and bounded: a stall is a promise that never settles, a drip is a
// stream that yields a few bytes per tick, an oversized body is a few KB
// against a cap set to less.
import test from "node:test";
import assert from "node:assert/strict";
import { createArticleExtractor } from "./articleExtract.ts";

const DEADLINE = 150;
const MAX_BYTES = 4096;
const ARTICLE = `<!doctype html><html><head><title>A headline</title></head><body><article><h1>A headline</h1>${
  "<p>" + "Plain sentences about a news event that a reader came here to read in full. ".repeat(12) + "</p>"
}</article></body></html>`;

const enc = new TextEncoder();
const page = (html = ARTICLE) => new Response(html, { status: 200, headers: { "content-type": "text/html" } });

function stalled(): { fetch: (u: string, i: RequestInit) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  // Never settles and ignores the abort signal: the worst kind of stall.
  return { calls, fetch: (u) => { calls.push(u); return new Promise<Response>(() => {}); } };
}

/** A body that yields `chunk` bytes every `everyMs`, up to `max` chunks (Infinity = forever). */
function dripping(chunk: number, everyMs: number, max = Infinity) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (state.pulled >= max) { c.close(); return; }
      await new Promise((r) => setTimeout(r, everyMs));
      state.pulled++;
      c.enqueue(enc.encode("x".repeat(chunk)));
    },
    cancel() { state.cancelled = true; },
  });
  return { state, res: new Response(body, { status: 200, headers: { "content-type": "text/html" } }) };
}

const make = (fetch: (u: string, i: RequestInit) => Promise<Response>) =>
  createArticleExtractor({ fetch, maxInflight: 3, deadlineMs: DEADLINE, maxBytes: MAX_BYTES });

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: still pending after ${ms}ms`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

test("a reader gets an article, and the second read is a cache hit", async () => {
  let n = 0;
  const x = make(async () => { n++; return page(); });
  const out = await x.extract("https://news.test/a");
  assert.ok(out && out.ok, JSON.stringify(out));
  assert.ok(x.cached("https://news.test/a"));
  assert.equal(n, 1);
});

test("delayed headers: a stalled publisher is cut off at the deadline and its slot comes back", async () => {
  const s = stalled();
  const x = make(s.fetch);
  const out = await within(x.extract("https://slow.test/1")!, DEADLINE * 4, "stalled extraction");
  assert.deepEqual(out, { ok: false, error: "timeout" });
});

test("three stalled publishers hold the slots only until the deadline, then a fourth reader is served", async () => {
  let stall = true;
  const x = make((u) => (stall && u.startsWith("https://slow.test/") ? new Promise<Response>(() => {}) : Promise.resolve(page())));
  const held = [1, 2, 3].map((i) => x.extract(`https://slow.test/${i}`)!);
  assert.equal(x.extract("https://ok.test/now"), null, "all three slots are taken while they stall");
  await within(Promise.all(held), DEADLINE * 4, "stalled extractions");
  stall = false;
  const out = await within(x.extract("https://ok.test/after")!, DEADLINE * 4, "recovered extraction");
  assert.ok(out.ok, JSON.stringify(out));
});

test("a dripping body is cut off at the TOTAL deadline, not an idle timeout, and the stream is cancelled", async () => {
  // 8 bytes every 10ms never trips the byte cap and never goes idle.
  const d = dripping(8, 10);
  const x = make(async () => d.res);
  const out = await within(x.extract("https://drip.test/1")!, DEADLINE * 4, "dripping extraction");
  assert.deepEqual(out, { ok: false, error: "timeout" });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(d.state.cancelled, "the body must be cancelled, not left reading");
  const pulledAtEnd = d.state.pulled;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(d.state.pulled, pulledAtEnd, "nothing is read after the deadline");
});

test("an oversized chunked body (no content-length) stops at the byte cap, while it is being read", async () => {
  const d = dripping(1024, 1, 64); // would be 64 KB
  const x = make(async () => d.res);
  const out = await within(x.extract("https://big.test/1")!, DEADLINE * 4, "oversized extraction");
  assert.deepEqual(out, { ok: false, error: "too_large" });
  assert.ok(d.state.pulled <= MAX_BYTES / 1024 + 2, `read ${d.state.pulled} chunks — the cap must stop the read, not check it after`);
  assert.ok(d.state.cancelled, "the rest of the body is cancelled");
});

test("a declared content-length over the cap is refused without reading the body", async () => {
  const d = dripping(1024, 1, 64);
  const res = new Response(d.res.body, { status: 200, headers: { "content-type": "text/html", "content-length": String(64 * 1024) } });
  const x = make(async () => res);
  const out = await x.extract("https://big.test/declared")!;
  assert.deepEqual(out, { ok: false, error: "too_large" });
  assert.ok(d.state.pulled <= 1, `read ${d.state.pulled} chunks of a body already known to be too large`);
});

test("concurrent misses for ONE url share one fetch and one slot", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: string[] = [];
  const x = make(async (u) => { calls.push(u); await gate; return page(); });
  const a = x.extract("https://same.test/1")!;
  const b = x.extract("https://same.test/1")!;
  const c = x.extract("https://same.test/1")!;
  // Two more distinct URLs still fit: the three readers above hold ONE slot.
  const d = x.extract("https://other.test/2");
  const e = x.extract("https://other.test/3");
  assert.ok(d && e, "coalesced readers must not use up the other slots");
  release();
  const outs = await Promise.all([a, b, c, d, e]);
  assert.ok(outs.every((o) => o.ok), JSON.stringify(outs));
  assert.equal(calls.filter((u) => u === "https://same.test/1").length, 1);
});

test("an upstream error status releases the slot", async () => {
  const x = make(async () => new Response("nope", { status: 500 }));
  for (let i = 0; i < 5; i++) {
    const out = await x.extract(`https://err.test/${i}`)!;
    assert.deepEqual(out, { ok: false, error: "http_500" });
  }
});

test("the abort signal reaches the fetch", async () => {
  let seen: AbortSignal | undefined;
  const x = make((_u, init) => {
    seen = init.signal ?? undefined;
    return new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  });
  const out = await within(x.extract("https://slow.test/sig")!, DEADLINE * 4, "aborted extraction");
  assert.deepEqual(out, { ok: false, error: "timeout" });
  assert.ok(seen?.aborted, "the fetch must be given a signal that the deadline aborts");
});
