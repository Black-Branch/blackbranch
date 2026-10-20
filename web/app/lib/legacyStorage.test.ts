// The first-paint carry-forward of a returning visitor's browser storage (legacyStorage.ts), run as
// the browser runs it: the generated script, in a fresh context, over two storages. "oldsite" is a
// made-up old id.
// Run: node --test app/lib/legacyStorage.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { CARRIED_STEMS, carryLegacyStorageScript } from "./legacyStorage.ts";
import { stripComments } from "./testSource.ts";

function storage(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}
function run(local: Record<string, string>, session: Record<string, string> = {}, legacy: string | null = "oldsite") {
  const ls = storage(local), ss = storage(session);
  vm.runInNewContext(carryLegacyStorageScript(legacy), { window: { localStorage: ls, sessionStorage: ss } });
  return { ls: Object.fromEntries(ls.m), ss: Object.fromEntries(ss.m) };
}

test("no old id: the step is empty — a fresh install runs nothing", () => {
  assert.equal(carryLegacyStorageScript(null), "");
});

test("every carried name moves to bb_<stem> under each old separator; families keep their tail; the ov: scope is kept", () => {
  const { ls, ss } = run({
    oldsite_preset_sel: "2", "ov:oldsite_preset_3": "{}", oldsite_tz_sent: "UTC", "oldsite.tipMethod": "paypal",
    "oldsite:members-open": "1", "oldsite:enc-verdict:@a:x": "ok", oldsite_windock_mod: "{\"x\":1}",
  }, { "oldsite:pending-support": "gift" });
  assert.deepEqual(ls, {
    bb_preset_sel: "2", "ov:bb_preset_3": "{}", bb_tz_sent: "UTC", bb_tipMethod: "paypal",
    "bb_members-open": "1", "bb_enc-verdict:@a:x": "ok", bb_windock_mod: "{\"x\":1}",
  });
  assert.deepEqual(ss, { "bb_pending-support": "gift" });
});

test("a newer value under the new name wins; the old name is removed either way, so a second load does nothing", () => {
  const first = run({ oldsite_tz_sent: "old", bb_tz_sent: "new" });
  assert.deepEqual(first.ls, { bb_tz_sent: "new" });
  const again = run(first.ls);
  assert.deepEqual(again.ls, first.ls);
});

test("the player: its volume key and its stored source value move; the palette value too; nothing else is touched", () => {
  const { ls } = run({
    player_volume_oldsite: "0.4", player_live_source: "oldsite", "ov:chatStyle_platformPalette": "oldsite",
    chatStyle_platformPalette: "brand", oldsite_term_history: "[]", oldsite_unknown: "1", player_volume_youtube: "0.9",
  });
  assert.deepEqual(ls, {
    player_volume_native: "0.4", player_live_source: "native", "ov:chatStyle_platformPalette": "native",
    chatStyle_platformPalette: "brand", oldsite_term_history: "[]", oldsite_unknown: "1", player_volume_youtube: "0.9",
  }, "an owner plugin's own old-prefix keys and unknown names stay where they are");
});

test("a storage that throws (private mode, blocked site data) leaves the page running", () => {
  const boom = { get length(): number { throw new Error("blocked"); } };
  assert.doesNotThrow(() => vm.runInNewContext(carryLegacyStorageScript("oldsite"), { window: { localStorage: boom, sessionStorage: boom } }));
});

test("every carried stem is still a product storage name (bb_<stem>), so the list cannot rot", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [join(here, ".."), join(here, "..", "..", "lib")];
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "node_modules" || n === ".next" || n === "(owner)") continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) files.push(p); } };
  for (const r of roots) walk(r);
  assert.ok(files.length > 300, `vacuity: walked only ${files.length} files`);
  const src = files.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
  for (const stem of CARRIED_STEMS) assert.ok(src.includes(`bb_${stem}`), `bb_${stem} is no longer a storage name in the product`);
});

test("layout.tsx runs the carry-forward FIRST in its first-paint script", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const layout = readFileSync(join(here, "..", "layout.tsx"), "utf8");
  const at = layout.indexOf("__html: `");
  assert.ok(at > 0, "the first-paint script is gone");
  assert.match(layout.slice(at, at + 80), /__html: `\s*\$\{carryLegacyStorageScript\(\)\}\s*\(function\(\)\{/);
  assert.match(layout, /\n\}\s*$/, "vacuity: layout.tsx read to its end");
});
