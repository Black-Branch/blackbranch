// The daily client-error prune (clientErrorPrune.ts): the legal page promises error reports go
// after CLIENT_ERROR_RETENTION_DAYS, and the route's own prune runs only on every 50th report per
// process — a quiet install never pruned. A timer from boot does it once a day, first a minute after
// boot; a failure is logged, never thrown.
// Run: env -u DATABASE_URL node --test app/lib/clientErrorPrune.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startClientErrorPrune } from "./clientErrorPrune.ts";
import { CLIENT_ERROR_PRUNE_SQL } from "./clientErrorRetention.ts";
import { stripComments } from "./testSource.ts";

function fakeTimers() {
  const timeouts: { ms: number; fn: () => void }[] = [];
  const intervals: { ms: number; fn: () => void }[] = [];
  return {
    timeouts, intervals,
    setTimeout: (fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return { unref() {} }; },
    setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return { unref() {} }; },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test("first prune a minute after boot, then once every 24 hours, with the retention's own statement", async () => {
  const t = fakeTimers();
  const ran: string[] = [];
  const started = startClientErrorPrune({ ...t, query: async (sql) => { ran.push(sql); return { rowCount: 3 }; }, log: () => {} });
  assert.equal(started, true);
  assert.deepEqual(t.timeouts.map((x) => x.ms), [60_000]);
  assert.equal(ran.length, 0, "pruned at boot, before the minute");
  t.timeouts[0]!.fn();
  await tick();
  assert.deepEqual(ran, [CLIENT_ERROR_PRUNE_SQL]);
  assert.deepEqual(t.intervals.map((x) => x.ms), [24 * 60 * 60_000]);
  t.intervals[0]!.fn();
  await tick();
  assert.equal(ran.length, 2);
  assert.equal(startClientErrorPrune({ ...t, query: async () => ({ rowCount: 0 }), log: () => {} }), false, "a second start in one process");
});

test("a failed prune is logged, never thrown, and the next day runs again", async () => {
  const t = fakeTimers();
  const logged: string[] = [];
  let calls = 0;
  startClientErrorPrune({ ...t, query: async () => { calls++; throw new Error("db down"); }, log: (m) => logged.push(m) }, true);
  t.timeouts[0]!.fn();
  await tick();
  t.intervals[0]!.fn();
  await tick();
  assert.equal(calls, 2);
  assert.equal(logged.length, 2);
  assert.match(logged[0]!, /db down/);
});

test("boot starts it", () => {
  const raw = readFileSync(join(process.cwd(), "instrumentation.ts"), "utf8");
  assert.match(raw, /\n\}\n?$/, "END not read");
  const src = stripComments(raw);
  assert.match(src, /const \{ startClientErrorPrune \} = await import\("@\/app\/lib\/clientErrorPrune"\);\s*startClientErrorPrune\(\);/);
});
