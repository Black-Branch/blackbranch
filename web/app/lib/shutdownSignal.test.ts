// Contract 5 (web half): a request that waits ends within moments of SIGTERM, so the standalone
// server's shutdown — which waits for every request in flight — fits inside Docker's grace.
// The running proof (build, start, hold a help-desk question, SIGTERM, time the exit, twice) is a
// manual check; this pins the mechanism and its wiring.
// Run: node --test app/lib/shutdownSignal.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { shutdownSignal } from "./shutdownSignal.ts";

test("SIGTERM aborts the one shared signal; later callers get the same, already-aborted signal", () => {
  delete (globalThis as { __shutdownController?: unknown }).__shutdownController;
  const proc = new EventEmitter();
  const s = shutdownSignal(proc as unknown as NodeJS.Process);
  assert.equal(s.aborted, false);
  assert.equal(proc.listenerCount("SIGTERM"), 1, "listens; does not replace Next's handler");
  proc.emit("SIGTERM");
  assert.equal(s.aborted, true);
  assert.match(String((s.reason as Error).message), /SIGTERM/);
  assert.equal(shutdownSignal(proc as unknown as NodeJS.Process), s, "one signal per process");
  assert.equal(proc.listenerCount("SIGTERM"), 0, "registered once");
  delete (globalThis as { __shutdownController?: unknown }).__shutdownController;
});

test("a held wait combined with it ends at the signal, not at its own deadline", async () => {
  delete (globalThis as { __shutdownController?: unknown }).__shutdownController;
  const proc = new EventEmitter();
  const held = AbortSignal.any([AbortSignal.timeout(35_000), shutdownSignal(proc as unknown as NodeJS.Process)]);
  const t0 = Date.now();
  setTimeout(() => proc.emit("SIGTERM"), 20);
  await new Promise<void>((r) => held.addEventListener("abort", () => r(), { once: true }));
  assert.ok(Date.now() - t0 < 1_000);
  delete (globalThis as { __shutdownController?: unknown }).__shutdownController;
});

test("wiring: the help desk's long-poll waits on the shutdown signal too", () => {
  const src = readFileSync(new URL("../api/support/message/route.ts", import.meta.url), "utf8");
  assert.match(src, /signal: AbortSignal\.any\(\[AbortSignal\.timeout\(35_000\), shutdownSignal\(\)\]\),/);
  assert.match(src.trimEnd(), /\}$/);
});
