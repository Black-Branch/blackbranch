// The Matrix media proxy's headers as a browser RECEIVES them, from a running server. Run:
//   node --test app/lib/mediaHeadersDelivered.test.ts
//
// Why a running server: the sandbox CSP that contains a hostile upload is only real if it is the
// one that arrives. Next keeps the FIRST Content-Security-Policy set on a response, so a site-wide
// policy from proxy.ts or next.config.ts reaching the media path first silently replaces the
// route's sandbox — which happened (both did). app/lib/mediaHeaders.test.ts runs the allowlist and
// app/lib/mediaProxyCsp.test.ts reads proxy.ts and next.config.ts; neither can see what Next
// actually sends. This starts the site (`next dev`: no build, no database, no stream-api — the
// site's boot tolerates both being down) in front of a stand-in homeserver that serves an HTML
// upload claiming to be text/html with its own permissive CSP, and asks for it the way a viewer's
// browser would.
//
// The child gets a minimal environment of its own: nothing from this shell (no database address)
// reaches it. Its database and stream-api addresses are a closed local port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MEDIA_CSP } from "./mediaHeaders.ts";
import { resolveInstallValues } from "./installValuesServer.ts";

const webDir = join(import.meta.dirname, "..", "..");
const HTML = "<script>document.title='ran'</script>";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f40000000049454e44ae426082", "hex");

const portOf = (s: { address(): unknown }) => (s.address() as AddressInfo).port;
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = portOf(s); s.close(() => resolve(p)); });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a running site delivers the media sandbox, nosniff and a download for an HTML upload; an image stays inline under the same sandbox", { timeout: 240_000 }, async () => {
  const asked: string[] = [];
  const hs = createServer((req, res) => {
    asked.push(req.url ?? "");
    if (req.url === "/_matrix/media/v3/download/hs.test/evilhtml/evil.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "script-src *", "Content-Disposition": "inline" });
      res.end(HTML); return;
    }
    if (req.url === "/_matrix/media/v3/download/hs.test/apng") {
      res.writeHead(200, { "Content-Type": "image/png" }); res.end(PNG); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => hs.listen(0, "127.0.0.1", r));
  const hsOrigin = `http://127.0.0.1:${portOf(hs)}`;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const closed = "127.0.0.1:9"; // nothing listens there: the database and stream-api are down
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development" as const, NEXT_TELEMETRY_DISABLED: "1",
    SITE_NAME: "Casey Test", SITE_ORIGIN: origin, SITE_API_ORIGIN: `http://${closed}`, SITE_API_WS_ORIGIN: `ws://${closed}`,
    MATRIX_SERVER_NAME: "hs.test", MATRIX_HOMESERVER_URL: hsOrigin, MATRIX_OAUTH_ISSUER: `${hsOrigin}/`, MATRIX_OAUTH_CLIENT_ID: "01HTESTCLIENT0000000000000",
    STREAM_API_URL: `http://${closed}`, DATABASE_URL: `postgres://nobody:nothing@${closed}/none`, AUTH_SECRET: randomBytes(32).toString("hex"),
  };
  // The install values, published in the child's STARTING environment too. The boot publishes them
  // into process.env (instrumentation.ts), but the dev server can put process.env back to the
  // environment it started with (@next/env loadEnvConfig → replaceProcessEnv, run again when its
  // watcher reloads the env — seen on the first start after the source tree changed), which deletes
  // a key the boot added: the route then had no homeserver address and answered 404 for the whole
  // wait, the stand-in never asked. `next start` does not reload; this is the dev server's alone.
  const published = resolveInstallValues(env);
  assert.deepEqual(published.problems, [], "the test's install values are complete");
  Object.assign(env, { INSTALL_VALUES: JSON.stringify(published.values) });
  const child = spawn(process.execPath, [join(webDir, "node_modules/next/dist/bin/next"), "dev", "-p", String(port), "-H", "127.0.0.1"],
    { cwd: webDir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  // The start of the server's log (its boot) and its end: the middle is the probe's repeated lines.
  const logView = () => (log.length <= 4000 ? log : `${log.slice(0, 3000)}\n…\n${log.slice(-1000)}`);
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  let gone = false;
  const exited = new Promise<void>((r) => child.on("exit", () => { gone = true; r(); }));
  try {
    // Started, exited, or three minutes — polled, so no timer outlives the test. "Started" is the
    // boot's own line (instrumentation.ts), printed once the install values are published: the dev
    // server says "Ready" before that, and a request in between finds no homeserver address.
    const deadline = Date.now() + 180_000;
    const started = () => /Ready in/.test(log) && /\[boot\] sign-in URL /.test(log);
    while (!started() && !gone && Date.now() < deadline) await sleep(250);
    assert.ok(started() && !gone, `the site did not start:\n${log.slice(-3000)}`);
    // Second gate: the route itself answers. After the boot line the dev server can still be
    // compiling the route, and a request then gets a 404 (seen once in three full-suite runs). Probe
    // the image (a body the stand-in always serves) until it is not a 404 or a refused connection,
    // within the same deadline; the assertions below then make fresh requests.
    let probe = 0;
    while (!gone && Date.now() < deadline) {
      const r = await fetch(`${origin}/api/matrix/media/download/hs.test/apng`, { redirect: "manual" }).catch(() => null);
      probe = r?.status ?? 0;
      await r?.arrayBuffer().catch(() => null);
      if (probe !== 0 && probe !== 404) break;
      await sleep(500);
    }
    assert.equal(probe, 200, `the media route never answered (last status ${probe}; the homeserver was asked for ${JSON.stringify(asked.slice(0, 5))}):\n${logView()}`);

    const html = await fetch(`${origin}/api/matrix/media/download/hs.test/evilhtml/evil.html`, { redirect: "manual" });
    assert.equal(html.status, 200, log.slice(-3000));
    assert.ok(asked.includes("/_matrix/media/v3/download/hs.test/evilhtml/evil.html"), "the body came from the stand-in homeserver");
    assert.equal(html.headers.get("content-security-policy"), MEDIA_CSP, "the route's sandbox arrives — not the site policy, not the uploader's");
    assert.equal(html.headers.get("content-type"), "application/octet-stream", "a document type is never reflected");
    assert.match(html.headers.get("content-disposition") ?? "", /^attachment\b/);
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
    assert.equal(html.headers.get("access-control-allow-origin"), origin);
    assert.equal(await html.text(), HTML, "the bytes are relayed unchanged — only how a browser may treat them changes");

    const png = await fetch(`${origin}/api/matrix/media/download/hs.test/apng`, { redirect: "manual" });
    assert.equal(png.status, 200);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.equal(png.headers.get("content-disposition"), null, "an image displays inline");
    assert.equal(png.headers.get("content-security-policy"), MEDIA_CSP);
    assert.equal(png.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);
  } finally {
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 20 && !gone; i++) await sleep(250);
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
    await exited;
    hs.close();
  }
});
