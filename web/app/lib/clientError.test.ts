// Tests for the client-error sink (v107) — the web app's first browser-side
// telemetry. Two halves are worth pinning:
//
//   1. The FINGERPRINT. It decides whether one bug is one row or a thousand, and
//      it fails silently in both directions: too loose and two unrelated errors
//      merge into a row that reads as one very frequent bug; too tight and every
//      deploy's renamed chunks turn the table into the append-only log it was
//      designed not to be. Neither shows up as an error anywhere.
//   2. The sender's REFUSAL TO THROW. It runs inside error boundaries and inside
//      window.onerror — the two places already handling a failure. A throw there
//      replaces a diagnosable error with an undiagnosable one, and inside
//      global-error.tsx it takes out the last thing standing between a root
//      layout throw and a blank white page.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { reportClientError, _resetClientErrorThrottle } from "./clientError.ts";
import { fingerprintOf, normalizeForFingerprint, topFrame } from "./errorFingerprint.ts";

// The fingerprint helpers are imported, not reconstructed. The first version of
// this file read them out of the route with `new Function`, which is a
// code-injection shape and depended on regex surgery over type annotations;
// extracting them to app/lib/errorFingerprint.ts made both unnecessary and is
// why that module exists.
const ROUTE = join(process.cwd(), "app/api/client-error/route.ts");
const routeSrc = readFileSync(ROUTE, "utf8");

test("the same bug from two users is ONE row", () => {
  const a = fingerprintOf("boundary", "Cannot read properties of null (reading 'id')",
    "Error\n    at ChatMessage (https://site.test/_next/static/chunks/a1b2c3d4e5f6.js:1:4821)");
  const b = fingerprintOf("boundary", "Cannot read properties of null (reading 'id')",
    "Error\n    at ChatMessage (https://site.test/_next/static/chunks/a1b2c3d4e5f6.js:1:4903)");
  assert.equal(a, b, "a different column offset must not fork the row");
});

test("a deploy that renames its chunks does NOT resurrect every old error", () => {
  // This is the failure that turns the table into an append-only log, and it
  // would look like "every error came back after the deploy".
  const before = fingerprintOf("onerror", "boom",
    "Error\n    at f (https://site.test/_next/static/chunks/deadbeef1234.js:1:10)");
  const after = fingerprintOf("onerror", "boom",
    "Error\n    at f (https://site.test/_next/static/chunks/0f0f0f0f9999.js:2:99)");
  assert.equal(before, after);
});

test("two genuinely different errors do NOT merge", () => {
  const nullId = fingerprintOf("boundary", "Cannot read properties of null (reading 'id')", null);
  const nullName = fingerprintOf("boundary", "Cannot read properties of null (reading 'name')", null);
  assert.notEqual(nullId, nullName, "different property names are different bugs");

  const sameMsgDifferentSite = [
    fingerprintOf("boundary", "boom", "Error\n    at ChatInput (x.js:1:1)"),
    fingerprintOf("boundary", "boom", "Error\n    at MarketCard (x.js:1:1)"),
  ];
  assert.notEqual(sameMsgDifferentSite[0], sameMsgDifferentSite[1],
    "the same message thrown from two components is two bugs");
});

test("the source is part of the identity", () => {
  assert.notEqual(
    fingerprintOf("boundary", "Failed to fetch", null),
    fingerprintOf("unhandledrejection", "Failed to fetch", null),
    "a render throw and a floating promise are not the same finding"
  );
});

test("a message that is nothing but a number does not collapse to one row", () => {
  // normalizeForFingerprint replaces digits, so a degenerate message could
  // fingerprint identically to every other numeric message. The stack has to
  // carry the difference — assert we notice if it stops doing so.
  const a = fingerprintOf("onerror", "500", "Error\n    at loadA (x.js:1:1)");
  const b = fingerprintOf("onerror", "404", "Error\n    at loadB (x.js:1:1)");
  assert.notEqual(a, b, "distinct throw sites must stay distinct even when the text normalizes away");
});

test("normalization strips URLs BEFORE hex and digits", () => {
  // Order-dependent: a URL contains both hex and digits, so rewriting those
  // first leaves a half-mangled path that still varies per build.
  assert.equal(
    normalizeForFingerprint("failed at https://site.test/_next/static/chunks/a1b2c3d4.js:12:7 (attempt 3)"),
    "failed at <url> (attempt <n>)"
  );
});

