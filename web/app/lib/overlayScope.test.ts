// Guards the /chat overlay's write-isolation rule.
//
// The overlay keeps its appearance in an isolated "ov:" keyspace so tuning the
// OBS overlay never touches the site chat. Reads and writes go through
// settingGet/settingSet, which apply the scope — but a hydration path that pulls
// the account's DB blob and writes it with a RAW lsSet bypasses that entirely:
// on /chat it overwrites the SITE keyspace with whatever the OBS machine's
// device_class returned, and those poisoned base values then leak into the "ov:"
// keys through their lazy seed-on-read.
//
// The failure is silent — the overlay keeps rendering, it just renders someone
// else's settings, and the site's stored look is already gone.
//
// ChatSettings and SettingsHydrator (mounted on EVERY page including /chat) share
// one DB pull, `pullAccountSettings` in `app/lib/accountSettings.ts`, so the
// guard this file pins lives there — see settingsMigrateWiring.test.ts for the
// "both components use the one shared pull, neither keeps its own copy" half of
// this invariant.
//
// Static guard: these modules can't be imported here (settingsRegistry
// re-exports ./settingsMenu with an extensionless specifier, which node --test
// cannot resolve — see settingsDefaults.test.ts).
//
// Run: node --test app/lib/overlayScope.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), "app", ...p), "utf8");

test("accountSettings: the settings DB fetch runs after the overlay early-return", () => {
  const src = read("lib", "accountSettings.ts");
  const guardAt = src.indexOf("if (isOverlayScope()) return");
  assert.notEqual(guardAt, -1,
    "no `if (isOverlayScope()) return` early-return — the DB pull must be skipped on /chat");
  const fetchAt = src.search(/getJson<[\s\S]{0,200}?`\/api\/me\/settings/);
  assert.notEqual(fetchAt, -1, "the /api/me/settings fetch was not found");
  assert.ok(fetchAt > guardAt,
    "the /api/me/settings fetch must not run on the overlay — it is device-local by design");
});

test("accountSettings: every unscoped lsSet of a settings key comes after the overlay early-return", () => {
  const src = read("lib", "accountSettings.ts");
  const guardAt = src.indexOf("if (isOverlayScope()) return");
  assert.notEqual(guardAt, -1);
  // The DB→localStorage writes are deliberately raw/unscoped (they seed the site
  // keyspace). They are only safe while unreachable from /chat.
  for (const call of [/lsSet\(ENTRIES\[key\]\.ls,/, /lsSet\("chatUsernameColor",/, /lsSet\(SETTINGS_VERSION_KEY,/]) {
    const at = src.search(call);
    assert.notEqual(at, -1, `unscoped write ${call} not found`);
    assert.ok(at > guardAt, `unscoped write ${call} escaped the overlay guard`);
    assert.equal(src.match(new RegExp(call.source, "g"))?.length, 1,
      `unscoped write ${call} appears more than once — a second copy may sit outside the guard`);
  }
});

// The "ov:" keyspace belongs to TWO pages: /chat (the streamer's own chat
// window) and /overlay/chat (the OBS browser source). settingsScope() and the
// prepaint <script> in app/layout.tsx each carry the path list; a page named in
// one and not the other styles itself from the site keyspace before hydration
// and from the scoped one after — a visible flash, and a silent write leak.
test("settingsScope and the prepaint mirror scope the same pages", () => {
  const registry = read("lib", "settingsRegistry.ts");
  const layout = read("layout.tsx");
  const fn = registry.match(/export function settingsScope\(\): string \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(fn, "settingsScope() not found");
  const fromRegistry = [...fn.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]).sort();
  const pre = layout.match(/_OV=location[^;]*;/)?.[0] ?? "";
  assert.ok(pre, "the prepaint's _OV line not found");
  const fromLayout = [...pre.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(fromRegistry, ["/chat", "/overlay/chat"], "the window and the OBS source both live in the ov: scope");
  assert.deepEqual(fromLayout, fromRegistry, "the prepaint mirror must name exactly the same pages");
});
