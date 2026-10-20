// The install bundle's own checks. Run: node --test install/
// CI runs them in the `install` job, where Docker and shellcheck exist; there a missing tool is a
// FAILURE, never a skip (CI=true). Locally a missing tool is a visible skip.
//
// What they hold: the Compose file renders in every profile; every service is pinned (a tagged
// image, or built here under a local name); nothing but caddy publishes a port, and only through
// compose.public.yaml; the profiles are the expected ones; the box never builds the site at
// run time (no web-build, one web image) and web gets exactly the schema's install keys;
// `blackbranch set` can change only display values, and restarts rather than rebuilds; .env.example, install.sh's .env and the Compose file agree on every key; the
// router renders for each TLS mode; the scripts pass bash -n and shellcheck; the throwaway
// install uses the same migration runner; the setup link is printed, hashed for the site,
// kept root-only and retired once an admin exists; the setup pages' values reach .env only after
// the host checks them again; in direct and lab mode every container reaches the site's names at
// caddy, and in lab mode the apps trust caddy's root certificate (never its key).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync, readdirSync, symlinkSync, chmodSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTANCE_KEYS } from "../config/instance-schema.mjs";
import { renderHome, runRender, fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const CI = process.env.CI === "true";

const has = (cmd, args = ["--version"]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const dockerCompose = has("docker", ["compose", "version"]);
const shellcheck = has("shellcheck");
const needs = (ok, what) => (ok ? false : CI ? assert.fail(`${what} is required in CI`) : `${what} not installed`);

const SCRIPTS = ["install.sh", "blackbranch", "migrate.sh", "postgres/init-databases.sh", "matrix/render.sh", "backup/run.sh",
  "release-copy.sh", "migrations/lib.sh", ...readdirSync(path.join(here, "migrations")).filter((f) => /^\d{3}-.*\.sh$/.test(f)).map((f) => `migrations/${f}`)];
// Each scanned file's LAST meaningful line: a truncated or emptied file must fail, not pass.
const ENDS = {
  "compose.yaml": /\n {2}bridge-data:\n$/,
  "compose.public.yaml": /\n {10}- matrix\.\$\{BB_DOMAIN:\?\}\n$/,
  "compose.lab.yaml": /\n {6}- \.\/lab-ca:\/lab-ca:ro\n$/,
  "install.sh": /\nexit 0\n$/,
  "blackbranch": /\n {2}\*\) die "unknown command[^\n]*\nesac\n$/,
  "migrate.sh": /now at v\$head"; fi\n$/,
  ".env.example": /\nSETUP_TOKEN_HASH=\n$/,
  "Dockerfile": /\nUSER node\nEXPOSE 3000\nCMD \["node", "server.js"\]\n$/,
  "matrix/render.sh": /\n\thandle \{\n\t\trespond 404\n\t\}\nEOF\n\}\n$/,
  "matrix/bootstrap.mjs": /process\.stdout\.write\(`\$\{JSON\.stringify\(\{ hub, general, created \}\)\}\\n`\);\n$/,
};

test("vacuity anchors: every scanned file ends where it should", () => {
  for (const [f, end] of Object.entries(ENDS)) assert.match(read(f), end, `${f} does not end as expected`);
});

