// The host's own settings writes reach stream-api at once. Run: node --test install/
//
// `blackbranch federation on|off` and `matrix ensure` write site.instance_config by SQL; stream-api
// re-reads only after its own writes, so the Admin Panel kept showing the old value until a restart.
// After every host write the host asks stream-api to re-read (POST /config/reload on the secret,
// from inside its container); a call that fails is a warning, never a failure of the verb.
// (Recorded room ids: install/matrix.test.mjs, "matrix ensure: new room ids".)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bb = readFileSync(path.join(here, "blackbranch"), "utf8");
const RELOAD_CALL = "compose exec -T stream-api node -e";
const WARNING = /stream-api did not re-read the settings: the Admin Panel shows the old value until it restarts \(sudo blackbranch restart stream-api\)/;

// The verb against the stand-in docker; `calls` is what this run asked of it, in order.
function go(h, extra, ...args) {
  const before = h.calls().length;
  const r = h.runWith({ BB_HEALTH_WAIT: "1", ...extra }, ...args);
  return { ...r, calls: h.calls().slice(before).split("\n").filter(Boolean) };
}

test("federation on: the SQL write, then stream-api asked to re-read matrix.federation — before the render", () => {
  const h = fakeHome();
  try {
    const r = go(h, {}, "federation", "on");
    assert.equal(r.status, 0, r.stderr);
    const write = r.calls.findIndex((c) => c.startsWith("compose exec -T postgres psql -U postgres -d stream -q -v ON_ERROR_STOP=1 -v k=matrix.federation -v v=true"));
    const reload = r.calls.findIndex((c) => c.startsWith(RELOAD_CALL));
    assert.ok(write >= 0, `the switch was written:\n${r.calls.join("\n")}`);
    assert.ok(reload > write, "stream-api is asked after the write, not before (or not at all)");
    assert.match(r.calls[reload], / matrix\.federation$/, "the key it re-reads is named");
    assert.doesNotMatch(r.stdout + r.stderr, WARNING);
    // Restart: the switch back off asks again.
    const off = go(h, {}, "federation", "off");
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.calls.filter((c) => c.startsWith(RELOAD_CALL)).length, 1);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("a re-read that fails is a warning with the way out; the verb still succeeds (retry: the next one is quiet)", () => {
  const h = fakeHome();
  try {
    writeFileSync(path.join(h.fake, "fail-1"), `${RELOAD_CALL}\nconnection refused\n`);
    let r = go(h, {}, "federation", "on");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNING);
    assert.match(r.stdout, /matrix\.federation set on; rendering/);
    rmSync(path.join(h.fake, "fail-1"));
    r = go(h, {}, "federation", "on");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, WARNING);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("stream-api not running: nothing is asked and nothing warned (it reads the settings when it starts)", () => {
  const h = fakeHome();
  try {
    // Only stream-api's container is stopped; the stand-in answers the other services as running.
    const docker = path.join(h.fake, "bin/docker");
    writeFileSync(docker, readFileSync(docker, "utf8").replace('case "$*" in\n', 'case "$*" in\n  "inspect -f {{.State.Status}} id-stream-api") echo exited ;;\n'), { mode: 0o755 });
    const r = go(h, {}, "federation", "on");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.some((c) => c.includes("-v k=matrix.federation")), "vacuity: the switch was written");
    assert.equal(r.calls.filter((c) => c.startsWith(RELOAD_CALL)).length, 0);
    assert.doesNotMatch(r.stdout + r.stderr, WARNING);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// One real execution of the script the host runs inside stream-api's container, against a stand-in
// stream-api: the bearer secret from the container's environment, the keys from its arguments.
async function runReload(status, keys) {
  const got = [];
  const srv = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    got.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body });
    res.writeHead(status, { "content-type": "application/json" }); res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const js = bb.match(/\nCONFIG_RELOAD_JS='([^'\n]+)'\n/)?.[1];
    assert.ok(js, "CONFIG_RELOAD_JS found");
    assert.ok(js.includes("http://127.0.0.1:3001/config/reload"), "it asks stream-api's own port, on the loopback");
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, ["-e", js.replace("127.0.0.1:3001", `127.0.0.1:${srv.address().port}`), ...keys],
        { env: { PATH: process.env.PATH, STREAM_API_SECRET: "s3cret-for-test" }, stdio: "ignore" });
      p.on("close", resolve);
    });
    return { code, got };
  } finally { srv.close(); }
}

test("the script the host runs: POST /config/reload with the secret and the keys; any answer but 2xx exits non-zero", async () => {
  let r = await runReload(200, ["matrix.rooms.hub", "matrix.rooms.general"]);
  assert.equal(r.code, 0);
  assert.equal(r.got.length, 1);
  assert.equal(r.got[0].method, "POST"); assert.equal(r.got[0].url, "/config/reload");
  assert.equal(r.got[0].auth, "Bearer s3cret-for-test");
  assert.match(r.got[0].type, /^application\/json/);
  assert.deepEqual(JSON.parse(r.got[0].body), { keys: ["matrix.rooms.hub", "matrix.rooms.general"] });
  r = await runReload(500, ["matrix.federation"]);
  assert.equal(r.code, 1);
  r = await runReload(401, ["matrix.federation"]);
  assert.equal(r.code, 1);
});

test("every host write of a setting asks stream-api to re-read (vacuity anchor: the end of config_set)", () => {
  const fn = bb.match(/\nconfig_set\(\) \{[^\n]*\n([\s\S]*?)\n\}\n/)?.[1];
  assert.ok(fn, "config_set found");
  assert.match(fn, /\n {2}config_reload "\$1"$/, "config_set ends by asking stream-api to re-read the key it wrote");
});
