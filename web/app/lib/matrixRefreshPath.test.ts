// Which token endpoint refreshes a session — decided by the ACCOUNT'S SERVER, never by the stored
// per-user OIDC columns alone. 2026-10-21: five own-server accounts carried June values in
// site.users.oidc_token_endpoint / oidc_client_id (an old dynamically-registered public client),
// so their refresh went to our MAS as that public client while their sessions belonged to the
// static confidential client → `client id mismatch` → invalid_grant → session row deleted → the
// browser signed out every five minutes. An own-server account ALWAYS refreshes locally.
// Run: node --test app/lib/matrixRefreshPath.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { refreshPathFor } from "./matrixRefreshPath.ts";

const OWN = "site.test";
const STALE = { oidc_token_endpoint: "https://auth.site.test/oauth2/token", oidc_client_id: "01OLDPUBLICCLIENT" };

test("an own-server account with stale OIDC columns refreshes through the local (confidential) client", () => {
  assert.deepEqual(refreshPathFor({ matrix_id: "@casey:site.test", ...STALE }, OWN), { kind: "local" });
  assert.deepEqual(refreshPathFor({ matrix_id: "@Casey:Site.Test", ...STALE }, OWN), { kind: "local" }, "server names compare normalised");
});

test("an own-server account with no OIDC columns refreshes locally", () => {
  assert.deepEqual(refreshPathFor({ matrix_id: "@casey:site.test", oidc_token_endpoint: null, oidc_client_id: null }, OWN), { kind: "local" });
});

test("a foreign-server account with its columns refreshes at its own server", () => {
  const row = { matrix_id: "@gadget:gadget.test", oidc_token_endpoint: "https://auth.gadget.test/oauth2/token", oidc_client_id: "01GADGET" };
  assert.deepEqual(refreshPathFor(row, OWN), {
    kind: "federated", tokenEndpoint: "https://auth.gadget.test/oauth2/token", clientId: "01GADGET",
  });
});

test("a foreign-server account missing a column falls back to local, as before", () => {
  assert.deepEqual(refreshPathFor({ matrix_id: "@gadget:gadget.test", oidc_token_endpoint: "https://x.test/oauth2/token", oidc_client_id: null }, OWN), { kind: "local" });
});

test("a server that only ENDS in our name is foreign", () => {
  const row = { matrix_id: "@m:evil-site.test", oidc_token_endpoint: "https://auth.evil-site.test/oauth2/token", oidc_client_id: "01EVIL" };
  assert.equal(refreshPathFor(row, OWN).kind, "federated");
});

// matrixSession.ts imports @/auth and the pg pool, so it cannot run here: this pins that BOTH of its
// readers of the OIDC columns (the refresh and the account page) go through refreshPathFor.
test("matrixSession reads the OIDC columns only through refreshPathFor", () => {
  const raw = readFileSync(join(import.meta.dirname, "matrixSession.ts"), "utf8");
  const src = stripComments(raw);
  const outsideSelect = src.replace(/`[^`]*`/g, "``");
  assert.doesNotMatch(outsideSelect, /row\.oidc_(token_endpoint|client_id)/, "no direct read of the per-user OIDC columns");
  const resolveStart = src.indexOf("async function resolve(");
  const resolveBody = src.slice(resolveStart, src.indexOf("\n}\n", resolveStart));
  assert.match(resolveBody, /refreshPathFor\(row\)/);
  const acctStart = src.indexOf("async function accountUrlFor(");
  const acctBody = src.slice(acctStart, src.indexOf("\n}\n", acctStart));
  assert.match(acctBody, /refreshPathFor\(row\)/);
  assert.match(src, /export async function destroyMatrixSession\(/, "the scan did not reach the END of the file");
});
