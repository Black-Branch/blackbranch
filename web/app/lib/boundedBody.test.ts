// readBodyCapped: a chunked over-cap body is refused WITHOUT being read to the end — the stream
// below records every pull, and would hand out 100 MB if allowed.
import test from "node:test";
import assert from "node:assert/strict";
import { readBodyCapped, readBodyPrefix, readBytesCapped, readJsonCapped } from "./boundedBody.ts";

function chunked(chunkBytes: number, chunks: number) {
  const rec = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (rec.pulled >= chunks) { c.close(); return; }
      rec.pulled += 1;
      c.enqueue(new Uint8Array(chunkBytes).fill(97));
    },
    cancel() { rec.cancelled = true; },
  }, { highWaterMark: 0 });
  return { req: { headers: new Headers(), body }, rec };
}

test("a chunked body with no Content-Length is cut off at the cap, not buffered to the end", async () => {
  const { req, rec } = chunked(1024, 100_000); // would be ~100 MB
  assert.equal(await readBodyCapped(req, 16_384), null);
  assert.ok(rec.pulled <= 18, `pulled ${rec.pulled} chunks — read past the cap`);
  assert.equal(rec.cancelled, true, "the stream is cancelled, not left to drain");
});

test("an under-cap body is returned whole", async () => {
  const { req } = chunked(1000, 3);
  assert.equal(await readBodyCapped(req, 16_384), "a".repeat(3000));
});

test("exactly the cap passes; one byte over does not", async () => {
  assert.equal((await readBodyCapped(chunked(16_384, 1).req, 16_384))?.length, 16_384);
  assert.equal(await readBodyCapped(chunked(16_385, 1).req, 16_384), null);
});

test("a declared over-cap length is refused before any read; a missing body is null", async () => {
  const { req, rec } = chunked(10, 1);
  const h = new Headers({ "content-length": "999999" });
  assert.equal(await readBodyCapped({ headers: h, body: req.body }, 16_384), null);
  assert.equal(rec.pulled, 0);
  assert.equal(await readBodyCapped({ headers: new Headers(), body: null }, 10), null);
});

test("both open write endpoints read through the cap, and neither has an unbounded read left", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { stripComments } = await import("./testSource.ts");
  for (const [route, last] of [["device-health", /async function prune\(\)[\s\S]*\}\s*$/], ["client-error", /async function prune\(\)[\s\S]*\}\s*$/]] as const) {
    const src = stripComments(readFileSync(join(import.meta.dirname, "..", "api", route, "route.ts"), "utf8"));
    assert.match(src, last, `${route}: END anchor — the whole file was read`);
    assert.match(src, /readBodyCapped\(req, MAX_BODY_BYTES\)/, `${route} does not use the capped reader`);
    assert.doesNotMatch(src, /req\.(text|json|arrayBuffer|formData)\(/, `${route} still has an unbounded read`);
  }
});

test("readBytesCapped returns the exact bytes within the cap and cancels a fetch body declared over it", async () => {
  const ok = chunked(100, 3);
  assert.equal((await readBytesCapped(ok.req, 300))?.byteLength, 300);
  const over = chunked(10, 1);
  const h = new Headers({ "content-length": String(12 * 1024 * 1024) });
  assert.equal(await readBytesCapped({ headers: h, body: over.req.body }, 256 * 1024), null);
  assert.equal(over.rec.pulled, 0, "a body declared over the cap was read");
  assert.equal(over.rec.cancelled, true, "a body declared over the cap was left open — the upstream socket stays held");
});

test("readBodyPrefix reads at most its cap of a never-ending error body, and cancels the rest", async () => {
  const { req, rec } = chunked(1024, 100_000);
  const text = await readBodyPrefix(req, 2048);
  assert.equal(text, "a".repeat(2048));
  assert.ok(rec.pulled <= 4, `pulled ${rec.pulled} chunks for a 2 KiB prefix`);
  assert.equal(rec.cancelled, true, "the rest of the body is cancelled, not drained");
  assert.equal(await readBodyPrefix(new Response("short"), 2048), "short");
});

test("readJsonCapped parses within the cap, and answers null over it or for non-JSON", async () => {
  const res = (s: string) => new Response(s);
  assert.deepEqual(await readJsonCapped(res('{"a":1}'), 64), { a: 1 });
  assert.equal(await readJsonCapped(res('{"a":"' + "x".repeat(100) + '"}'), 64), null);
  assert.equal(await readJsonCapped(res("<html>"), 64), null);
});

// Every server-side reader of a response we do not control — a federated homeserver, an
// arbitrary URL, a third-party JSON API — reads it through a capped helper with its own limit.
// The media relay (mediaRelay.ts) and the article extractor (articleExtract.ts) carry their own
// equivalent caps and are pinned by their own tests. The forum vote route makes no upstream
// read of its own any more: its author lookup goes through the forum reader, on our homeserver.
test("the federated and arbitrary-URL readers never buffer an upstream body unbounded", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("./testSource.ts");
  const files = [
    "app/api/avatar/me/route.ts", "app/api/avatar/user/[id]/route.ts", "app/lib/publicAvatar.ts",
    "app/lib/matrixProfile.ts", "app/api/matrix/devices/route.ts", "app/lib/matrixMediaUpload.ts",
    "app/lib/matrixSession.ts", "app/lib/federatedSignIn.ts", "app/api/auth/matrix-discover/route.ts",
    "app/api/auth/matrix-initiate/route.ts", "app/api/mod/embed/route.ts",
    "app/api/og/route.ts", "app/lib/rssServer.ts",
  ];
  // `req.json()` / `file.arrayBuffer()` read the INCOMING request, which is not this scan's subject; everything else
  // named here is an upstream response.
  const unbounded = /\b(?!(?:req|file)\b)[A-Za-z_]+\.(json|text|arrayBuffer)\(\)/g;
  for (const f of files) {
    const raw = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    const src = stripComments(raw);
    assert.ok(src.trimEnd().endsWith(raw.trimEnd().slice(-12)), `${f}: the scan did not reach the END of the file`);
    assert.match(src, /read(Json|Body|Bytes)Capped\(/, `${f} no longer reads through the capped helper`);
    const hits = [...src.matchAll(unbounded)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${f} reads an upstream body with no byte limit`);
  }
});
