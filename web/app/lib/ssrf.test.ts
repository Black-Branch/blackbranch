// Unit tests for the SSRF helper's pure pieces. Run with:
//   node --test app/lib/ssrf.test.ts
// The private-host classifier and the cross-origin credential strip are pure; the deadline tests at
// the end drive the REAL transport against a local server (pinnedFetchForTest swaps only the
// address check, which correctly refuses 127.0.0.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateHost, isPrivateUrl, stripCredentialsOnCrossOrigin, pinnedFetchForTest, FETCH_DEADLINE_MS } from "./ssrf.ts";
import { readJsonCapped } from "./boundedBody.ts";
import { trickleServer, within } from "./testTrickleServer.ts";

test("isPrivateHost catches loopback / RFC1918 / link-local / IPv6", () => {
  for (const h of ["localhost", "app.localhost", "127.0.0.1", "10.0.0.1", "192.168.1.1",
    "172.16.5.5", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateHost(h), true, `${h} should be private`);
  }
});

test("isPrivateHost allows public hosts", () => {
  for (const h of ["site.test", "matrix.site.test", "8.8.8.8", "1.1.1.1", "example.com"]) {
    assert.equal(isPrivateHost(h), false, `${h} should be public`);
  }
});

test("isPrivateUrl rejects non-http(s) schemes and private hosts", () => {
  assert.equal(isPrivateUrl("file:///etc/passwd"), true);
  assert.equal(isPrivateUrl("http://127.0.0.1/"), true);
  assert.equal(isPrivateUrl("gopher://x/"), true);
  assert.equal(isPrivateUrl("https://site.test/"), false);
});

test("credential headers are stripped on a cross-origin redirect", () => {
  const h = new Headers({ authorization: "Bearer secret", cookie: "sid=1", accept: "text/html" });
  stripCredentialsOnCrossOrigin(h, "https://a.example.com", "https://evil.example.com");
  assert.equal(h.get("authorization"), null, "Authorization must not survive cross-origin");
  assert.equal(h.get("cookie"), null, "Cookie must not survive cross-origin");
  assert.equal(h.get("accept"), "text/html", "non-credential headers are kept");
});

test("credential headers survive a same-origin redirect", () => {
  const h = new Headers({ authorization: "Bearer secret" });
  stripCredentialsOnCrossOrigin(h, "https://a.example.com", "https://a.example.com");
  assert.equal(h.get("authorization"), "Bearer secret", "same-origin keeps credentials");
});

test("different port is a different origin (credentials stripped)", () => {
  const h = new Headers({ authorization: "Bearer secret" });
  stripCredentialsOnCrossOrigin(h, "https://a.example.com", "https://a.example.com:8443");
  assert.equal(h.get("authorization"), null);
});

// ── The deadline covers reading the BODY, not just the headers ──────────────────────────────
// A trickling body (testTrickleServer.ts) must fail INSIDE the deadline while readJsonCapped is
// consuming it. A headers-only timeout test passes while this still hangs.

const loopback = async () => ({ addrs: [{ address: "127.0.0.1", family: 4 }] });

test("a trickling body read through readJsonCapped fails inside the caller's timeoutMs", async () => {
  const srv = await trickleServer();
  try {
    const started = Date.now();
    const outcome = await within((async () => {
      const res = await pinnedFetchForTest(loopback, `http://trickle.test:${srv.port}/`, { timeoutMs: 1000 });
      assert.equal(res.status, 200, "headers arrive at once — only the body is slow");
      return readJsonCapped(res, 64 * 1024);
    })().catch(() => null), 4000);
    const took = Date.now() - started;
    assert.notEqual(outcome, "hung", "the body read is still hanging — the deadline does not cover the body");
    assert.equal(outcome, null, "the read fails; nothing half-read is handed back");
    assert.ok(took < 2500, `took ${took} ms for a 1000 ms deadline`);
  } finally {
    await srv.close();
  }
});

test("a caller's own signal still ends the read when it is sooner than the deadline", async () => {
  const srv = await trickleServer();
  try {
    const started = Date.now();
    const outcome = await within((async () => {
      const res = await pinnedFetchForTest(loopback, `http://trickle.test:${srv.port}/`, { signal: AbortSignal.timeout(800) });
      return readJsonCapped(res, 64 * 1024);
    })().catch(() => null), 4000);
    assert.equal(outcome, null);
    assert.ok(Date.now() - started < 2500, "the caller's 800 ms signal ended the read");
  } finally {
    await srv.close();
  }
});

test("with no timeoutMs and no signal, the 10 s default deadline ends a trickle", { timeout: 20_000 }, async () => {
  assert.equal(FETCH_DEADLINE_MS, 10_000);
  const srv = await trickleServer();
  try {
    const started = Date.now();
    const outcome = await within((async () => {
      const res = await pinnedFetchForTest(loopback, `http://trickle.test:${srv.port}/`);
      return readJsonCapped(res, 64 * 1024);
    })().catch(() => null), FETCH_DEADLINE_MS + 3000);
    const took = Date.now() - started;
    assert.notEqual(outcome, "hung", "no default deadline: a trickle holds the request open indefinitely");
    assert.equal(outcome, null);
    assert.ok(took >= FETCH_DEADLINE_MS - 200 && took < FETCH_DEADLINE_MS + 2000, `took ${took} ms`);
  } finally {
    await srv.close();
  }
});
