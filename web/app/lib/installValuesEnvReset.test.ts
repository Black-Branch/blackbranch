// The install values survive the dev server resetting process.env. `next dev` puts process.env back
// to the environment it started with (@next/env loadEnvConfig → replaceProcessEnv), which DELETES a
// key the boot added after start — process.env.INSTALL_VALUES among them. Every reader
// (matrixBaseUrl(), the site name, the CSP origins …) then answered "" and routes fell through: the
// media route to its last-line 404. `next start` never reloads its env; this is the dev server's.
// The boot therefore also keeps the values in a process-wide holder the reader consults first, and
// the reader re-resolves from the environment when both are gone.
// Own file: it publishes into this process's real environment. Run:
//   node --test app/lib/installValuesEnvReset.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const ENV = { SITE_NAME: "Casey Test", SITE_ORIGIN: "https://site.test", SITE_API_ORIGIN: "https://api.site.test",
  SITE_API_WS_ORIGIN: "wss://api.site.test", MATRIX_SERVER_NAME: "site.test", MATRIX_HOMESERVER_URL: "https://matrix.site.test",
  MATRIX_OAUTH_ISSUER: "https://matrix.site.test/auth/", MATRIX_OAUTH_CLIENT_ID: "01HTESTCLIENT0000000000000" };
delete process.env.INSTALL_VALUES;
Object.assign(process.env, ENV);

const { publishInstallValues } = await import("./installValuesServer.ts");
const { installValue } = await import("./installValues.ts");

test("the values the boot published survive the env key being deleted (next dev's env reset)", () => {
  assert.deepEqual(publishInstallValues(), [], "the test's install values are complete");
  assert.equal(installValue("matrix.baseUrl"), "https://matrix.site.test", "read before the reset");
  delete process.env.INSTALL_VALUES; // what replaceProcessEnv does to a key added after start
  assert.equal(installValue("matrix.baseUrl"), "https://matrix.site.test", "the holder still answers");
  assert.equal(installValue("site.name"), "Casey Test");
});

test("holder AND env key both gone: the reader re-resolves from the environment instead of answering blank", () => {
  const holder = (globalThis as Record<symbol, { raw?: string } | undefined>)[Symbol.for("blackbranch.installValues")];
  assert.ok(holder?.raw, "the boot keeps the values in the process-wide holder");
  delete holder.raw;
  delete process.env.INSTALL_VALUES;
  process.env.SITE_NAME = "Casey Again"; // the reset reloads the environment the site runs with
  assert.equal(installValue("site.name"), "Casey Again", "re-resolved, not blank");
  assert.equal(installValue("matrix.baseUrl"), "https://matrix.site.test");
});

test("a publish into some other env object leaves the process's holder alone", () => {
  const before = installValue("site.name");
  const other: Record<string, string | undefined> = { ...ENV, SITE_NAME: "Somebody Else" };
  assert.deepEqual(publishInstallValues(other), []);
  assert.equal(JSON.parse(other.INSTALL_VALUES!)["site.name"], "Somebody Else");
  assert.equal(installValue("site.name"), before);
});
