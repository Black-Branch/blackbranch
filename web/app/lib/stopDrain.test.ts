// O01: a stop must finish while the site is busy. Run: node --test app/lib/stopDrain.test.ts
//
// Why real processes and real sockets: the defect lives between Node's http server and the proxy in
// front of it, and no source scan can see it. Next's stop calls server.close() and waits; Node keeps
// answering `Connection: keep-alive` on a socket that was busy at that moment and goes on serving
// new requests on it, so close() completes only after a 5 s pause on that socket. cloudflared
// carries the whole site over a few such sockets at ~1 request a second, so on 2026-10-20, 10-23 and
// 10-24 the stopping process served ~100 more requests and was SIGKILLed at 90 s. Each test starts
// stopDrain.fixture.ts (Next's production stop handler, verbatim in behaviour), drives it the way
// cloudflared does, sends a real SIGTERM and times the exit.
//
// The child's environment is built here: nothing from this shell (no database address) reaches it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = join(import.meta.dirname, "stopDrain.fixture.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A test that fails mid-stop must not leave its child running (and the runner open behind it).
const children = new Set<ChildProcess>();
after(() => { for (const c of children) c.kill("SIGKILL"); });

type Child = { proc: ChildProcess; port: number; exited: Promise<{ code: number | null; at: number }>; stderr: () => string };

async function start(opts: { drain?: boolean; deadlineMs?: number; port?: number } = {}): Promise<Child> {
  const args = [opts.drain ? "drain" : "none", String(opts.deadlineMs ?? 10_000), String(opts.port ?? 0)];
  const proc = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", FIXTURE, ...args], {
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(proc);
  proc.on("exit", () => children.delete(proc));
  let err = "";
  proc.stderr!.on("data", (d) => { err += String(d); });
  const exited = new Promise<{ code: number | null; at: number }>((r) => proc.on("exit", (code) => r({ code, at: Date.now() })));
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (d) => { out += String(d); const m = /PORT (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    void exited.then(() => reject(new Error(`fixture exited before listening: ${err}`)));
  });
  return { proc, port, exited, stderr: () => err };
}

type Reply = { status: number; connection: string; body: string };
function get(port: number, path: string, agent: http.Agent): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, agent }, (r) => {
      let body = "";
      r.on("data", (d) => { body += String(d); });
      r.on("end", () => resolve({ status: r.statusCode ?? 0, connection: String(r.headers.connection), body }));
    }).on("error", reject);
  });
}

/** cloudflared's shape: ONE keep-alive socket; a request is in flight when SIGTERM lands, and the
 *  socket is reused every 300 ms after it (well inside Node's 5 s keep-alive timeout). Resolves with
 *  the in-flight request's reply and how many requests the stopping process served after it. */
async function busyStop(c: Child, opts: { signals?: number; held?: string } = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await get(c.port, "/", agent);                      // the socket exists and is reused below
  const held = get(c.port, opts.held ?? "/slow", agent); // in flight at the signal
  await sleep(100);
  const signalledAt = Date.now();
  for (let i = 0; i < (opts.signals ?? 1); i++) { c.proc.kill("SIGTERM"); await sleep(50); }
  const heldReply = await held;
  let servedAfter = 0;
  let gone = false;
  void c.exited.then(() => { gone = true; });
  while (!gone && Date.now() - signalledAt < 4_000) {
    await sleep(300);
    if (gone) break;
    try { await get(c.port, "/", agent); servedAfter++; } catch { /* refused: the listener is closed */ }
  }
  agent.destroy();
  return { signalledAt, heldReply, servedAfter, gone };
}

test("the defect, reproduced: without the drain a socket busy at SIGTERM and reused every 300 ms holds Next's stop open", { timeout: 20_000 }, async () => {
  const c = await start({});
  const r = await busyStop(c);
  assert.equal(r.gone, false, "still running 4 s after SIGTERM — the stop is held");
  assert.equal(r.heldReply.connection, "keep-alive", "the busy socket was kept alive after close()");
  assert.ok(r.servedAfter >= 5, `the stopping process kept serving on the old socket (${r.servedAfter})`);
  c.proc.kill("SIGKILL");
  await c.exited;
});

