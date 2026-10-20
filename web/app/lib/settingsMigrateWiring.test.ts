// Source-scan pins that the converter runs at every entry point.
// Run: node --test app/lib/settingsMigrateWiring.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const raw = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const src = (...p: string[]) => { const r = raw(...p); assert.ok(r.trimEnd().length > 200, `${p.join("/")} read short`); return stripComments(r); };

test("the account pull converts both keyspaces, site first, then the DB blob", () => {
  const s = src("app", "lib", "accountSettings.ts");
  const site = s.indexOf('migrateStore(window.localStorage, "")');
  const ov = s.indexOf('migrateStore(window.localStorage, "ov:")');
  assert.ok(site > -1 && ov > site, "site keyspace must convert before ov:");
  assert.match(s, /migrateSettingsBlob\(settings\)/, "the DB blob is written unconverted");
});

test("SettingsHydrator and ChatSettings share the one pull — no second copy", () => {
  for (const f of [["app", "components", "SettingsHydrator.tsx"], ["app", "components", "ChatSettings.tsx"]] as const) {
    const s = src(...f);
    assert.match(s, /pullAccountSettings\(\)/, `${f.at(-1)} does not use pullAccountSettings`);
    // ChatSettings still PUTs to /api/me/settings (the save); only the GET pull moved.
    assert.doesNotMatch(s, /getJson[^;]*\/api\/me\/settings/, `${f.at(-1)} still has its own DB pull`);
  }
});

test("the server converts before whitelisting, and on every read", () => {
  const keys = src("app", "lib", "settingsKeys.ts");
  assert.match(keys, /const migrated = migrateSettingsBlob\(incoming\)/, "sanitize must convert first");
  assert.match(keys, /SETTINGS_VERSION_KEY/, "the stamp is not whitelisted");
  assert.match(src("app", "api", "me", "settings", "route.ts"), /migrateSettingsBlob\(/, "settings GET returns v1 blobs");
  assert.match(src("app", "api", "me", "presets", "route.ts"), /migrateSettingsBlob\(/, "presets GET returns v1 blobs");
});

test("a preset landing converts its blob before reading any key (browser-saved presets are raw)", () => {
  const s = src("app", "components", "ChatSettings.tsx");
  const start = s.indexOf("const applyBlob = useCallback(");
  assert.ok(start > -1, "applyBlob not found");
  const body = s.slice(start, s.indexOf("}, [ctx]);", start));
  const conv = body.indexOf("const blob = migrateSettingsBlob(");
  assert.ok(conv > -1, "applyBlob does not convert its blob");
  const firstRead = body.search(/blob\[|blob\.\w/);
  assert.ok(firstRead > conv, "applyBlob reads a key before converting");
  assert.doesNotMatch(body, /savedBlob\[|savedBlob\.\w/, "applyBlob reads the unconverted blob");
});
