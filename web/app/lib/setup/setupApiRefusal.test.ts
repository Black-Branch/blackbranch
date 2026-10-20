// The setup API's default is the OPPOSITE of the public gate's: the public site fails open when
// the settings are not loaded, the setup routes fail CLOSED — they hand out the backup passphrase,
// make accounts and write .env values.
// Run: node --test app/lib/setup/setupApiRefusal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupApiRefusal, gateAction } from "./setupGate.ts";

test("all three states: running → allowed; finished → 409; settings not loaded → 503", () => {
  assert.equal(setupApiRefusal("setting-up"), null);
  assert.deepEqual(setupApiRefusal("complete"), { status: 409, error: "setup is finished — use the Admin Panel" });
  assert.deepEqual(setupApiRefusal("unknown"), { status: 503, error: "the site's settings are not loaded yet — try again in a moment" });
  // …while the public gate keeps failing open on the same state.
  assert.equal(gateAction("/", "unknown"), "pass");
});

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "setupServer.ts"), "utf8");
/** A function's body, from its signature to the next top-level closing brace. */
function body(name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} has no end`);
  return src.slice(start, end);
}

test("the one refusal is the setup API's: closedResponse asks setupApiRefusal, never the public gate", () => {
  const cr = src.slice(src.indexOf("function closedResponse()"), src.indexOf("\n}\n", src.indexOf("function closedResponse()")));
  assert.match(cr, /const r = setupApiRefusal\(setupStatus\(\)\);\n {2}return r \? fail\(r\.status, r\.error\) : null;/);
  // requireSetupAdmin (every step after the first) starts with it.
  const rsa = src.slice(src.indexOf("async function requireSetupAdmin("), src.indexOf("\n}\n", src.indexOf("async function requireSetupAdmin(")));
  assert.match(rsa, /^async function requireSetupAdmin\([^)]*\): [^{]+\{\n {2}const closed = closedResponse\(\);\n {2}if \(closed\) return closed;/);
});

test("createFirstAdmin, the recovery sheet, a later step and every other setup route pass through it first", () => {
  // Step 1 refuses before it looks at the token or the database.
  assert.match(body("createFirstAdmin"), /cross-site request refused"\);\n {2}const closed = closedResponse\(\);\n {2}if \(closed\) return closed;\n {2}const adminExists/);
  for (const name of ["recoverySheet", "saveStep", "setupTest", "startCommunity", "communityStatus", "startBackupTest", "requestBackupKey", "backupTestStatus", "finishSetup", "finishStatus"]) {
    assert.match(body(name), /\): Promise<Out> \{\n {2}const who = await requireSetupAdmin\(req, (true|false)\);\n {2}if \(typeof who !== "string"\) return who;/, name);
  }
  // The recovery sheet hands out the passphrase only after that check.
  const rs = body("recoverySheet");
  assert.ok(rs.indexOf("hostRecoveryPassphrase(") > 0, "the passphrase comes from the host");
  assert.ok(rs.indexOf("requireSetupAdmin") < rs.indexOf("hostRecoveryPassphrase("), "the passphrase is asked for only after the refusal");
  assert.doesNotMatch(src, /process\.env\.BACKUP_PASSPHRASE/, "never from this process's environment");
  // Vacuity anchor on the END of the file: the last route is still there.
  assert.match(src, /export async function finishStatus\(req: Request\): Promise<Out> \{[\s\S]*\n\}\n$/);
});

test("the page: settings not loaded → nothing offered; a database error is 'cannot check', never a usable link", () => {
  const v = body("setupView");
  assert.match(v, /if \(status === "unknown"\) return \{ phase: "unavailable" \};/);
  assert.match(v, /await anyAdminRow\(\)\.catch\(\(\) => null\)/);
  assert.doesNotMatch(v, /anyAdminRow\(\)\.catch\(\(\) => false\)/);
  assert.match(v, /linkOk: adminRow === null \? null :/);
});
