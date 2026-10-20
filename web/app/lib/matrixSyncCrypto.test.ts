// The sync door (matrixSyncCrypto.ts): behaviour on a fake crypto backend, then the SDK and engine
// facts it rests on, pinned against node_modules — an upgrade that changes any of them fails here
// before it ships.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/matrixSyncCrypto.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { installSyncCryptoDoor, refusedKeyUploadFetch, REFRESH_MS, type SyncChanges } from "./matrixSyncCrypto.ts";

const counts = (n: number) => new Map([["signed_curve25519", n]]);

/** A fake RustCrypto whose `receiveSyncChanges` records what reached the engine. */
function backend() {
  const seen: SyncChanges[] = [];
  const crypto = {
    tag: "backend",
    async receiveSyncChanges(this: { tag: string }, c: SyncChanges) { assert.equal(this.tag, "backend"); seen.push(c); return ["processed"]; },
  };
  let t = 0;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  assert.equal(installSyncCryptoDoor(crypto, clock.now), true);
  return { crypto, seen, clock };
}

test("a to-device-only call reaches the engine WITH the last counts the server reported (no 'zero keys' → no new batch)", async () => {
  const { crypto, seen } = backend();
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(500) });
  const out = await crypto.receiveSyncChanges({ events: [{ type: "m.room_key" }] });
  assert.deepEqual(out, ["processed"], "the to-device result must come back to the SDK");
  assert.equal(seen.length, 2);
  assert.deepEqual([...seen[1]!.oneTimeKeysCounts!], [["signed_curve25519", 500]]);
  assert.deepEqual(seen[1]!.events, [{ type: "m.room_key" }]);
});

test("before any count is known, a stood-in count asks for nothing; the real count later in the sync still decides", async () => {
  const { crypto, seen } = backend();
  await crypto.receiveSyncChanges({ events: [{ type: "m.room_key" }] });
  assert.ok((seen[0]!.oneTimeKeysCounts!.get("signed_curve25519") ?? 0) >= 50, "a stood-in count below the engine's target of 50 would generate keys");
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(3) });
  assert.equal(seen.length, 2, "the real count must reach the engine even though a call came before it");
  assert.equal(seen[1]!.oneTimeKeysCounts!.get("signed_curve25519"), 3);
});

test("a device-list-only call also carries the last counts", async () => {
  const { crypto, seen } = backend();
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(120) });
  await crypto.receiveSyncChanges({ devices: { changed: ["@casey:site.test"] } });
  assert.equal(seen[1]!.oneTimeKeysCounts!.get("signed_curve25519"), 120);
  assert.deepEqual(seen[1]!.devices, { changed: ["@casey:site.test"] });
});

test("identical key counts on the next sync do not reach the engine (no store commit per idle sync)", async () => {
  const { crypto, seen } = backend();
  const fb = new Set(["signed_curve25519"]);
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(500), unusedFallbackKeys: fb });
  for (let i = 0; i < 20; i++) await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(500), unusedFallbackKeys: new Set(fb) });
  assert.equal(seen.length, 1);
});

test("a changed count, a changed fallback list, or the refresh interval each go through", async () => {
  const { crypto, seen, clock } = backend();
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(500), unusedFallbackKeys: new Set(["signed_curve25519"]) });
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(499), unusedFallbackKeys: new Set(["signed_curve25519"]) });
  assert.equal(seen.length, 2, "a claimed key changes the count");
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(499), unusedFallbackKeys: new Set() });
  assert.equal(seen.length, 3, "a used fallback key must reach the engine (it makes a new one)");
  clock.advance(REFRESH_MS - 1);
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(499), unusedFallbackKeys: new Set() });
  assert.equal(seen.length, 3);
  clock.advance(1);
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(499), unusedFallbackKeys: new Set() });
  assert.equal(seen.length, 4, "time-based upkeep (fallback-key expiry) needs a call at least every REFRESH_MS");
});

test("a to-device or device-list call is never skipped, even with unchanged counts", async () => {
  const { crypto, seen } = backend();
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(500) });
  await crypto.receiveSyncChanges({ events: [{ type: "m.key.verification.request" }], oneTimeKeysCounts: counts(500) });
  await crypto.receiveSyncChanges({ devices: {}, oneTimeKeysCounts: counts(500) });
  assert.equal(seen.length, 3);
});

