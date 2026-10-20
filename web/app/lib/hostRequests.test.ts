// Asking the host for a fixed action. Run: node --test app/lib/hostRequests.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestHost, hostResult, answers, hostRequestsAvailable, requestRenderFor, hostRecoveryPassphrase, isHostRendered } from "./hostRequests.ts";

test("a request is an empty file named after the verb; the answer is read from the host's folder only", async () => {
  const home = mkdtempSync(join(tmpdir(), "bb-req-"));
  try {
    const dirs = { requests: join(home, "requests"), results: join(home, "results") };
    assert.equal(hostRequestsAvailable(dirs), false);
    assert.deepEqual(await requestHost("apply-install", dirs), { ok: false, error: "this install has no host request folder (it is not the bundle)" });
    mkdirSync(dirs.requests); mkdirSync(dirs.results);
    const r = await requestHost("apply-install", dirs);
    assert.ok(r.ok);
    assert.deepEqual(readdirSync(dirs.requests), ["apply-install.req"]);
    assert.equal(readFileSync(join(dirs.requests, "apply-install.req"), "utf8"), "", "nothing but the verb's name travels");
    assert.equal(await hostResult("apply-install", dirs), null);
    writeFileSync(join(dirs.results, "apply-install.json"), JSON.stringify({ request: "apply-install", ok: false, at: "2000-01-01T00:00:00Z", message: "old" }));
    const old = await hostResult("apply-install", dirs);
    assert.ok(old && r.ok && !answers(old, r.requestedAt), "an answer older than the request is not its answer");
    writeFileSync(join(dirs.results, "apply-install.json"), JSON.stringify({ ok: true, at: new Date(Date.now() + 1000).toISOString(), message: "rebuilt" }));
    const now = await hostResult("apply-install", dirs);
    assert.ok(r.ok && answers(now, r.requestedAt) && now.ok && now.message === "rebuilt");
    writeFileSync(join(dirs.results, "apply-install.json"), "not json");
    assert.equal(await hostResult("apply-install", dirs), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a setting the host renders asks for a render when it changes; any other setting does not", async () => {
  const home = mkdtempSync(join(tmpdir(), "bb-req-"));
  try {
    const dirs = { requests: join(home, "requests"), results: join(home, "results") };
    assert.equal(await requestRenderFor("matrix.registration", dirs), false, "no drop box: nothing to ask");
    mkdirSync(dirs.requests); mkdirSync(dirs.results);
    assert.equal(await requestRenderFor("site.name", dirs), false);
    assert.deepEqual(readdirSync(dirs.requests), []);
    // The quiet hour and time zone become the host's timers (install/blackbranch backup_timers):
    // without a render they waited for the next backup to re-render them, a night late.
    for (const key of ["matrix.federation", "matrix.registration", "updates.quietHour", "site.timeZone"]) {
      assert.equal(await requestRenderFor(key, dirs), true, key);
      assert.deepEqual(readdirSync(dirs.requests), ["render.req"], key);
      rmSync(join(dirs.requests, "render.req"));
    }
    // The site reads those two live: they ask for a render, but are not "applied by the host" in the panel.
    assert.equal(isHostRendered("updates.quietHour"), false); assert.equal(isHostRendered("site.timeZone"), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the Admin Panel's write and clear, and setup's Finish, ask for that render", () => {
  const route = readFileSync(new URL("../api/admin/instance/[key]/route.ts", import.meta.url), "utf8");
  assert.match(route, /export async function PUT[\s\S]*?requestRenderFor\(name\)[\s\S]*?export async function DELETE[\s\S]*?requestRenderFor\(name\)/);
  const setup = readFileSync(new URL("./setup/setupServer.ts", import.meta.url), "utf8");
  // Setup's end opens sign-up (the default once setup is finished) — only a render applies it.
  assert.match(setup.match(/async function complete\(\)[\s\S]*?\n\}\n/)?.[0] ?? "", /"render"/);
  // Vacuity: the end of both files was read.
  assert.match(route, /\}\n$/); assert.match(setup, /\}\n$/);
});

test("the recovery sheet's passphrase: read from the host's folder, asked for when it is not there yet, null when the host has none", async () => {
  const home = mkdtempSync(join(tmpdir(), "bb-req-"));
  try {
    const dirs = { requests: join(home, "requests"), results: join(home, "results") };
    // Not the bundle: nothing to ask, nothing asked.
    assert.equal(await hostRecoveryPassphrase(dirs, 50, 10), null);
    mkdirSync(dirs.requests); mkdirSync(dirs.results);
    // A stand-in host: answers the request the way `blackbranch recovery_sheet` does.
    const host = (sheet: string | null) => setInterval(() => {
      if (!readdirSync(dirs.requests).includes("recovery-sheet.req")) return;
      rmSync(join(dirs.requests, "recovery-sheet.req"));
      if (sheet) writeFileSync(join(dirs.results, "recovery-passphrase.json"), JSON.stringify({ v: 1, passphrase: sheet }));
      writeFileSync(join(dirs.results, "recovery-sheet.json"), JSON.stringify({ ok: !!sheet, at: new Date(Date.now() + 1000).toISOString(), message: sheet ? "ready" : "shown once" }));
    }, 5);
    let t = host("0123456789abcdef0123");
    assert.equal(await hostRecoveryPassphrase(dirs, 2000, 10), "0123456789abcdef0123");
    clearInterval(t);
    // Already there (a reload of the page): read, nothing asked.
    assert.equal(await hostRecoveryPassphrase(dirs, 50, 10), "0123456789abcdef0123");
    assert.deepEqual(readdirSync(dirs.requests), []);
    // The host answers without a sheet (setup moved on, or it was shown): null at once, not after the wait.
    rmSync(join(dirs.results, "recovery-passphrase.json"));
    t = host(null);
    const started = Date.now();
    assert.equal(await hostRecoveryPassphrase(dirs, 5000, 10), null);
    assert.ok(Date.now() - started < 2000, "the answer ends the wait");
    clearInterval(t);
    // No host at all (the path unit is not running): null once the wait is over, the request left behind.
    rmSync(join(dirs.results, "recovery-sheet.json"));
    const waited = Date.now();
    assert.equal(await hostRecoveryPassphrase(dirs, 100, 10), null);
    assert.ok(Date.now() - waited >= 100, "it waited for an answer");
    assert.deepEqual(readdirSync(dirs.requests), ["recovery-sheet.req"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
