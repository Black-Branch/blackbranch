// Run: node --test app/lib/encryptionMemory.test.ts
//
// The bug this fixes is not a missing indicator, it is a WRONG one: before the
// Matrix client is ready there is no verdict, and the account card renders
// anything that is not "green" as "Encryption needs setup". Users who had
// already set encryption up were told to do it again on every load.
//
// So the tests that matter are about what happens when we do NOT know.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import {
  readRememberedVerdict, rememberVerdict, forgetAllVerdicts, effectiveVerdict,
} from "./encryptionMemory.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal localStorage — the real one is not present under `node --test`. */
function installStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    },
  };
  return m;
}

const ALICE = "@alice:site.test";
const BOB = "@bob:site.test";

let store: Map<string, string>;
beforeEach(() => { store = installStorage(); });

test("a verdict survives the round trip", () => {
  rememberVerdict(ALICE, "green");
  assert.equal(readRememberedVerdict(ALICE), "green");
});

test("the memory is keyed per USER", () => {
  // A shared browser must not show one account's verdict for another's, and
  // "encryption ready" is exactly the claim you don't want to inherit.
  rememberVerdict(ALICE, "green");
  assert.equal(readRememberedVerdict(BOB), null, "Bob inherited Alice's verdict");
});

test("null is never stored — it would erase a real answer", () => {
  rememberVerdict(ALICE, "green");
  rememberVerdict(ALICE, null);
  assert.equal(readRememberedVerdict(ALICE), "green", "an unknown verdict overwrote a known one");
});

test("garbage in storage reads as unknown, not as a verdict", () => {
  store.set("bb_enc-verdict:" + ALICE, "definitely-fine");
  assert.equal(readRememberedVerdict(ALICE), null);
});

test("no user id means no read and no write", () => {
  rememberVerdict(null, "green");
  assert.equal(store.size, 0, "a verdict was stored under a missing user id");
  assert.equal(readRememberedVerdict(null), null);
});

test("sign-out forgets EVERY user's verdict, not just the current one", () => {
  // Sign-out wipes the crypto stores and the device id, so no verdict recorded
  // here still describes anything that exists. A per-user delete would leave the
  // previous account's "green" behind for whoever signs in next.
  rememberVerdict(ALICE, "green");
  rememberVerdict(BOB, "red");
  forgetAllVerdicts();
  assert.equal(store.size, 0, `verdicts survived sign-out: ${[...store.keys()].join(", ")}`);
});

test("clearing many entries does not skip any (removeItem reindexes)", () => {
  for (let i = 0; i < 12; i++) rememberVerdict(`@u${i}:site.test`, "green");
  assert.equal(store.size, 12);
  forgetAllVerdicts();
  assert.equal(store.size, 0, "a mid-scan delete skipped entries");
});

test("sign-out actually calls it", () => {
  const src = stripComments(readFileSync(join(here, "./signOutEverything.ts"), "utf8"));
  assert.match(
    src, /forgetAllVerdicts\(\)/,
    "signOutEverything leaves the cached verdict behind — it outlives the crypto " +
    "stores and device id it describes"
  );
});

test("a computed verdict always beats the remembered one", () => {
  // One character away from backwards, and backwards is the dangerous
  // direction: a remembered "green" surviving a computed "red" means the app
  // keeps telling someone their encryption is ready after learning it is not.
  assert.equal(effectiveVerdict("red", "green"), "red", "the cache overrode a live verdict");
  assert.equal(effectiveVerdict("green", "red"), "green");
  // …and it still fills the gap, which is the entire reason it exists.
  assert.equal(effectiveVerdict(null, "green"), "green");
  assert.equal(effectiveVerdict(null, null), null);
});