test("an empty to-device list with counts is a key-count call (the SDK's own '[]' case)", async () => {
  const { crypto, seen } = backend();
  await crypto.receiveSyncChanges({ oneTimeKeysCounts: counts(7) });
  await crypto.receiveSyncChanges({ events: [], oneTimeKeysCounts: counts(7) });
  assert.equal(seen.length, 1);
});

test("a backend without the method is left alone", () => {
  assert.equal(installSyncCryptoDoor({}), false);
  assert.equal(installSyncCryptoDoor(null), false);
  assert.equal(installSyncCryptoDoor(undefined), false);
});

// ── A one-time-key batch the server refuses (refusedKeyUploadFetch) ─────────────────────────

const UPLOAD = new URL("https://hs.site.test/_matrix/client/v3/keys/upload");
const TOO_LARGE = { errcode: "M_TOO_LARGE", error: "Uploading 50 more signed_curve25519 one-time keys would leave the device holding 550, over the limit of 500" };
// The engine's real body: an EMPTY fallback_keys beside the batch (as seen on the wire).
const otkBody = JSON.stringify({ fallback_keys: {}, one_time_keys: { "signed_curve25519:AAAA": { key: "k" } } });

function server(first: { status: number; json: unknown }, counts: { status: number; json: unknown } = { status: 200, json: { one_time_key_counts: { signed_curve25519: 500 } } }) {
  const calls: Array<{ url: string; body: unknown; auth: unknown }> = [];
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const r = calls.length === 1 ? first : counts;
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetch: refusedKeyUploadFetch(base) };
}
const post = (body: string) => ({ method: "POST", body, headers: { Authorization: "Bearer t" } });

test("a refused one-time-key-only batch is answered with the server's own counts, so the engine stops re-sending it", async () => {
  const s = server({ status: 400, json: TOO_LARGE });
  const res = await s.fetch(UPLOAD, post(otkBody));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { one_time_key_counts: { signed_curve25519: 500 } });
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1]!.body, "{}", "the counts come from an EMPTY upload — nothing is stored");
  assert.equal(s.calls[1]!.auth, "Bearer t", "same request, same token");
});

test("anything else passes through untouched: device keys, a fallback key, another error, another route, a success", async () => {
  for (const extra of [{ device_keys: { user_id: "@casey:site.test" } }, { fallback_keys: { "signed_curve25519:BBBB": { key: "f" } } }]) {
    const s = server({ status: 400, json: TOO_LARGE });
    const res = await s.fetch(UPLOAD, post(JSON.stringify({ ...JSON.parse(otkBody), ...extra })));
    assert.equal(res.status, 400, `a batch with ${Object.keys(extra)[0]} must fail as before`);
    assert.equal(s.calls.length, 1);
  }
  const other = server({ status: 400, json: { errcode: "M_BAD_JSON" } });
  assert.equal((await other.fetch(UPLOAD, post(otkBody))).status, 400);
  const route = server({ status: 400, json: TOO_LARGE });
  assert.equal((await route.fetch("https://hs.site.test/_matrix/client/v3/keys/claim", post(otkBody))).status, 400);
  const ok = server({ status: 200, json: { one_time_key_counts: { signed_curve25519: 100 } } });
  assert.equal((await ok.fetch(UPLOAD, post(otkBody))).status, 200);
  for (const s of [other, route, ok]) assert.equal(s.calls.length, 1);
});

test("if the counts cannot be read, the original refusal stands", async () => {
  const s = server({ status: 400, json: TOO_LARGE }, { status: 500, json: {} });
  assert.equal((await s.fetch(UPLOAD, post(otkBody))).status, 400);
});

// ── The SDK and engine facts the door rests on (node_modules) ───────────────────────────────

const sdk = (file: string) => stripComments(readFileSync(join(process.cwd(), "node_modules/matrix-js-sdk/lib", file), "utf8"));
const method = (src: string, head: string) => {
  const start = src.indexOf(head);
  assert.ok(start > 0, `${head} not found in the SDK`);
  return src.slice(start, src.indexOf("\n  }\n", start));
};

