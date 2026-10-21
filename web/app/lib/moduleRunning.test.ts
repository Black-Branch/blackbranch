// The module rule (config/modules.mjs "ONE RULE"), one test per module: a switch is ON where and
// when the process that SERVES the module runs it, and web shows the module's part from that
// process's own report — never from the saved switch. The radio was the failure: stream-api applies
// its switch at restart while the home page read the saved one, so ON showed a tab whose routes
// answered 404 and OFF hid it while stream-api kept generating DJ segments.
// Run: node --test app/lib/moduleRunning.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODULES } from "./instanceSchema.generated.mjs";
import { moduleRunning, type ServingSnapshot } from "./moduleRunning.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");

/** A snapshot in which the serving process reports `on` for the module. */
function reporting(id: string, pkg: string, on: boolean): ServingSnapshot {
  const keys = { [`modules.${id}`]: { display: on } };
  return pkg === "stream-api" ? { self: keys } : { reports: { [pkg]: { keys } } };
}

assert.ok(MODULES.length >= 7, "the module list did not load");

for (const m of MODULES) {
  test(`module ${m.id}: ${m.packages.some((p) => p !== "web") ? "web follows the process that serves it" : "web's own switch, at once"}`, () => {
    // The process that serves it: stream-api when it runs the module, else the other server
    // process that reads the switch, else web itself.
    const pkg = m.packages.includes("stream-api") ? "stream-api" : m.packages.find((p) => p !== "web") ?? "web";

    if (pkg === "web") {
      // Nothing else serves it: the saved switch IS the running one.
      assert.equal(moduleRunning(m, reporting(m.id, "stream-api", false), true), true);
      assert.equal(moduleRunning(m, reporting(m.id, "stream-api", true), false), false);
      return;
    }
    // Saved ON, not yet applied (the server has not restarted): not shown — its routes are not up.
    assert.equal(moduleRunning(m, reporting(m.id, pkg, false), true), false);
    // Saved OFF, still running until the restart: still shown — it is still running.
    assert.equal(moduleRunning(m, reporting(m.id, pkg, true), false), true);
    // The serving process has not said: web's own reading, either way.
    assert.equal(moduleRunning(m, null, true), true);
    assert.equal(moduleRunning(m, null, false), false);
    // Another process's report is not the serving one's.
    const other = pkg === "stream-api" ? "stream-ingest" : "stream-api";
    assert.equal(moduleRunning(m, reporting(m.id, other, false), true), true);
  });
}

test("the rule is written once, where every package can cite it, and the backend cites it", () => {
  const manifest = readFileSync(join(REPO, "config", "modules.mjs"), "utf8");
  assert.match(manifest, /ONE RULE for a switch more than one package reads/);
  assert.match(manifest, /app\/lib\/moduleRunning\.ts/);
  assert.match(manifest, /^\];\s*$/m, "END anchor: the manifest list read to its end");
  const backend = readFileSync(join(REPO, "stream-api", "modules.js"), "utf8");
  assert.match(backend, /ONE RULE/);
  assert.match(backend, /module\.exports = \{ createModules, STREAM_API_MODULES: MODULES \};\s*$/, "END anchor");
});

test("the home page and the About page take module state from the rule, not the saved switch", () => {
  const home = readFileSync(join(REPO, "web", "app", "(main)", "page.tsx"), "utf8");
  assert.match(home, /modulesOff\(\)/);
  assert.match(home, /offModules=\{off\}/);
  assert.match(home, /<SupportModulesOff off=\{off\} facts=\{support\} \/>/);
  const about = readFileSync(join(REPO, "web", "app", "about", "page.tsx"), "utf8");
  assert.match(about, /modulesShown\(\)/);
});