test("with the drain the same stop finishes as soon as the in-flight request has answered", { timeout: 20_000 }, async () => {
  const c = await start({ drain: true });
  const r = await busyStop(c);
  const { code, at } = await c.exited;
  assert.equal(code, 143, "exits the way Next does (143), which the units count as a clean stop");
  assert.ok(at - r.signalledAt < 2_000, `stopped in ${at - r.signalledAt} ms`);
  assert.equal(r.heldReply.status, 200, "the request in flight at the signal is answered, not cut");
  assert.equal(r.heldReply.body, "slow");
  assert.equal(r.heldReply.connection, "close", "and tells the proxy not to reuse the socket");
  assert.equal(r.servedAfter, 0, "nothing more is served by the stopping process");
  assert.doesNotMatch(c.stderr(), /still open/, "a clean drain is not the deadline");
});

test("a streamed page whose headers were already sent at the signal still lets go of its socket", { timeout: 20_000 }, async () => {
  const c = await start({ drain: true });
  const r = await busyStop(c, { held: "/streamed" });
  const { code, at } = await c.exited;
  assert.equal(code, 143);
  assert.ok(at - r.signalledAt < 2_000, `stopped in ${at - r.signalledAt} ms`);
  assert.equal(r.heldReply.body, "<p>firstrest</p>", "the page arrived whole");
  assert.equal(r.servedAfter, 0, "nothing more is served by the stopping process");
});

test("an active response that never ends (an event stream) cannot hold the stop past the deadline; the log names it without its query", { timeout: 20_000 }, async () => {
  const c = await start({ drain: true, deadlineMs: 1000 });
  const idle = new http.Agent({ keepAlive: true });
  await get(c.port, "/", idle);                       // an idle keep-alive socket: close() ends it at once
  const stream = new http.Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: c.port, path: "/stream?token=s3cr3t", agent: stream }, (res) => {
      res.once("data", () => resolve());
      res.on("error", () => {});
    }).on("error", reject);
  });
  const signalledAt = Date.now();
  c.proc.kill("SIGTERM");
  const { code, at } = await c.exited;
  idle.destroy(); stream.destroy();
  assert.equal(code, 143);
  assert.ok(at - signalledAt >= 900 && at - signalledAt < 3_000, `stopped at the deadline (${at - signalledAt} ms)`);
  assert.match(c.stderr(), /\[stop\] 1 request\(s\) still open 1 s after the stop signal: GET \/stream/);
  assert.doesNotMatch(c.stderr(), /s3cr3t/, "a query string never reaches the journal");
});

test("restart: the next process takes the same port at once and stops just as fast (systemd's restart, twice)", { timeout: 30_000 }, async () => {
  const first = await start({ drain: true });
  const r1 = await busyStop(first);
  const e1 = await first.exited;
  assert.ok(e1.at - r1.signalledAt < 2_000, `first stop ${e1.at - r1.signalledAt} ms`);
  const second = await start({ drain: true, port: first.port });
  assert.equal(second.port, first.port, "the port was released, not held by a lingering socket");
  const r2 = await busyStop(second);
  const e2 = await second.exited;
  assert.equal(e2.code, 143);
  assert.ok(e2.at - r2.signalledAt < 2_000, `second stop ${e2.at - r2.signalledAt} ms`);
  assert.equal(r2.heldReply.status, 200);
});

test("retry: a repeated SIGTERM during the drain neither cuts the request in flight nor logs or exits twice", { timeout: 20_000 }, async () => {
  const c = await start({ drain: true });
  const r = await busyStop(c, { signals: 3 });
  const { code, at } = await c.exited;
  assert.equal(code, 143);
  assert.ok(at - r.signalledAt < 2_000, `stopped in ${at - r.signalledAt} ms`);
  assert.equal(r.heldReply.status, 200);
  assert.equal(r.heldReply.body, "slow");
  assert.doesNotMatch(c.stderr(), /\[stop\]/, "the deadline never fired: one clean drain, not a cut");
});

test("wiring: the running server installs the drain at boot", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "instrumentation.ts"), "utf8");
  assert.match(src, /const \{ installStopDrain \} = await import\("@\/app\/lib\/stopDrain"\);\n\s+installStopDrain\(\);/);
  assert.match(src.trimEnd(), /\n\}$/, "read to the end of instrumentation.ts");
});