test("SDK: RustCrypto's sync callers all go through this.receiveSyncChanges, each with ONE part of the sync", () => {
  const rc = sdk("rust-crypto/rust-crypto.js");
  assert.match(method(rc, "async preprocessToDeviceMessages("), /this\.receiveSyncChanges\(\{\s*events\s*\}\)/);
  assert.match(method(rc, "async processKeyCounts("), /this\.receiveSyncChanges\(\{\s*oneTimeKeysCounts: mapOneTimeKeysCount,\s*unusedFallbackKeys: setUnusedFallbackKeys\s*\}\)/);
  assert.match(method(rc, "async processDeviceLists("), /this\.receiveSyncChanges\(\{\s*devices\s*\}\)/);
  // The door replaces the method on the instance; a direct olmMachine call elsewhere would bypass it.
  assert.equal((rc.match(/this\.olmMachine\.receiveSyncChanges\(/g) ?? []).length, 1, "only receiveSyncChanges itself may call the engine's receiveSyncChanges");
});

test("SDK: a missing count still defaults to an EMPTY map — what the engine reads as 'zero keys'", () => {
  const rc = sdk("rust-crypto/rust-crypto.js");
  const fn = method(rc, "async receiveSyncChanges(");
  assert.match(fn, /oneTimeKeysCounts = new Map\(\)/);
  assert.match(fn, /this\.olmMachine\.receiveSyncChanges\(events \? JSON\.stringify\(events\) : "\[\]", devices, oneTimeKeysCounts, unusedFallbackKeys\)/);
});

test("SDK: the sync loop processes to-device first and key counts LAST, on every sync", () => {
  const sync = sdk("sync.js");
  const toDevice = sync.indexOf("cryptoCallbacks.preprocessToDeviceMessages(");
  const deviceLists = sync.indexOf("cryptoCallbacks.processDeviceLists(");
  const keyCounts = sync.indexOf("await this.syncOpts.cryptoCallbacks?.processKeyCounts(data.device_one_time_keys_count");
  assert.ok(toDevice > 0 && deviceLists > toDevice && keyCounts > deviceLists, "the stood-in count relies on the real one arriving later in the same sync");
  // Unconditional: not inside an `if (data.device_one_time_keys_count)` guard.
  const before = sync.slice(sync.lastIndexOf("\n", keyCounts - 60), keyCounts);
  assert.doesNotMatch(before, /\bif\s*\(/);
});

test("engine: still 18.5.x — the version whose missing-count-means-zero this door corrects", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "node_modules/@matrix-org/matrix-sdk-crypto-wasm/package.json"), "utf8")) as { version: string };
  // 18.7.0 added receiveSyncChangesMsc4186 ("missing means unchanged"). On an upgrade, re-measure
  // and prefer that method for count-less calls.
  assert.match(pkg.version, /^18\.5\./, `engine is ${pkg.version}: re-check matrixSyncCrypto.ts against it`);
});

test("SDK: the engine's key upload is a POST to /v3/keys/upload whose raw response goes to markRequestAsSent", () => {
  const proc = sdk("rust-crypto/OutgoingRequestProcessor.js");
  assert.match(proc, /msg instanceof KeysUploadRequest\) \{\s*resp = await this\.requestWithRetry\(Method\.Post, "\/_matrix\/client\/v3\/keys\/upload", \{\}, msg\.body\)/);
  assert.match(method(proc, "async makeOutgoingRequest("), /this\.olmMachine\.markRequestAsSent\(msg\.id, msg\.type, resp\)/);
  assert.match(method(sdk("http-api/fetch.js"), "fetch(resource, options) {"), /if \(this\.opts\.fetchFn\) \{\s*return this\.opts\.fetchFn\(resource, options\);/);
});

test("wiring: createClient sends through refusedKeyUploadFetch", () => {
  const ctx = stripComments(readFileSync(join(process.cwd(), "app/lib/MatrixClientContext.tsx"), "utf8"));
  const create = ctx.indexOf("createClient({");
  assert.ok(create > 0);
  assert.match(ctx.slice(create, ctx.indexOf("});", create)), /fetchFn: refusedKeyUploadFetch\(\)/);
});

test("wiring: setupCrypto installs the door right after initRustCrypto, before the first sync", () => {
  const ctx = stripComments(readFileSync(join(process.cwd(), "app/lib/MatrixClientContext.tsx"), "utf8"));
  const init = ctx.indexOf("await mxClient.initRustCrypto(");
  const door = ctx.indexOf("installSyncCryptoDoor(mxClient.getCrypto())");
  const start = ctx.indexOf("await mxClient.startClient(");
  assert.ok(init > 0 && door > init && start > door, "the door must be in place before startClient's first sync");
});
