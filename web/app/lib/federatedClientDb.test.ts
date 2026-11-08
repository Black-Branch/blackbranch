// A2-04 on the REAL schema (v168), through the real driver: the one-client-per-server registry,
// the federated callback's session upsert with its binding, and the session loader that prefers
// the session's binding over the account's. A mock pool accepts illegal SQL; this does not.
// Needs SQL_PARSE_DATABASE_URL (a replayed throwaway database — CI sets it; never prod).
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/federatedClientDb.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { federatedClientId, forgetFederatedClient } from "./federatedSignIn.ts";
import { loadSessionRow } from "./matrixSessionCore.ts";

const url = process.env.SQL_PARSE_DATABASE_URL || "";

test("the registry, the session binding and the loader on Postgres", async (t) => {
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  const q = (sql: string, params: unknown[]) => db.query(sql, params);
  const who = "@a204test-casey:gadget.test";
  const reg = `https://auth.gadget.test/oauth2/registration#a204-${Date.now()}`;
  const redirect = "https://site.test/api/auth/matrix-callback";
  const clean = async () => {
    await db.query(`DELETE FROM site.user_sessions WHERE matrix_id = $1`, [who]);
    await db.query(`DELETE FROM site.users WHERE matrix_id = $1`, [who]);
    await db.query(`DELETE FROM site.oauth_clients WHERE registration_endpoint = $1`, [reg]);
  };
  await clean();
  try {
    let registrations = 0;
    const register = async () => `a204-client-${++registrations}`;
    assert.equal(await federatedClientId({ query: q, register }, reg, redirect), "a204-client-1");
    assert.equal(await federatedClientId({ query: q, register }, reg, redirect), "a204-client-1");
    assert.equal(registrations, 1);

    // Two devices sign in through the callback's own upsert (read from the route), each bound to
    // the client its tokens came with; the account row's columns hold something else entirely.
    await db.query(`INSERT INTO site.users (matrix_id, display_name, homeserver, oidc_token_endpoint, oidc_client_id)
      VALUES ($1, 'casey', 'https://matrix.gadget.test', 'https://old.gadget.test/oauth2/token', 'a204-legacy')`, [who]);
    const route = readFileSync(join(import.meta.dirname, "../api/auth/matrix-callback/route.ts"), "utf8");
    const upsert = /`(INSERT INTO site\.user_sessions[\s\S]*?RETURNING session_id)`/.exec(route)?.[1];
    assert.ok(upsert, "the callback's session upsert was not found");
    const token = "https://auth.gadget.test/oauth2/token";
    const revoke = "https://auth.gadget.test/oauth2/revoke";
    const sidA = (await db.query(upsert, [who, "A204DEVICEA", "at", "rt", 0, token, "a204-client-A", revoke])).rows[0].session_id as string;
    const sidB = (await db.query(upsert, [who, "A204DEVICEB", "at", "rt", 0, token, "a204-client-B", null])).rows[0].session_id as string;
    const a = await loadSessionRow(q, who, sidA);
    const b = await loadSessionRow(q, who, sidB);
    assert.deepEqual([a?.oidc_token_endpoint, a?.oidc_client_id, a?.oidc_revocation_endpoint], [token, "a204-client-A", revoke]);
    assert.equal(b?.oidc_client_id, "a204-client-B", "device B's sign-in did not change device A's client, nor A's B's");

    // A session from before v168 (no binding of its own) reads the account's columns.
    await db.query(`UPDATE site.user_sessions SET oidc_token_endpoint = NULL, oidc_client_id = NULL, oidc_revocation_endpoint = NULL WHERE session_id = $1`, [sidB]);
    const legacy = await loadSessionRow(q, who, sidB);
    assert.deepEqual([legacy?.oidc_token_endpoint, legacy?.oidc_client_id, legacy?.oidc_revocation_endpoint], ["https://old.gadget.test/oauth2/token", "a204-legacy", null]);

    // Keyed by the whole entry: the same id under another registration endpoint is not this entry.
    await forgetFederatedClient(q, { registrationEndpoint: `${reg}-other`, redirectUri: redirect, clientId: "a204-client-1" });
    assert.equal(await federatedClientId({ query: q, register }, reg, redirect), "a204-client-1");
    await forgetFederatedClient(q, { registrationEndpoint: reg, redirectUri: redirect, clientId: "a204-client-1" });
    assert.equal(await federatedClientId({ query: q, register }, reg, redirect), "a204-client-2", "a forgotten client is registered afresh");
  } finally {
    await clean();
    await db.end();
  }
});