function composeConfig(envFile, profiles = [], withPublic = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-compose-"));
  try {
    const files = [path.join(here, "compose.yaml"), ...(withPublic ? [path.join(here, "compose.public.yaml")] : [])];
    const args = ["compose", ...files.flatMap((f) => ["-f", f]),
      "--project-directory", dir, "--env-file", envFile, ...profiles.flatMap((p) => ["--profile", p]), "config", "--format", "json"];
    return JSON.parse(execFileSync("docker", args, { encoding: "utf8", env: { ...process.env, COMPOSE_PROFILES: "", COMPOSE_FILE: "" } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the Compose file renders with every profile, and every service is pinned", (t) => {
  const skip = needs(dockerCompose, "docker compose"); if (skip) return t.skip(skip);
  const cfg = composeConfig(path.join(here, ".env.example"), ["tunnel", "matrix", "discord"]);
  const names = Object.keys(cfg.services).sort();
  assert.deepEqual(names, ["caddy", "cloudflared", "mas", "mautrix-discord", "migrate", "postgres", "stream-api", "stream-ingest", "synapse", "web"]);
  for (const [name, s] of Object.entries(cfg.services)) {
    assert.ok(s.image, `${name}: no image`);
    if (s.build) {
      assert.match(s.image, /^blackbranch\/[a-z-]+:local$/, `${name}: a built image carries the local name`);
      assert.equal(s.build.dockerfile, "install/Dockerfile", name);
    } else {
      assert.match(s.image, /^[a-z0-9./-]+:[A-Za-z0-9._-]+$/, `${name}: image must name a tag`);
      assert.doesNotMatch(s.image, /:(latest|stable|main)$/, `${name}: a moving tag is not a pin`);
    }
    assert.equal(s.env_file, undefined, `${name}: no env_file — each service names its own variables`);
  }
});

test("only caddy publishes ports, only via compose.public.yaml; tunnel mode publishes nothing", (t) => {
  const skip = needs(dockerCompose, "docker compose"); if (skip) return t.skip(skip);
  const cfg = composeConfig(path.join(here, ".env.example"), ["tunnel", "matrix", "discord"]);
  for (const [name, s] of Object.entries(cfg.services)) {
    if (name === "caddy") assert.deepEqual(s.ports.map((p) => `${p.published}/${p.protocol}`).sort(), ["443/tcp", "443/udp", "80/tcp"]);
    else assert.equal(s.ports, undefined, `${name} publishes a port`);
  }
  assert.doesNotMatch(read("compose.yaml"), /^\s*ports:/m, "compose.yaml itself publishes nothing");
});

test("the box never builds the site at run time — no web-build, no build volume; the install's own files are mounted", (t) => {
  const skip = needs(dockerCompose, "docker compose"); if (skip) return t.skip(skip);
  const src = read("compose.yaml");
  assert.doesNotMatch(src, /web-build|web-builder|BB_BUILD_ID|\/build\/current/, "nothing of the box's own web build is left");
  const cfg = composeConfig(path.join(here, ".env.example"), ["tunnel", "matrix", "discord", "backup"]);
  assert.equal(cfg.services["web-build"], undefined);
  assert.equal(cfg.volumes["web-build"], undefined);
  const vols = cfg.services.web.volumes.map((v) => `${v.source?.replace(/^.*\//, "./")}:${v.target}${v.read_only ? ":ro" : ""}`);
  assert.ok(vols.includes("./site-files:/app/public/site-files:ro"), `web mounts the install's own files read-only (${vols.join(", ")})`);
  assert.ok(vols.includes("web-cache:/app/.next/cache"), "the server's cache is its own volume");
  assert.ok(!vols.some((v) => /:\/build\b/.test(v)), "no build volume");
  // A checkout builds the image here (the same Dockerfile target a release's image is made from).
  assert.equal(cfg.services.web.build.target, "web");
  const docker = read("Dockerfile");
  assert.doesNotMatch(docker, /web-builder|web-build\.sh|\/build\/current/);
  assert.match(docker, /\nFROM base AS web-build\n[\s\S]*RUN npx --no-install next build[\s\S]*\nFROM base AS web\n/, "the image is built once, with nothing install-specific");
});

test("profiles: tunnel and discord are the only optional parts — the homeserver is core", () => {
  const src = read("compose.yaml");
  const block = (svc) => src.match(new RegExp(`\\n  ${svc}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|\\nnetworks:)`))?.[1] ?? "";
  const want = { cloudflared: "tunnel", "mautrix-discord": "discord" };
  for (const svc of ["postgres", "migrate", "stream-api", "stream-ingest", "web", "caddy", "synapse", "mas", ...Object.keys(want)]) {
    const b = block(svc);
    assert.ok(b, `no service block for ${svc}`);
    const p = b.match(/profiles: \["([a-z]+)"\]/)?.[1];
    assert.equal(p, want[svc], `${svc}: profile ${p ?? "(none)"}`);
  }
});

const installBlock = () => {
  const m = read("compose.yaml").match(/x-install-values: &install-values\n((?: {2}[A-Z_]+: .*\n)+)/);
  assert.ok(m, "x-install-values block");
  return m[1].split("\n").filter(Boolean).map((l) => l.trim().split(":")[0]);
};
// Install keys web reads that the bundle deliberately does not pass: the legacy namespace and the legacy
// site id are never set on a fresh install; the federation address is derived from the homeserver
// address (matrix.<domain>:443, where the bundle's router takes federation when it is on); the
// Discord bridge is 1.0.
const NOT_PASSED = { "matrix.legacyNamespace": "never on a fresh install", "site.legacyId": "never on a fresh install",
  "matrix.federationServer": "derived: matrix.<domain>:443",
  "discordBridge.usernameTemplate": "1.0 (bridge)", "discordBridge.displaynameTemplate": "1.0 (bridge)" };

test("web gets exactly the schema's install keys it reads, at start", () => {
  const schema = INSTANCE_KEYS.filter((k) => k.tier === "install" && k.packages.includes("web") && !(k.key in NOT_PASSED)).map((k) => k.env[0]);
  assert.equal(schema.length, 24);
  assert.ok(INSTANCE_KEYS.filter((k) => k.tier === "install").every((k) => k.reload === "restart"), "an install key applies at restart — nothing is built in");
  assert.deepEqual([...installBlock()].sort(), [...schema].sort());
  const src = read("compose.yaml");
  assert.equal((src.match(/<<: \*install-values/g) ?? []).length, 1, "web merges the block");
  assert.doesNotMatch(read("compose.yaml") + read("install.sh") + read(".env.example") + read("blackbranch"), /MATRIX_LEGACY_NAMESPACE|SITE_LEGACY_ID/);
  assert.match(src, /STREAM_API_ENFORCE: "1"/);
});

const arr = (name) => {
  const m = read("blackbranch").match(new RegExp(`\\n${name}=\\(\\n?([\\s\\S]*?)\\n?\\)`));
  assert.ok(m, name);
  return m[1].split(/\s+/).filter(Boolean);
};

test("`set` reaches the site's display values only — its install values minus the permanent identity", () => {
  const identity = ["SITE_ORIGIN", "SITE_API_ORIGIN", "SITE_API_WS_ORIGIN", "MATRIX_SERVER_NAME", "MATRIX_HOMESERVER_URL", "MATRIX_OAUTH_ISSUER", "MATRIX_OAUTH_CLIENT_ID"];
  assert.deepEqual([...arr("SETTABLE_KEYS")].sort(), installBlock().filter((k) => !identity.includes(k)).sort());
  assert.deepEqual(arr("REQUEST_RESTARTABLE"), ["stream-api", "stream-ingest", "web"]);
});

const envKeys = (src) => [...src.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);

test(".env.example, the .env install.sh writes and the Compose file agree on every key", () => {
  const example = envKeys(read(".env.example"));
  const heredoc = read("install.sh").match(/cat > "\$tmp" <<EOF\n([\s\S]*?)\nEOF/)?.[1] ?? "";
  assert.deepEqual(envKeys(heredoc), example, "install.sh writes the keys .env.example shows, in the same order");
  const used = new Set([...read("compose.yaml").matchAll(/\$\{([A-Z_]+)[:}-]/g)].map((m) => m[1]));
  // BB_RELEASE_DIR is passed by blackbranch per run (the next release's source during an update).
  for (const k of used) if (k !== "BB_RELEASE_DIR") assert.ok(example.includes(k), `compose reads ${k}, which .env never holds`);
  // The homeserver's secrets are read by `blackbranch render`, not by Compose.
  const rendered = new Set([...read("blackbranch").matchAll(/env_get ([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
  for (const k of ["SYNAPSE_DB_PASSWORD", "MAS_DB_PASSWORD", "SYNAPSE_REGISTRATION_SECRET", "SYNAPSE_MACAROON_SECRET", "SYNAPSE_FORM_SECRET",
    "MAS_SYNAPSE_SECRET", "MAS_ENCRYPTION_SECRET", "MATRIX_OAUTH_CLIENT_SECRET", "MATRIX_HOMESERVER_URL", "MATRIX_OAUTH_ISSUER"]) {
    assert.ok(rendered.has(k), `blackbranch render does not read ${k}`);
  }
  for (const k of example) {
    if (/^(COMPOSE_|BB_|CLOUDFLARE_)/.test(k) || k === "BACKUP_PASSPHRASE") continue; // bundle-side, or read by the backup tooling
    assert.ok(used.has(k) || rendered.has(k), `.env holds ${k}, which neither a service nor render reads`);
  }
});

function render(mode, extra = "") {
  const home = renderHome(`BB_TLS_MODE=${mode}\n${extra}`);
  try {
    const r = runRender(home);
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(path.join(home, "rendered/caddy/Caddyfile"), "utf8");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("the router renders one routing table for each TLS mode", () => {
  const tunnel = render("tunnel"), direct = render("direct", "BB_ACME_EMAIL=ops@example.test\n"), lab = render("internal");
  for (const [name, c] of Object.entries({ tunnel, direct, lab })) {
    const scheme = name === "tunnel" ? "http://" : "";
    for (const [host, up] of [["example.test", "web:3000"], ["api.example.test", "stream-api:3001"]]) {
      assert.match(c, new RegExp(`\\n${scheme.replace("/", "\\/")}${host.replace(/\./g, "\\.")} \\{\\n\\timport upstream ${up}\\n\\}`), `${name}: ${host}`);
    }
    assert.match(c, /import upstream synapse:8008/); assert.match(c, /import upstream mas:8080/);
    // Every upstream is reached through the one snippet, which overwrites the client address.
    assert.match(c, /\(upstream\) \{\n\treverse_proxy \{args\[0\]\} \{\n\t\theader_up CF-Connecting-IP \{client_ip\}\n\t\theader_up X-Forwarded-For \{client_ip\}\n\t\}\n\}/, name);
    assert.equal((c.match(/reverse_proxy /g) ?? []).length, 1, `${name}: a reverse_proxy outside the snippet`);
  }
  assert.match(tunnel, /auto_https off/);
  assert.doesNotMatch(direct + lab, /trusted_proxies|client_ip_headers/, "direct and lab modes trust no proxy");
  assert.doesNotMatch(direct, /auto_https|local_certs/); assert.match(direct, /email ops@example\.test/);
  assert.match(lab, /local_certs/); assert.match(lab, /LAB MODE — NOT FOR PRODUCTION/);
  assert.doesNotMatch(direct + lab, /http:\/\//);
});

test("stream-api counts WebSocket viewers by the address caddy names: caddy has a fixed address, and stream-api trusts that one", (t) => {
  // stream-api caps sockets per client address (MAX_WS_PER_ADDRESS) and believes CF-Connecting-IP only
  // from WS_TRUSTED_PROXIES. Every viewer reaches it through caddy: trusting nobody would count the
  // whole audience as caddy's one address — an install capped at one address's sockets in total.
  for (const [mode, c] of [["tunnel", render("tunnel")], ["direct", render("direct")], ["internal", render("internal")]]) {
    // caddy SETS the header on every request: the connecting address (direct, lab), or Cloudflare's
    // own header, believed from cloudflared's fixed address alone (tunnel). A client's own is overwritten.
    assert.match(c, /\n\t\theader_up CF-Connecting-IP \{client_ip\}\n/, mode);
    if (mode === "tunnel") assert.match(c, /client_ip_headers Cf-Connecting-Ip/);
    else assert.doesNotMatch(c, /trusted_proxies|client_ip_headers/, `${mode}: {client_ip} is the connecting address`);
  }
  const src = read("compose.yaml");
  const block = (svc) => src.match(new RegExp(`\\n {2}${svc}:\\n([\\s\\S]*?)(?=\\n {2}[a-z-]+:\\n)`))?.[1] ?? "";
  assert.match(block("caddy"), /\n {4}networks:\n {6}default:\n {8}ipv4_address: \$\{BB_CADDY_IP:-172\.29\.83\.249\}\n/);
  assert.match(block("stream-api"), /\n {6}WS_TRUSTED_PROXIES: \$\{BB_CADDY_IP:-172\.29\.83\.249\}\n/);
  const ex = read(".env.example");
  assert.equal(ex.match(/^BB_CADDY_IP=(.*)$/m)?.[1], "172.29.83.249");
  assert.match(read("install.sh"), /\nBB_CADDY_IP=172\.29\.83\.249\n/, "a new install's .env holds it");
  const skip = needs(dockerCompose, "docker compose"); if (skip) return t.skip(skip);
  for (const profiles of [["tunnel"], []]) {
    const cfg = composeConfig(path.join(here, ".env.example"), profiles);
    assert.equal(cfg.services.caddy.networks.default.ipv4_address, "172.29.83.249");
    assert.equal(cfg.services["stream-api"].environment.WS_TRUSTED_PROXIES, "172.29.83.249", "stream-api trusts caddy's address");
  }
});

test("the site keys its per-address limits by the address caddy names: web trusts caddy's fixed address, and only it", (t) => {
  // web believes CF-Connecting-IP only from WEB_TRUSTED_PROXIES (app/lib/rateLimit.ts ipKey), else
  // it keys on the socket's peer. On a bundle every request reaches web from caddy: trusting nobody
  // would put every signed-out visitor in caddy's one bucket. caddy overwrites the header on every
  // request (the test above), so believing it from caddy is believing caddy.
  const src = read("compose.yaml");
  const block = (svc) => src.match(new RegExp(`\\n {2}${svc}:\\n([\\s\\S]*?)(?=\\n {2}[a-z-]+:\\n)`))?.[1] ?? "";
  assert.match(block("web"), /\n {6}WEB_TRUSTED_PROXIES: \$\{BB_CADDY_IP:-172\.29\.83\.249\}\n/);
  for (const svc of ["stream-ingest", "synapse", "mas", "caddy", "cloudflared"]) assert.doesNotMatch(block(svc), /WEB_TRUSTED_PROXIES/, svc);
  const skip = needs(dockerCompose, "docker compose"); if (skip) return t.skip(skip);
  for (const profiles of [["tunnel"], []]) {
    const cfg = composeConfig(path.join(here, ".env.example"), profiles);
    assert.equal(cfg.services.web.environment.WEB_TRUSTED_PROXIES, cfg.services.caddy.networks.default.ipv4_address, "web trusts caddy's address");
  }
});

test("tunnel mode trusts exactly cloudflared's fixed address — never a whole private range", (t) => {
  const tunnel = render("tunnel");
  assert.match(tunnel, /\n\t\ttrusted_proxies static 172\.29\.83\.250\/32\n\t\tclient_ip_headers Cf-Connecting-Ip\n/);
  assert.doesNotMatch(tunnel, /private_ranges/);
  assert.match(render("tunnel", "BB_CLOUDFLARED_IP=10.0.0.8\n"), /trusted_proxies static 10\.0\.0\.8\/32\n/, "follows .env");
  const home = mkdtempSync(path.join(tmpdir(), "bb-home-"));
  try {
    writeFileSync(path.join(home, ".env"), "BB_DOMAIN=example.test\nBB_TLS_MODE=tunnel\nBB_CLOUDFLARED_IP=0.0.0.0/0\n");
    const r = spawnSync("bash", [path.join(here, "blackbranch"), "render"], { encoding: "utf8", env: { ...process.env, BB_HOME: home } });
    assert.notEqual(r.status, 0, "a range in BB_CLOUDFLARED_IP is refused");
  } finally { rmSync(home, { recursive: true, force: true }); }
  const skip = needs(dockerCompose, "docker compose"); if (skip) return t.skip(skip);
  const cfg = composeConfig(path.join(here, ".env.example"), ["tunnel"]);
  assert.equal(cfg.services.cloudflared.networks.default.ipv4_address, "172.29.83.250");
  assert.equal(cfg.networks.default.ipam.config[0].subnet, "172.29.83.0/24");
  const tunnelOnly = composeConfig(path.join(here, ".env.example"), ["tunnel"], false);
  for (const [name, s] of Object.entries(tunnelOnly.services)) assert.equal(s.ports, undefined, `tunnel mode: ${name} publishes a port`);
});

test("requests: results live outside the site's drop box, and a link there is refused before anything is written", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bb-home-"));
  const elsewhere = mkdtempSync(path.join(tmpdir(), "bb-target-"));
  try {
    writeFileSync(path.join(home, ".env"), "BB_DOMAIN=example.test\nBB_TLS_MODE=internal\n");
    mkdirSync(path.join(home, "requests")); mkdirSync(path.join(home, "results"), { mode: 0o755 });
    const run = () => spawnSync("bash", [path.join(here, "blackbranch"), "process-requests"], { encoding: "utf8", env: { ...process.env, BB_HOME: home } });
    // A normal pass: a refused verb and an update without a release each get a result; the requests are gone.
    writeFileSync(path.join(home, "requests/update.req"), "ignored");
    writeFileSync(path.join(home, "requests/bogus.req"), "");
    // (named as no verb, so only the link handling runs — a real verb would start its work)
    symlinkSync(path.join(elsewhere, "planted"), path.join(home, "requests/planted.req"));
    let r = run(); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(path.join(home, "requests")), []);
    // An unknown name gets no answer: a result named after it could overwrite one of root's records.
    assert.deepEqual(readdirSync(path.join(home, "results")).sort(), ["update.json"]);
    assert.match(r.stderr, /refused an unknown request \(bogus\)/);
    assert.match(readFileSync(path.join(home, "results/update.json"), "utf8"), /"ok":false,.*"message":"name the release: the request is update-v<version>"/);
    assert.deepEqual(readdirSync(elsewhere), [], "a link planted as a request was removed, not followed");
    // The attack: results/ replaced by a link to somewhere else.
    rmSync(path.join(home, "results"), { recursive: true });
    symlinkSync(elsewhere, path.join(home, "results"));
    writeFileSync(path.join(home, "requests/update.req"), "");
    r = run();
    assert.notEqual(r.status, 0); assert.match(r.stderr, /refusing to run requests/);
    assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");
    // A results directory others can write is refused too.
    rmSync(path.join(home, "results")); mkdirSync(path.join(home, "results")); chmodSync(path.join(home, "results"), 0o777);
    r = run(); assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(path.join(home, "results")), []);
    assert.match(read("compose.yaml"), /- \.\/results:\/request-results:ro/, "the site mounts results read-only");
    assert.match(read("install.sh"), /chown root:root "\$BB_HOME\/results"; chmod 755 "\$BB_HOME\/results"/);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});

test("commands not in this release say so and fail, rather than silently doing nothing", () => {
  for (const c of ["user"]) {
    const r = spawnSync("bash", [path.join(here, "blackbranch"), c], { encoding: "utf8", env: { ...process.env, BB_HOME: "/nonexistent" } });
    assert.equal(r.status, 3, c); assert.match(r.stderr, /not in this release yet/);
  }
});

test("set refuses identity keys, and values .env cannot hold", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bb-home-"));
  try {
    copyFileSync(path.join(here, ".env.example"), path.join(home, ".env"));
    const run = (...a) => spawnSync("bash", [path.join(here, "blackbranch"), "set", ...a], { encoding: "utf8", env: { ...process.env, BB_HOME: home } });
    let r = run("SITE_ORIGIN", "https://elsewhere.test"); assert.notEqual(r.status, 0); assert.match(r.stderr, /permanent/);
    for (const bad of ["a $HOME b", "say \"hi\"", "back\\slash"]) { r = run("SITE_NAME", bad); assert.notEqual(r.status, 0, bad); assert.match(r.stderr, /may not contain/); }
    assert.equal(readFileSync(path.join(home, ".env"), "utf8"), read(".env.example"), ".env untouched by a refused set");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("set applies a display value by recreating what reads it — nothing is built; a site that does not come back gets the old value", () => {
  const h = fakeHome();
  try {
    const original = h.env();
    let r = h.run("set", "CURRENCY_NAME", "coin");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CURRENCY_NAME applied/);
    assert.match(h.env(), /^CURRENCY_NAME="coin"$/m);
    assert.match(h.calls(), /compose up -d\n/);
    assert.doesNotMatch(h.calls(), /compose run|build/, "no build: the site reads the value when it starts");
    writeFileSync(path.join(h.home, ".env"), original, { mode: 0o600 });
    r = h.runWith({ FAKE_UNHEALTHY: "web", BB_HEALTH_WAIT: "1" }, "set", "CURRENCY_NAME", "coin");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CURRENCY_NAME put back to its previous value/);
    assert.equal(envValue(h.env(), "CURRENCY_NAME"), envValue(original, "CURRENCY_NAME"));
  } finally { rmSync(h.home, { recursive: true, force: true }); }
  const bb = read("blackbranch");
  assert.doesNotMatch(bb, /cmd_rebuild|\brebuild\)|web-build|in_build_volume/, "the rebuild command and its request are gone");
  assert.doesNotMatch(bb.split("\n").slice(0, 45).join("\n"), /rebuild/, "the help text names no rebuild");
});

test("install verification pass: a service that will plainly never be healthy stops the wait at once — named, with its cause", () => {
  const h = fakeHome("BB_TLS_MODE=tunnel");
  try {
    const original = h.env();
    const timed = (env) => { const t0 = Date.now(); const r = h.runWith(env, "set", "CURRENCY_NAME", "coin"); return { ...r, ms: Date.now() - t0 }; };
    // A tunnel token that is not one: cloudflared says so in its log and exits, again and again.
    // Before: the wait ran its full 240 s and said only "not every service became healthy".
    writeFileSync(path.join(h.fake, "logs-cloudflared"), "Provided Tunnel token is not valid.\nSee 'cloudflared tunnel run --help'.\n");
    let r = timed({ FAKE_UNHEALTHY: "cloudflared" });
    assert.notEqual(r.status, 0);
    assert.ok(r.ms < 20_000, `stopped at once, not after the full wait (${r.ms} ms)`);
    assert.match(r.stderr, /cloudflared: the tunnel token is not valid \(cloudflared: "Provided Tunnel token is not valid\."\).*--tunnel-token/s);
    assert.equal(envValue(h.env(), "CURRENCY_NAME"), envValue(original, "CURRENCY_NAME"), "the value put back");
    // A token Cloudflare does not know (a deleted tunnel, another account's).
    writeFileSync(path.join(h.fake, "logs-cloudflared"), '2026-10-18T18:56:01Z ERR Register tunnel error from server side error="Failed to get tunnel"\n');
    r = timed({ FAKE_UNHEALTHY: "cloudflared" });
    assert.ok(r.ms < 20_000, `${r.ms} ms`);
    assert.match(r.stderr, /cloudflared: Cloudflare does not know this tunnel \(cloudflared: "Failed to get tunnel"\)/);
    // Any service that keeps restarting: named, with its last log line.
    writeFileSync(path.join(h.fake, "logs-web"), "starting\nError: listen EADDRINUSE: address already in use :::3000\n");
    writeFileSync(path.join(h.fake, "restarts-web"), "0");
    r = timed({ FAKE_UNHEALTHY: "web" });
    assert.ok(r.ms < 30_000, `${r.ms} ms`);
    assert.match(r.stderr, /web: it keeps stopping \(restarted 5 times while waiting\); its last words: Error: listen EADDRINUSE/);
    // Merely slow (no cause in sight): the wait runs to its end, and still names who was not healthy.
    rmSync(path.join(h.fake, "restarts-web"));
    r = timed({ FAKE_UNHEALTHY: "web", BB_HEALTH_WAIT: "1" });
    assert.match(r.stderr, /not healthy: web:unhealthy/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("every script passes bash -n, and shellcheck with no finding", (t) => {
  for (const f of SCRIPTS) {
    const r = spawnSync("bash", ["-n", path.join(here, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const skip = needs(shellcheck, "shellcheck"); if (skip) return t.skip(skip);
  const r = spawnSync("shellcheck", ["-x", ...SCRIPTS.map((f) => path.join(here, f))], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});

// ── First boot ──────────────────────────────────────────────────────────────────────────────
test("direct and lab mode: caddy answers to the site's three names inside the network; tunnel mode adds no alias", (t) => {
  const skip = needs(dockerCompose, "docker compose"); if (skip) return t.skip(skip);
  const pub = composeConfig(path.join(here, ".env.example"));
  assert.deepEqual(pub.services.caddy.networks.default.aliases, ["example.com", "api.example.com", "matrix.example.com"]);
  const tunnel = composeConfig(path.join(here, ".env.example"), ["tunnel"], false);
  assert.equal(tunnel.services.caddy.networks?.default?.aliases, undefined, "tunnel mode: no certificates inside the box to answer with");
});

test("lab mode: web and stream-api trust caddy's root from a file blackbranch copies — the certificate, never a key", (t) => {
  assert.match(read("install.sh"), /internal\) profiles=""; files="\$BB_HOME\/compose\.yaml:\$BB_HOME\/compose\.public\.yaml:\$BB_HOME\/compose\.lab\.yaml" ;;/);
  assert.match(read("blackbranch"), /\nBUNDLE_HOME_FILES=\(compose\.yaml compose\.public\.yaml compose\.lab\.yaml\)\n/, "install-files puts the lab file in place");
  const bb = read("blackbranch");
  const exp = bb.slice(bb.indexOf("export_lab_ca() {"), bb.indexOf("\n}\n", bb.indexOf("export_lab_ca() {")));
  assert.match(exp, /cat \/data\/caddy\/pki\/authorities\/local\/root\.crt/);
  assert.doesNotMatch(exp, /\.key|intermediate/, "only the root certificate leaves caddy's data");
  assert.match(bb, /\n {2}export_lab_ca\n {2}info "all services healthy"/, "up copies it once everything runs");
  const skip = needs(dockerCompose, "docker compose"); if (skip) return t.skip(skip);
  const dir = mkdtempSync(path.join(tmpdir(), "bb-compose-"));
  try {
    const cfg = JSON.parse(execFileSync("docker", ["compose", "-f", path.join(here, "compose.yaml"), "-f", path.join(here, "compose.public.yaml"),
      "-f", path.join(here, "compose.lab.yaml"), "--project-directory", dir, "--env-file", path.join(here, ".env.example"), "config", "--format", "json"],
    { encoding: "utf8", env: { ...process.env, COMPOSE_PROFILES: "", COMPOSE_FILE: "" } }));
    for (const svc of ["web", "stream-api"]) {
      assert.equal(cfg.services[svc].environment.NODE_EXTRA_CA_CERTS, "/lab-ca/root.crt", svc);
      assert.ok(cfg.services[svc].volumes.some((v) => v.target === "/lab-ca" && v.read_only), `${svc}: lab-ca read-only`);
    }
    assert.equal(cfg.services.caddy.environment?.NODE_EXTRA_CA_CERTS, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const envValue = (env, key) => env.match(new RegExp(`^${key}="?([^"\\n]*)"?$`, "m"))?.[1] ?? null;

test("setup link: one token, root-only, its sha256 in .env for the site; reprinted while valid, retired once an admin exists", () => {
  const h = fakeHome();
  try {
    let r = h.run("setup-link");
    assert.equal(r.status, 0, r.stderr);
    const tokenFile = path.join(h.home, "state/setup-token");
    const token = readFileSync(tokenFile, "utf8").trim();
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600, "the token file is root's alone");
    assert.match(r.stdout, new RegExp(`https://example\\.test/setup\\?token=${token}\\n`));
    const hash = execFileSync("sha256sum", { input: token, encoding: "utf8" }).split(" ")[0];
    assert.equal(envValue(h.env(), "SETUP_TOKEN_HASH"), hash, "the site gets the hash, never the token");
    assert.doesNotMatch(h.env(), new RegExp(token), "the token itself is not in .env");
    assert.match(h.calls(), /compose up -d --no-deps web/, "web restarted to read the new hash");
    // Again: the same link, nothing restarted.
    const before = h.calls().length;
    r = h.run("setup-link");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`token=${token}\\n`));
    assert.doesNotMatch(h.calls().slice(before), /compose up/);
    // --new: a different token, and the hash follows it.
    r = h.run("setup-link", "--new");
    const token2 = readFileSync(tokenFile, "utf8").trim();
    assert.notEqual(token2, token);
    assert.equal(envValue(h.env(), "SETUP_TOKEN_HASH"), execFileSync("sha256sum", { input: token2, encoding: "utf8" }).split(" ")[0]);
    // The first admin exists: the link is dead and its token gone.
    writeFileSync(path.join(h.fake, "cfg/streamer.matrixId"), "@owner:example.test\n");
    r = h.run("setup-link");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /the setup link no longer works: the first admin \(@owner:example\.test\) exists/);
    assert.equal(existsSync(tokenFile), false);
    assert.doesNotMatch(r.stdout, /token=/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
  assert.match(read("install.sh"), /\nBB_HOME="\$BB_HOME" \/usr\/local\/bin\/blackbranch setup-link \|\| true\nexit 0\n$/, "the installer prints it last");
  assert.match(read("blackbranch"), /\n {2}ensure_setup_token\n {2}recovery_sheet_sweep\n {2}cmd_render\n/, "up makes the token once the database answers");
});

test("apply-install: the setup pages' values reach .env only after the host checks each again; a site that does not come back puts .env back", () => {
  const h = fakeHome();
  try {
    const tsv = (rows) => writeFileSync(path.join(h.fake, "install.tsv"), rows.map(([k, v]) => `${k}\t${v}`).join("\n") + "\n");
    const original = h.env();
    // Refused before anything is written: an identity key, a value .env cannot hold.
    for (const [rows, why] of [
      [[["SITE_NAME", "Fine"], ["SITE_ORIGIN", "https://elsewhere.test"]], /SITE_ORIGIN is not a display value/],
      [[["SITE_NAME", "a $HOME b"]], /SITE_NAME: the value may not contain/],
      [[["SITE_TAGLINE", 'say "hi"']], /SITE_TAGLINE: the value may not contain/],
    ]) {
      tsv(rows);
      const before = h.calls().length;
      const r = h.run("apply-install");
      assert.notEqual(r.status, 0, JSON.stringify(rows));
      assert.match(r.stderr, why);
      assert.doesNotMatch(h.calls().slice(before), /compose (run|config|up)/, "refused before .env or a service was touched");
      assert.equal(h.env(), original, `.env touched by a refused value: ${JSON.stringify(rows)}`);
    }
    // Good values, but the site does not come back healthy with them: .env is put back exactly.
    tsv([["SITE_NAME", "My Stream"], ["CURRENCY_NAME", "coin"]]);
    let r = h.runWith({ FAKE_UNHEALTHY: "web", BB_HEALTH_WAIT: "1" }, "apply-install");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not every service became healthy with the new values \(web:unhealthy\) — \.env put back as it was/);
    assert.equal(h.env(), original);
    assert.deepEqual(readdirSync(h.home).filter((f) => f.startsWith(".env.")), [], "no backup left behind");
    // Good values and a healthy site: .env holds them, and the services are recreated — no build.
    let before = h.calls().length;
    r = h.run("apply-install");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /applied SITE_NAME CURRENCY_NAME/);
    assert.equal(envValue(h.env(), "SITE_NAME"), "My Stream");
    assert.match(h.calls().slice(before), /compose up -d\n/);
    assert.doesNotMatch(h.calls().slice(before), /compose run|build/, "nothing is built: the site reads them when it starts");
    writeFileSync(path.join(h.home, ".env"), original, { mode: 0o600 });
    // Values .env already holds: nothing to restart.
    tsv([["SITE_NAME", envValue(original, "SITE_NAME")]]);
    before = h.calls().length;
    r = h.run("apply-install");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /unchanged — nothing to restart/);
    assert.doesNotMatch(h.calls().slice(before), /compose (run|up)/);
    // Once setup is finished the request is refused: later changes go through `set`.
    writeFileSync(path.join(h.fake, "cfg/setup.completedAt"), "2026-10-10T00:00:00Z\n");
    r = h.run("apply-install");
    assert.notEqual(r.status, 0); assert.match(r.stderr, /setup is finished/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
  const bb = read("blackbranch");
  assert.match(bb, /\n {6}apply-install\) verb=apply-install; if msg=\$\(cmd_apply_install 2>&1\); then ok=true; fi ;;/);
  assert.match(bb, /\n {6}matrix-bootstrap\) verb="matrix bootstrap"; if msg=\$\(matrix_bootstrap 2>&1\); then ok=true; fi ;;/);
  assert.doesNotMatch(bb, /grant-synapse-admin/, "the bootstrap's sign-in is the owner's own, never a server admin's");
  assert.match(bb, /SELECT value #>> '\{install,SITE_NAME\}' FROM site\.instance_config WHERE key = 'setup\.state';[\s\S]{0,200}space_name="\$\{space_name:-\$\(env_get SITE_NAME\)\}"/,
    "the community space takes the name typed during setup, before .env has it");
});

test("the setup pages may stage exactly the values `set` may change", () => {
  const state = INSTANCE_KEYS.find((e) => e.key === "setup.state");
  assert.ok(state, "setup.state is in the schema");
  assert.deepEqual([...state.values].sort(), [...arr("SETTABLE_KEYS")].sort());
});

test("an upgrade brings every migration since the FIRST baseline — a regenerated baseline must not strand an older box", () => {
  const inst = read("release-copy.sh");
  const first = Number(inst.match(/^FIRST_BASELINE_VERSION=(\d+)$/m)?.[1]);
  assert.equal(first, 146, "the first released baseline: v146 (nothing was published before the platform-key rename)");
  assert.match(inst, /if \[ "\$v" -gt "\$FIRST_BASELINE_VERSION" \]; then newer\+=\("--include=\/migrations\/migrate-v\$v\.sql"\); fi/,
    "the release copy selects by the first baseline, not by this release's");
  const base = Number(readFileSync(path.join(root, "migrations/baseline/schema.sql"), "utf8").match(/up to v(\d+)/)?.[1]);
  assert.ok(base >= first, `the baseline (v${base}) is older than the first one released (v${first})`);
  const shipped = readdirSync(path.join(root, "migrations")).map((f) => f.match(/^migrate-v(\d+)\.sql$/)?.[1]).filter(Boolean).map(Number).filter((v) => v > first);
  // Every version folded into the baseline since the first release still ships as a file. With no
  // migration since it (base === first) there is nothing an older box could need: the release
  // carries no chain file at all, which is the claim checked instead.
  if (base === first) assert.deepEqual(shipped, [], "a migration newer than the first baseline exists but the baseline was not regenerated");
  for (let v = first + 1; v <= base; v++) assert.ok(shipped.includes(v), `v${v} is folded into the baseline but an older box still needs its file`);
  // …and the runner applies only what the database does not record, so a fresh box applies none twice.
  assert.match(read("migrate.sh"), /case "\$applied" in \*" \$v "\*\) continue ;; esac/);
});
