// Mod allow/block overrides must survive a web restart.
//
// In the compiled Next bundle `instrumentation.ts` gets its OWN copy of
// `blacklist.ts` and `linkGate.ts`, so a 60 s refresher started there keeps a
// copy up to date that chat never reads. Only the mod route's own
// `await refreshBlocklistOverrides()` reaches the live copy, so a re-grade
// would work until the next restart and then silently revert to the shipped
// grading. The link gate (host rules + posture) has the same shape.
//
// So the property under test is: TWO SEPARATELY-LOADED INSTANCES of each module
// share one store. A query string on the import URL gives node a second module
// instance, which is exactly what a second bundle copy is.
//
// Run: node --test app/lib/overrideStoreShared.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

type BlacklistModule = typeof import("./blacklist.ts");
type LinkGateModule = typeof import("./linkGate.ts");

const load = async <T>(file: string, copy: string): Promise<T> =>
  (await import(`./${file}?copy=${copy}`)) as T;

// A made-up term, so this test neither depends on nor names anything in the real list.
const TERM = "zqxoverridecanary";

test("a word override installed by one module copy is what another copy classifies with", async () => {
  const refresher = await load<BlacklistModule>("blacklist.ts", "refresher");
  const chat = await load<BlacklistModule>("blacklist.ts", "chat");
  assert.notEqual(refresher, chat, "precondition: two distinct module instances");
  assert.equal(chat.classify(TERM).action, "allow", "precondition: unlisted");

  refresher.setOverrides([{ term: TERM, severity: 3 }]);
  try {
    assert.equal(chat.classify(TERM).action, "hold",
      "the override reached only the copy that installed it — chat reads a different store");
  } finally {
    refresher.setOverrides([]);
  }
  assert.equal(chat.classify(TERM).action, "allow", "clearing did not reach the other copy");
});

test("link-gate rules and posture installed by one copy are what another copy gates with", async () => {
  const refresher = await load<LinkGateModule>("linkGate.ts", "refresher");
  const chat = await load<LinkGateModule>("linkGate.ts", "chat");
  assert.notEqual(refresher, chat, "precondition: two distinct module instances");

  const rules = [{ host: "canary.example", severity: 3 as const }];
  refresher.setHostRules(rules);
  refresher.setLinkPosture("hold");
  try {
    assert.equal(chat.currentPosture(), "hold", "posture reached only the copy that set it");
    assert.deepEqual(chat.currentHostRules(), rules, "host rules reached only the copy that set them");
    assert.equal(chat.gate("see https://canary.example/x").action, "hold");
  } finally {
    refresher.setHostRules([]);
    refresher.setLinkPosture("off");
  }
  assert.equal(chat.currentPosture(), "off", "resetting did not reach the other copy");
});

// ── The same property at the source, so a refactor back to `let` goes red ───

for (const [file, key, tailAnchor] of [
  ["blacklist.ts", "bb.blocklist", "export function classify("],
  ["linkGate.ts", "bb.linkGate", "export function gate("],
  ["blocklistOverrides.ts", "bb.blocklistOverrides", "export function startBlocklistOverrideRefresh("],
] as const) {
  test(`${file} keeps its live state on globalThis, not in module scope`, () => {
    const code = stripComments(readFileSync(join(HERE, file), "utf8"));
    // Vacuity anchor on the END of the file: the negative assertion below goes
    // green over a short read, so prove the last function was read first.
    assert.ok(code.includes(tailAnchor), `${file} was not read to its end`);
    assert.match(code, new RegExp(`globalThis[\\s\\S]*Symbol\\.for\\("${key.replace(".", "\\.")}"\\)|Symbol\\.for\\("${key.replace(".", "\\.")}"\\)[\\s\\S]*globalThis`),
      `${file} no longer keys its store on globalThis under Symbol.for("${key}")`);
    assert.doesNotMatch(code, /^let\s/m,
      `${file} has module-level mutable state again — each bundle copy would get its own`);
  });
}