test("Safari stacks are read too — an `at `-only reader loses every iOS throw site", () => {
  // JavaScriptCore (Safari, and therefore EVERY iOS browser) writes `fn@url`
  // with no message line and no `at`. Returning "" for those merges all of a
  // Safari user's same-message errors into one row, on the platform we can
  // least reproduce locally.
  const jsc = "handleSend@https://site.test/_next/static/chunks/x.js:1:120\n" +
              "asyncFunctionResume@[native code]";
  assert.equal(topFrame(jsc), "handleSend@https://site.test/_next/static/chunks/x.js:1:120");

  const v8 = "TypeError: boom\n    at handleSend (https://site.test/x.js:1:120)\n    at onClick (y.js:2:3)";
  assert.equal(topFrame(v8), "at handleSend (https://site.test/x.js:1:120)",
    "the V8 path must still win when both could match");

  assert.equal(topFrame(null), "");
  assert.equal(topFrame("just a message, no frames"), "",
    "a message-only string is not a frame — counting it would fingerprint the message twice");

  // The payoff: two Safari errors from different call sites stay distinct.
  assert.notEqual(
    fingerprintOf("onerror", "boom", "sendChat@https://site.test/x.js:1:1"),
    fingerprintOf("onerror", "boom", "loadMarket@https://site.test/x.js:9:9")
  );
});

test("player events fingerprint by their raw message + stack, not normalized text", () => {
  // The generic path strips digits before hashing, which is exactly what a
  // player report cannot afford: its "stack" is JSON.stringify of the whole
  // decision (playerTelemetry.ts), and the attempt number / counters embedded
  // in it are the only thing telling two reconnects of the same reason apart.
  const a = fingerprintOf(
    "player",
    "player reconnect: watchdog — pc=connecting/checking attempt=1 node=app-vm",
    JSON.stringify({ attempt: 1, node: "app-vm", counters: { packetsLost: 4 } })
  );
  const b = fingerprintOf(
    "player",
    "player reconnect: watchdog — pc=connecting/checking attempt=2 node=app-vm",
    JSON.stringify({ attempt: 2, node: "app-vm", counters: { packetsLost: 9 } })
  );
  assert.notEqual(a, b, "a different attempt/counters must fork the row — merging them is the bug being fixed");

  const repeat = fingerprintOf(
    "player",
    "player reconnect: watchdog — pc=connecting/checking attempt=1 node=app-vm",
    JSON.stringify({ attempt: 1, node: "app-vm", counters: { packetsLost: 4 } })
  );
  assert.equal(a, repeat, "an exact repeat of the same event must still aggregate into one row");
});

test("a non-player fingerprint is unchanged by the player branch", () => {
  // Pinned so a change to the generic (non-player) path — not just the new
  // player branch — shows up here. If this value ever needs to change, it
  // means the shared normalization logic moved, which is worth noticing.
  assert.equal(
    fingerprintOf(
      "boundary",
      "Cannot read properties of null (reading 'id')",
      "Error\n    at ChatMessage (https://site.test/_next/static/chunks/a1b2c3d4e5f6.js:1:4821)"
    ),
    "59969d8392f2f33d10c18b1135e04af3"
  );
});

// ── The sender must not throw, whatever it is handed ────────────────────────

test("reportClientError survives anything a rejected promise can carry", () => {
  // A rejection can carry literally anything. `describe()` assuming Error is how
  // the reporter becomes the error.
  const circular: Record<string, unknown> = {};
  circular.self = circular;                     // JSON.stringify throws on this
  const nasty: unknown[] = [
    undefined, null, 0, "", false, NaN, Symbol("s"), circular,
    { toString() { throw new Error("hostile toString"); } },
    new Error(""),                              // empty message
  ];
  for (const v of nasty) {
    _resetClientErrorThrottle();
    assert.doesNotThrow(() => reportClientError("unhandledrejection", v),
      `threw on ${String(typeof v)}`);
  }
});

test("reportClientError is inert on the server (no window)", () => {
  // These tests run in Node with no window, which is also the real SSR case:
  // the module is imported by app/error.tsx, which Next renders on the server.
  _resetClientErrorThrottle();
  assert.equal(typeof globalThis.window, "undefined", "precondition: no window here");
  assert.doesNotThrow(() => reportClientError("boundary", new Error("x")));
});

// ── Per-source throttle budgets ─────────────────────────────────────────────
//
// reportClientError no-ops with no `window` (asserted above), so these tests
// give it a plain stub object and a stub `fetch` — not the full jsdom harness
// (testDom.ts), which would install a real `globalThis.window` and break the
// "inert on server" precondition above for every test that runs after it.
// Both stubs are removed in a `finally` so later tests still see no window.
function withStubbedSender<T>(run: (sent: { source: string; message: string }[]) => T): T {
  const sent: { source: string; message: string }[] = [];
  (globalThis as unknown as { window: unknown }).window = { location: { href: "https://test.invalid/" } };
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ source: String(body.source), message: String(body.message) });
    return new Response("{}", { status: 200 });
  };
  try {
    return run(sent);
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window;
    globalThis.fetch = realFetch;
  }
}

