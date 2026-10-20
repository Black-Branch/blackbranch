// The radio-off install: a fallback whose module is switched off is not offered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fallbacksOn } from "./fallbackModules.ts";
import { playerFallbacks } from "./absent/player.ts";

const web = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(web, p), "utf8");

test("a fallback whose module is off is dropped; one with no module always stays", () => {
  const all = [{ id: "radio", module: "radio" }, { id: "loop" }];
  assert.deepEqual(fallbacksOn(all, ["radio"]).map((f) => f.id), ["loop"]);
  assert.deepEqual(fallbacksOn(all, []).map((f) => f.id), ["radio", "loop"]);
  assert.deepEqual(fallbacksOn(all, ["obs"]).map((f) => f.id), ["radio", "loop"]);
});

test("without an owner folder there are no fallbacks to filter", () => {
  assert.deepEqual(fallbacksOn(playerFallbacks, []), []);
});

test("the player reads the switched-on fallbacks from one context, never the build-time list", () => {
  for (const f of ["app/components/StreamView.tsx", "app/components/StreamEmbedBar.tsx", "app/components/StreamMetaBar.tsx", "app/features/player/StreamPlayerArea.tsx"]) {
    const src = read(f);
    assert.ok(/(\}|\);)$/.test(src.trimEnd()) && src.length > 2000, `${f} read to its end`);
    assert.doesNotMatch(src, /FALLBACK_IDS/, `${f} still reads the build-time fallback list`);
  }
  assert.match(read("app/components/StreamView.tsx"), /<PlayerFallbacksProvider value=\{fallbacks\}>/);
});

test("the home page passes the modules not shown, by the module rule", () => {
  const page = read("app/(main)/page.tsx");
  assert.match(page, /offModules=\{off\}/);
  assert.match(page, /modulesOff\(\)/);
});
