// The revocation request's answer (matrixOAuthClient.ts revokeAtOutcome), EXECUTED against a stub
// transport: confirmed only on 2xx, and when not, the reason the journal line needs — the server's
// OAuth error and description, or what failed on the way.
// Run: node --test app/lib/matrixOAuthClient.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { revokeAt, revokeAtOutcome } from "./matrixOAuthClient.ts";

const EP = "https://auth.gadget.test/oauth2/revoke";
const answer = (status: number, body: string) => async () => new Response(body, { status, headers: { "Content-Type": "application/json" } });

test("a 2xx is confirmed (RFC 7009 §2.2: an already-invalid token answers 200 too)", async () => {
  assert.deepEqual(await revokeAtOutcome(EP, null, "rt", "refresh_token", { client_id: "c" }, answer(200, "")), { ok: true, endpoint: EP });
  assert.equal(await revokeAt(EP, null, "rt", "refresh_token", {}, answer(200, "")), true);
});

test("a refusal carries the server's error and error_description", async () => {
  const r = await revokeAtOutcome(EP, null, "rt", "refresh_token", {}, answer(401, JSON.stringify({ error: "invalid_client", error_description: "client authentication failed" })));
  assert.deepEqual(r, { ok: false, endpoint: EP, error: "invalid_client", description: "client authentication failed" });
  assert.equal(await revokeAt(EP, null, "rt", "refresh_token", {}, answer(401, "{}")), false);
});

test("a refusal without an OAuth body is named by its status; an unreadable body too", async () => {
  assert.deepEqual(await revokeAtOutcome(EP, null, "rt", "refresh_token", {}, answer(503, "upstream down")), { ok: false, endpoint: EP, error: "http_503" });
  assert.deepEqual(await revokeAtOutcome(EP, null, "rt", "refresh_token", {}, answer(400, JSON.stringify({ error: "x", pad: "p".repeat(40_000) }))), { ok: false, endpoint: EP, error: "http_400" });
});

test("a network failure is named by its code and never throws", async () => {
  const failed = async (): Promise<Response> => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }); };
  assert.deepEqual(await revokeAtOutcome(EP, null, "rt", "refresh_token", {}, failed), { ok: false, endpoint: EP, error: "CERT_HAS_EXPIRED" });
  const odd = async (): Promise<Response> => { throw "not an error"; };
  assert.deepEqual(await revokeAtOutcome(EP, null, "rt", "refresh_token", {}, odd), { ok: false, endpoint: EP, error: "network" });
});