test("20 distinct player reports all send; the 21st in the same load does not", () => {
  withStubbedSender((sent) => {
    _resetClientErrorThrottle();
    for (let i = 0; i < 21; i++) reportClientError("player", new Error(`stall ${i}`));
    const playerSent = sent.filter((s) => s.source === "player");
    assert.equal(playerSent.length, 20, "MAX_PLAYER_PER_LOAD is 20 — the 21st must be throttled");
  });
});

test("20 player reports do not spend the general budget — a boundary error after them still sends", () => {
  withStubbedSender((sent) => {
    _resetClientErrorThrottle();
    for (let i = 0; i < 20; i++) reportClientError("player", new Error(`stall ${i}`));
    reportClientError("boundary", new Error("unrelated boundary error"));
    assert.ok(
      sent.some((s) => s.source === "boundary" && s.message === "unrelated boundary error"),
      "a general report right after 20 player reports was silenced — the budgets are shared, not separate"
    );
  });
});

test("the general per-load budget still caps at 10", () => {
  withStubbedSender((sent) => {
    _resetClientErrorThrottle();
    for (let i = 0; i < 11; i++) reportClientError("boundary", new Error(`boundary ${i}`));
    assert.equal(sent.length, 10, "MAX_PER_LOAD is 10 — the 11th general report must be throttled");
  });
});

// ── Source scans: the wiring that has no runtime test ───────────────────────

const lib = stripComments(readFileSync(join(process.cwd(), "app/lib/clientError.ts"), "utf8"));
const routeStripped = stripComments(routeSrc);

