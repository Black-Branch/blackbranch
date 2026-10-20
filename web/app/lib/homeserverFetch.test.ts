// homeserverFetch's LOCAL branch (our own homeserver, plain fetch) gets the same body-covering
// deadline as safeFetch. Our homeserver is trusted, not infallible: a wedged Synapse that sends
// headers and then stalls would otherwise hold every reader that waits on it (devices, profile,
// presence, the token refresh on nearly every authenticated request) for as long as it stalls.
// Run: node --test app/lib/homeserverFetch.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { trickleServer, within } from "./testTrickleServer.ts";
import { readJsonCapped } from "./boundedBody.ts";

const srv = await trickleServer();
const LOCAL = `http://127.0.0.1:${srv.port}`;
// This install's homeserver is the trickling server, so homeserverFetch takes the plain-fetch branch.
process.env.INSTALL_VALUES = JSON.stringify({ "matrix.baseUrl": LOCAL });

const { homeserverFetch } = await import("./homeserverFetch.ts");
const { isLocalHomeserverUrl } = await import("./homeserverTrust.ts");

test.after(() => srv.close());

test("the trickling server is treated as our own homeserver (plain fetch, not safeFetch)", () => {
  assert.equal(isLocalHomeserverUrl(`${LOCAL}/_matrix/client/v3/devices`), true);
});

test("a trickling body from our own homeserver fails inside timeoutMs", async () => {
  const started = Date.now();
  const outcome = await within((async () => {
    const res = await homeserverFetch(`${LOCAL}/_matrix/client/v3/devices`, { timeoutMs: 1000 });
    assert.equal(res.status, 200);
    return readJsonCapped(res, 64 * 1024);
  })().catch(() => null), 4000);
  assert.notEqual(outcome, "hung", "the local branch has no deadline over the body");
  assert.equal(outcome, null);
  assert.ok(Date.now() - started < 2500);
});

test("with no options the default deadline applies on the local branch too", { timeout: 20_000 }, async () => {
  const started = Date.now();
  const outcome = await within((async () => {
    const res = await homeserverFetch(`${LOCAL}/_matrix/client/v3/devices`);
    return readJsonCapped(res, 64 * 1024);
  })().catch(() => null), 13_000);
  assert.notEqual(outcome, "hung", "no default deadline on the local branch");
  assert.equal(outcome, null);
  assert.ok(Date.now() - started < 12_000);
});