test("all four report paths are wired, not just the boundaries", () => {
  // `error` and `unhandledrejection` are NOT caught by React error boundaries.
  // Wiring only the boundaries leaves async throws — the interesting ones —
  // unrecorded, and nothing would ever say so.
  for (const [file, src] of [
    ["app/error.tsx", readFileSync(join(process.cwd(), "app/error.tsx"), "utf8")],
    ["app/global-error.tsx", readFileSync(join(process.cwd(), "app/global-error.tsx"), "utf8")],
  ] as const) {
    assert.match(stripComments(src), /reportClientError\(/, `${file} no longer reports`);
  }
  assert.match(lib, /addEventListener\("error"/, "window.onerror path is gone");
  assert.match(lib, /addEventListener\("unhandledrejection"/, "unhandledrejection path is gone");
  assert.match(
    stripComments(readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8")),
    /<ClientErrorReporter \/>/,
    "the listeners are never installed — nothing mounts the reporter"
  );
});

test("the route rate-limits before it does any work", () => {
  const limit = routeStripped.indexOf("isRateLimited(ipKey(req))");
  const parse = routeStripped.indexOf("readBodyCapped(req, MAX_BODY_BYTES)");
  const write = routeStripped.indexOf("INSERT INTO site.client_errors");
  assert.ok(limit > 0, "the unauthenticated write endpoint has no rate limit");
  assert.ok(parse > 0, "the body read was not found — renamed or unbounded again?");
  assert.ok(limit < parse && limit < write, "the limiter must gate the body parse and the write");
});

test("a failed sink returns quietly instead of erroring the client", () => {
  // A 500 here would be reported by the client as a new client error, which
  // would fail the same way — a loop that generates its own load.
  assert.match(routeStripped, /catch \(e\) \{[\s\S]{0,300}?status: 202/,
    "the store-failure path no longer answers softly");
});

test("the burst notification carries no payload values", () => {
  // It renders on a lock screen on a device that leaves the house. The
  // fingerprint is a hash; the message text, page url and user agent are not.
  const notify = routeStripped.slice(routeStripped.indexOf("/ops/notify"));
  const body = notify.slice(0, notify.indexOf("}).catch"));
  for (const forbidden of ["fullMessage", "pageUrl", "userAgent", "matrixId", "stack"]) {
    assert.ok(!body.includes(forbidden),
      `the ops notification interpolates ${forbidden} — that reaches a lock screen`);
  }
  assert.match(body, /fingerprint\.slice/, "precondition: it still identifies the row somehow");
});

test("retention counts from FIRST sighting: a recurring error's row still goes after the stated days", async () => {
  const { CLIENT_ERROR_PRUNE_SQL, CLIENT_ERROR_RETENTION_DAYS } = await import("./clientErrorRetention.ts");
  assert.equal(CLIENT_ERROR_RETENTION_DAYS, 30);
  assert.match(CLIENT_ERROR_PRUNE_SQL, /^DELETE FROM site\.client_errors WHERE first_seen < now\(\) - make_interval\(days => 30\)$/);
  // The route runs that statement and no other DELETE: a last_seen prune let a row live as long as its error recurred.
  assert.match(routeStripped, /await pool\.query\(CLIENT_ERROR_PRUNE_SQL\)/);
  assert.equal((routeStripped.match(/DELETE FROM/g) ?? []).length, 0, "the route writes its own prune again");
  assert.ok(!routeStripped.includes("last_seen <"), "the route prunes on last_seen again");
});

// ── Vacuity anchor (END of file) ────────────────────────────────────────────
// Half the assertions above are scans, and two of them are NEGATIVE (`!includes`,
// `doesNotThrow`) — the shape that goes green over a truncated read instead of
// failing. This proves the route was read to its end.
test("VACUITY ANCHOR: the route source was read whole", () => {
  assert.ok(routeSrc.length > 4_000, `route.ts read back as ${routeSrc.length} bytes — truncated`);
  assert.match(routeSrc.trimEnd(), /^\}$/m, "no closing brace found at all");
  assert.ok(routeSrc.includes("async function prune()"),
    "the scan lost the tail of the route (prune is the last function in the file)");
});

// ── The component-level boundary reports too ────────────────────────────────

test("every ClientErrorSource the client can send is one the route accepts", () => {
  // The route 400s unknown sources and the sender swallows the refusal
  // (deliberately — reporting must not throw). Which means client/server drift
  // here is PERFECTLY silent: the report is posted, dropped, and nothing
  // anywhere says so. This is the one place the two lists are compared.
  const clientSrc = stripComments(readFileSync(join(process.cwd(), "app/lib/clientError.ts"), "utf8"));
  const unionBlock = clientSrc.slice(
    clientSrc.indexOf("export type ClientErrorSource"),
    clientSrc.indexOf(";", clientSrc.indexOf("export type ClientErrorSource")),
  );
  const clientSources = [...unionBlock.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!).sort();

  const setMatch = stripComments(routeSrc).match(/SOURCES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(setMatch, "the route's SOURCES allowlist moved — update this scan");
  const serverSources = [...setMatch[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!).sort();

  assert.ok(clientSources.length >= 4, "union scan found too few sources — parser broken?");
  assert.deepEqual(clientSources, serverSources,
    "client union and route allowlist have drifted — a source on one side only is a silently dropped report");
});

test("the in-app ErrorBoundary reports what it catches", () => {
  // app/error.tsx and global-error.tsx report, and so must the COMPONENT
  // boundary — the one wrapping the chat sidebar and the community page, the
  // two most complex client trees. A boundary that only console.errors renders
  // "Something went wrong here" and produces zero telemetry.
  const src = stripComments(
    readFileSync(join(process.cwd(), "app/components/ErrorBoundary.tsx"), "utf8"),
  );
  const didCatch = src.slice(src.indexOf("componentDidCatch"), src.indexOf("render()"));
  assert.ok(didCatch.length > 0, "componentDidCatch is gone — rewritten? update this scan");
  assert.match(didCatch, /reportClientError\("component-boundary", err\)/,
    "boundary-caught errors must reach the sink, tagged as the component-level boundary");
  assert.match(didCatch, /console\.error/,
    "…and keep the console line — it is what remains when the sink itself is down");
});

test("the report is sent keepalive, so ErrorBoundary's reload cannot cut it off", () => {
  // ErrorBoundary calls window.location.reload() right after reportClientError
  // when the caught error is a stranded chunk. A plain fetch loses that race;
  // keepalive is the browser's mechanism for a request that must survive the
  // navigation that follows it.
  const call = lib.slice(lib.indexOf("void postJson("), lib.indexOf("}).catch("));
  assert.ok(call.length > 0, "the postJson call in reportClientError moved — update this scan");
  assert.match(call, /keepalive:\s*true/,
    "reportClientError's postJson call dropped keepalive: true — a reload can now cut the report off");
});

// A cross-origin script's throw reaches window.onerror as the bare string
// "Script error." with no error object — nothing in it can be acted on, and one
// viewer stored it 111 times in a night. A REAL error must still get through.
test("an opaque cross-origin 'Script error.' is dropped; anything carrying information is kept", async () => {
  const { isOpaqueCrossOriginError } = await import("./clientError.ts");
  assert.equal(isOpaqueCrossOriginError({ message: "Script error." }), true);
  assert.equal(isOpaqueCrossOriginError({ message: "Script error", error: null }), true);
  assert.equal(isOpaqueCrossOriginError({ message: "Script error.", error: new Error("real") }), false);
  assert.equal(isOpaqueCrossOriginError({ message: "TypeError: x is undefined" }), false);
  assert.equal(isOpaqueCrossOriginError({}), false);
});

test("the listener actually APPLIES the filter, before it reports", () => {
  const src = stripComments(readFileSync(join(process.cwd(), "app/lib/clientError.ts"), "utf8"));
  const drop = src.indexOf("if (isOpaqueCrossOriginError(e)) return;");
  const report = src.indexOf('reportClientError("onerror"');
  assert.ok(drop > 0 && report > drop, "the drop sits inside onError, ahead of the report");
});
