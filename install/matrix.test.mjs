// The homeserver in the bundle. Run: node --test install/
// (CI job `install`). No Docker needed: render runs on a scratch install home with a stand-in for
// MAS's signing keys, and the bootstrap runs against a small fake homeserver in this process. The
// real pair is booted by CI job `matrix` (the same generator).
//
// What they hold: render writes Synapse's and MAS's config from .env alone with no owner literal;
// federation off = no federation listener + an empty whitelist + the router answering 404 for
// federation paths, on = the listener + the route, with the server name unchanged; MAS names the
// issuer under matrix.<domain>, the site's client, its redirect URI and the admin client; the
// site's well-known names the same homeserver and issuer the render used; a failed render
// replaces nothing; the bootstrap is idempotent, refuses to replace a recorded room silently, never
// adopts a room another account created (by its alias or as the recorded one), and writes only
// Matrix's own m.* state — no namespace of the site's at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderHome, runRender, fakeHome } from "./scratch-home.mjs";
import { loadConfig, countLiterals } from "../tools/check-owner-literals.mjs";
import { clientWellKnown } from "../web/app/lib/matrixWellKnown.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");

const envOf = (home) => Object.fromEntries(readFileSync(path.join(home, ".env"), "utf8").split("\n")
  .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, "$1")]; }));
const files = (home) => ({
  hs: readFileSync(path.join(home, "rendered/synapse/homeserver.yaml"), "utf8"),
  log: readFileSync(path.join(home, "rendered/synapse/log.config"), "utf8"),
  mas: readFileSync(path.join(home, "rendered/mas/config.yaml"), "utf8"),
  caddy: readFileSync(path.join(home, "rendered/caddy/Caddyfile"), "utf8"),
});
function rendered(extra = "", federation = null) {
  const home = renderHome(extra);
  if (federation) { mkdirSync(path.join(home, "state")); writeFileSync(path.join(home, "state/federation"), `${federation}\n`); }
  const r = runRender(home);
  assert.equal(r.status, 0, r.stderr);
  return { home, env: envOf(home), out: r.stdout, ...files(home) };
}
const listeners = (hs) => [...hs.matchAll(/\n {2}- port: (\d+)\n[\s\S]*?names: \[([a-z, ]+)\]/g)].map((m) => `${m[1]}:${m[2]}`);

test("vacuity: the generator and the bootstrap are the files these tests read", () => {
  assert.match(read("matrix/render.sh"), /^mx_render_homeserver\(\) \{$/m);
  assert.match(read("matrix/render.sh"), /^mx_render_mas\(\) \{$/m);
  assert.match(read("matrix/render.sh"), /^mx_caddy_routes\(\) \{$/m);
  assert.match(read("matrix/bootstrap.mjs"), /const HUB_ALIAS = "community-hub";/);
});

test("render writes Synapse's and MAS's config from .env alone — and no owner literal", () => {
  const { home, env, hs, log, mas, caddy, out } = rendered();
  try {
    assert.match(out, /rendered\/synapse\/homeserver\.yaml: written \(federation off\)/);
    assert.match(hs, /^server_name: "example\.test"$/m, "the server name is the bare domain");
    assert.match(hs, /^public_baseurl: "https:\/\/matrix\.example\.test\/"$/m);
    assert.match(hs, /\n {4}user: "synapse"\n {4}password: "([0-9a-f]+)"\n {4}database: "synapse"\n {4}host: "postgres"\n/);
    assert.equal(hs.match(/\n {4}password: "([0-9a-f]+)"/)[1], env.SYNAPSE_DB_PASSWORD);
    assert.match(hs, /^media_store_path: \/data\/media_store$/m);
    assert.match(hs, /^signing_key_path: \/data\/signing\.key$/m);
    assert.match(hs, /^log_config: \/config\/log\.config$/m);
    for (const [k, e] of [["registration_shared_secret", "SYNAPSE_REGISTRATION_SECRET"], ["macaroon_secret_key", "SYNAPSE_MACAROON_SECRET"], ["form_secret", "SYNAPSE_FORM_SECRET"]]) {
      assert.match(hs, new RegExp(`^${k}: "${env[e]}"$`, "m"), k);
    }
    assert.match(hs, /\nmatrix_authentication_service:\n {2}enabled: true\n {2}endpoint: "http:\/\/mas:8080\/"\n {2}secret: "([0-9a-f]+)"\n/);
    assert.equal(hs.match(/\nmatrix_authentication_service:[\s\S]*?secret: "([0-9a-f]+)"/)[1], env.MAS_SYNAPSE_SECRET);
    assert.match(hs, /\nretention:\n {2}enabled: true\n {2}default_policy:\n {4}max_lifetime: 180d\n {2}allowed_lifetime_min: 1d\n {2}allowed_lifetime_max: 1y\n/);
    assert.match(hs, /^default_room_version: "12"$/m);
    assert.match(hs, /^serve_server_wellknown: false$/m);
    assert.match(hs, /\n {4}x_forwarded: true\n/, "Synapse sits behind the router");
    for (const [name, text] of Object.entries({ hs, log, mas, caddy })) {
      assert.doesNotMatch(text, /change-me|undefined|\$\{|\$[A-Z]/, `${name}: an unexpanded value`);
      const n = countLiterals(text, loadConfig());
      assert.equal(n, 0, `${name}: ${n} owner literal(s) in the render`);
    }
    // Every file holding a secret is private to its service.
    for (const f of ["rendered/synapse/homeserver.yaml", "rendered/mas/config.yaml"]) assert.equal(statSync(path.join(home, f)).mode & 0o777, 0o600, f);
    for (const d of ["rendered/synapse", "rendered/mas", "matrix"]) assert.equal(statSync(path.join(home, d)).mode & 0o777, 0o700, d);
    // A second render changes nothing.
    const again = runRender(home);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /homeserver\.yaml: unchanged \(federation off\) · log\.config: unchanged · rendered\/mas\/config\.yaml: unchanged/);
    assert.match(again.stdout, /rendered\/caddy\/Caddyfile: unchanged/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the public room list: exactly the bootstrap's two aliases may be listed, nothing else", () => {
  const home = renderHome("BB_TLS_MODE=internal\n");
  try {
    const r = runRender(home); assert.equal(r.status, 0, r.stderr);
    const hs = readFileSync(path.join(home, "rendered/synapse/homeserver.yaml"), "utf8");
    assert.match(hs, /\nroom_list_publication_rules:\n {2}- alias: "#community-hub:example\.test"\n {4}action: allow\n {2}- alias: "#general:example\.test"\n {4}action: allow\n {2}- action: deny\n/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("federation OFF: no federation listener, an empty whitelist, the router answers 404 for other servers", () => {
  const { home, hs, caddy } = rendered();
  try {
    assert.deepEqual(listeners(hs), ["8008:client"]);
    // A port is a listener line, never a bare digit run: a random hex secret once contained "8448"
    // (CI 38327705473) and failed this on a correct render.
    assert.doesNotMatch(hs, /^\s*- port: 8448\b|names: \[[a-z, ]*federation/m);
    assert.match(hs, /^federation_domain_whitelist: \[\]$/m);
    assert.match(hs, /^trusted_key_servers: \[\]$/m);
    assert.match(caddy, /\t@federation path \/_matrix\/federation\/\* \/_matrix\/key\/\*\n\t# Federation OFF: nothing answers for other servers\.\n\thandle @federation \{\n\t\trespond 404\n\t\}\n/);
    assert.doesNotMatch(caddy, /synapse:8448/);
    // The federation route comes before the catch-all /_matrix/* one (Caddy's handle blocks are
    // mutually exclusive and ordered by path specificity; a named matcher sorts first — stated
    // here so a reorder that sends federation to the client listener is caught by eye too).
    assert.ok(caddy.indexOf("handle @federation") < caddy.indexOf("handle /_matrix/*"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("federation ON: the listener and the route appear, the whitelist goes, the server name does not change", () => {
  const off = rendered();
  const on = rendered("", "on");
  try {
    assert.deepEqual(listeners(on.hs), ["8008:client", "8448:federation"]);
    assert.doesNotMatch(on.hs, /federation_domain_whitelist/);
    assert.match(on.hs, /^trusted_key_servers: \[\]$/m, "no third-party notary either way");
    assert.match(on.caddy, /\thandle @federation \{\n\t\timport upstream synapse:8448\n\t\}\n/);
    assert.match(on.out, /homeserver\.yaml: written \(federation on\)/);
    const name = (t) => t.match(/^server_name: "([^"]+)"$/m)[1];
    assert.equal(name(on.hs), name(off.hs));
    // Only the federation lines differ; everything else is the same render (secrets aside).
    const strip = (t, env) => Object.values(env).filter((v) => /^[0-9a-f]{32,}$/.test(v)).reduce((a, v) => a.replaceAll(v, "<s>"), t)
      .replace(/^# render overwrites it\. Federation: (on|off)\.$/m, "");
    const core = (t) => t.replace(/ {2}# Federation on:[\s\S]*?names: \[federation\]\n {8}compress: false\n/, "")
      .replace(/# Federation (on|off):[^\n]*\n(# [^\n]*\n)?(federation_domain_whitelist: \[\]\n)?trusted_key_servers: \[\]\n/, "");
    assert.equal(core(strip(on.hs, on.env)), core(strip(off.hs, off.env)));
    // MAS does not care.
    assert.equal(strip(on.mas, on.env).replace(/"[0-9A-Z]{26}"/g, "<id>"), strip(off.mas, off.env).replace(/"[0-9A-Z]{26}"/g, "<id>"));
  } finally { rmSync(off.home, { recursive: true, force: true }); rmSync(on.home, { recursive: true, force: true }); }
});

test("MAS: the issuer under matrix.<domain>, the site's confidential client, its redirect URI, the admin client", () => {
  const { home, env, mas, caddy } = rendered();
  try {
    assert.equal(env.MATRIX_OAUTH_ISSUER, "https://matrix.example.test/auth/");
    assert.match(mas, /\nhttp:\n {2}public_base: "https:\/\/matrix\.example\.test\/auth\/"\n {2}issuer: "https:\/\/matrix\.example\.test\/auth\/"\n/);
    // Two listeners. The public one (what the router sends /auth/* to) has no admin API: a token
    // from the site client's secret alone may set any account's password, so that secret must not
    // be enough from the internet. The admin API is on the internal one, which nothing routes.
    const listenersOf = [...mas.matchAll(/\n {4}- name: ([a-z]+)\n {6}resources:\n((?: {8}(?:- name: [a-z]+|#[^\n]*)\n)+) {6}binds:\n {8}- address: "([^"]+)"\n/g)]
      .map((m) => ({ name: m[1], resources: [...m[2].matchAll(/- name: ([a-z]+)/g)].map((r) => r[1]), bind: m[3] }));
    assert.deepEqual(listenersOf, [
      { name: "web", resources: ["discovery", "human", "oauth", "compat", "graphql", "assets", "health"], bind: "[::]:8080" },
      { name: "internal", resources: ["health", "adminapi"], bind: "[::]:8081" },
    ]);
    // GraphQL stays public (MAS's own account pages use it) and takes NO OAuth token: MAS's
    // `undocumented_oauth2_access` is off unless set. On a throwaway MAS 1.26 (2026-10-17) a
    // client_credentials token for `urn:mas:graphql:* urn:mas:admin` — the site client's secret alone,
    // at the public token endpoint — got "Invalid token" from /graphql; with the setting on, the SAME
    // token locked an account and set its password. That default is all that stands between the
    // client secret and admin mutations on the internet, so the rendered config never names it.
    assert.doesNotMatch(mas, /undocumented_oauth2_access/);
    assert.doesNotMatch(read("matrix/render.sh"), /undocumented_oauth2_access/);
    assert.deepEqual([...mas.matchAll(/\n {8}- name: graphql\n( {10}\S[^\n]*\n)?/g)].map((m) => m[1] ?? ""), [""], "the graphql resource carries no setting of its own");
    assert.equal(mas.match(/- name: adminapi/g).length, 1, "the admin API on one listener only");
    assert.doesNotMatch(caddy, /mas:8081/, "the router never reaches the internal listener");
    assert.match(read("compose.yaml"), /\n {6}MAS_ADMIN_URL: http:\/\/mas:8081\/api\/admin\/v1\n/, "the site is pointed at it");
    assert.match(mas, new RegExp(`\\nclients:\\n {2}- client_id: "${env.MATRIX_OAUTH_CLIENT_ID}"\\n {4}client_auth_method: client_secret_basic\\n {4}client_secret: "${env.MATRIX_OAUTH_CLIENT_SECRET}"\\n {4}redirect_uris:\\n {6}- "https://example\\.test/api/auth/mas-callback"\\n {4}client_name: "example\\.test"\\n {4}client_uri: "https://example\\.test/"\\n`));
    // The consent screen names the site by its permanent address, never by the client's ULID.
    assert.doesNotMatch(mas, /client_name: "[0-9A-Z]{26}"/);
    assert.match(mas, new RegExp(`\\npolicy:\\n {2}data:\\n {4}admin_clients:\\n {6}- "${env.MATRIX_OAUTH_CLIENT_ID}"\\n`));
    // No database to read the switch or setup's end from (a first render): sign-up is CLOSED.
    assert.match(mas, /\naccount:\n {2}password_registration_enabled: false\n {2}password_registration_email_required: false\n/, "closed until setup is known to be finished");
    assert.match(mas, /\n {2}transport: blackhole\n/, "no outbound mail in this release");
    assert.match(mas, new RegExp(`\\ndatabase:\\n {2}uri: "postgresql://mas:${env.MAS_DB_PASSWORD}@postgres/mas"\\n`));
    assert.match(mas, new RegExp(`\\nmatrix:\\n {2}kind: synapse\\n {2}homeserver: "example\\.test"\\n {2}secret: "${env.MAS_SYNAPSE_SECRET}"\\n {2}endpoint: "http://synapse:8008/"\\n`));
    assert.match(mas, new RegExp(`\\nsecrets:\\n {2}encryption: "${env.MAS_ENCRYPTION_SECRET}"\\n {2}keys:\\n`));
    assert.match(mas, /\n {2}trusted_proxies:\n {4}- "172\.29\.83\.0\/24"\n/, "only the bundle's network may say who the client is");
    // The router: MAS under the issuer's path (stripped), the login endpoints it answers for Synapse.
    assert.match(caddy, /\thandle_path \/auth\/\* \{\n\t\timport upstream mas:8080\n\t\}\n/);
    assert.match(caddy, /\t@mas_compat path \/_matrix\/client\/\*\/login \/_matrix\/client\/\*\/login\/\* \/_matrix\/client\/\*\/logout \/_matrix\/client\/\*\/logout\/\* \/_matrix\/client\/\*\/refresh\n/);
    assert.match(caddy, /\thandle \/_synapse\/client\/\* \{\n\t\timport upstream synapse:8008\n\t\}\n/);
    assert.doesNotMatch(caddy, /_synapse\/(admin|mas)/, "Synapse's admin and MAS-internal APIs stay inside the network");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("sign-up: closed until setup is finished, then the switch `matrix.registration` (unset = closed)", () => {
  // Open sign-up before the operator reaches the community step let anyone claim the community's
  // aliases first (the bootstrap now refuses those rooms, but the install would be stuck).
  const h = fakeHome();
  const cfg = (k, v) => (v === null ? rmSync(path.join(h.fake, "cfg", k), { force: true }) : writeFileSync(path.join(h.fake, "cfg", k), `${v}\n`));
  const reg = () => readFileSync(path.join(h.home, "rendered/mas/config.yaml"), "utf8").match(/\n {2}password_registration_enabled: (true|false)\n/)?.[1];
  const render = (extra = {}) => { const r = h.runWith(extra, "render"); assert.equal(r.status, 0, r.stderr); return reg(); };
  try {
    assert.equal(render(), "false", "setup running: closed");
    cfg("matrix.registration", "open");
    assert.equal(render(), "false", "setup running: closed even when the switch says open");
    cfg("setup.completedAt", "2026-10-10T00:00:00Z");
    cfg("matrix.registration", null);
    assert.equal(render(), "false", "setup finished, no switch: closed — sign-up opens only when the operator says so");
    cfg("matrix.registration", "closed");
    assert.equal(render(), "false", "the switch closes it");
    cfg("matrix.registration", "open");
    assert.equal(render(), "true", "and opens it");
    // The database down: what the last render wrote stands — a restart never flips sign-up.
    assert.equal(render({ FAKE_STATE: "exited" }), "true");
    cfg("matrix.registration", "closed"); assert.equal(render(), "false");
    assert.equal(render({ FAKE_STATE: "exited" }), "false");
    // A value the switch does not know is refused, not read as either.
    cfg("matrix.registration", "maybe");
    const bad = h.run("render");
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /matrix\.registration must be open or closed/);
    assert.equal(reg(), "false", "a failed render replaced nothing");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("Synapse takes uploads up to 20 MB unless MX_MAX_UPLOAD says otherwise; a size it cannot read is refused", () => {
  const home = renderHome();
  try {
    const go = (env) => spawnSync("bash", [path.join(here, "blackbranch"), "render"], { encoding: "utf8", env: { ...process.env, BB_HOME: home, PATH: "/usr/bin:/bin", ...env } });
    const size = () => readFileSync(path.join(home, "rendered/synapse/homeserver.yaml"), "utf8").match(/\nmax_upload_size: "([^"]*)"\n/)?.[1];
    let r = go({}); assert.equal(r.status, 0, r.stderr);
    assert.equal(size(), "20M", "the default: Synapse's own (50M) is more than a chat community needs on one small box");
    r = go({ MX_MAX_UPLOAD: "50M" }); assert.equal(r.status, 0, r.stderr);
    assert.equal(size(), "50M");
    for (const bad of ["lots", "20 M", "-1M", "20T"]) {
      r = go({ MX_MAX_UPLOAD: bad });
      assert.notEqual(r.status, 0, bad); assert.match(r.stderr, /MX_MAX_UPLOAD/, bad);
      assert.equal(size(), "50M", `${bad}: a failed render replaced nothing`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the site's well-known names the homeserver and the issuer the render used", () => {
  const { home, env, hs, mas } = rendered();
  try {
    const doc = clientWellKnown(env.MATRIX_HOMESERVER_URL, env.MATRIX_OAUTH_ISSUER, null);
    assert.equal(`${doc["m.homeserver"].base_url}/`, hs.match(/^public_baseurl: "([^"]+)"$/m)[1]);
    assert.equal(doc["m.authentication"]?.issuer, mas.match(/^ {2}issuer: "([^"]+)"$/m)[1]);
    assert.equal(doc["org.matrix.msc2965.authentication"]?.issuer, env.MATRIX_OAUTH_ISSUER);
    // …and those are the values the site starts with (x-install-values → web).
    const built = read("compose.yaml").match(/x-install-values: &install-values\n((?: {2}[A-Z_]+: .*\n)+)/)[1];
    assert.match(built, /\n {2}MATRIX_HOMESERVER_URL: \$\{MATRIX_HOMESERVER_URL:\?\}\n/);
    assert.match(built, /\n {2}MATRIX_OAUTH_ISSUER: \$\{MATRIX_OAUTH_ISSUER:\?\}\n/);
    assert.match(built, /\n {2}MATRIX_SERVER_NAME: \$\{MATRIX_SERVER_NAME:\?\}\n/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("render refuses what the bundle cannot serve — and a failed render replaces nothing", () => {
  const { home } = rendered();
  try {
    const before = files(home);
    const env0 = readFileSync(path.join(home, ".env"), "utf8");
    const bad = {
      "an issuer on another host": "MATRIX_OAUTH_ISSUER=https://auth.example.test/",
      "an issuer without its trailing slash": "MATRIX_OAUTH_ISSUER=https://matrix.example.test/auth",
      "a server name that is not the domain": "MATRIX_SERVER_NAME=matrix.example.test",
      "a secret with a quote": 'SYNAPSE_FORM_SECRET="ab\\"cd"',
      "an encryption secret of the wrong size": "MAS_ENCRYPTION_SECRET=abcd",
      "a client id that is not a ULID": "MATRIX_OAUTH_CLIENT_ID=not-a-ulid",
      "a site origin that is not https (the consent screen links it)": "SITE_ORIGIN=http://example.test",
    };
    for (const [what, line] of Object.entries(bad)) {
      const key = line.split("=")[0];
      writeFileSync(path.join(home, ".env"), env0.replace(new RegExp(`^${key}=.*$`, "m"), line));
      const r = runRender(home);
      assert.notEqual(r.status, 0, `${what}: render succeeded`);
      assert.deepEqual(files(home), before, `${what}: a failed render changed a file`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the homeserver is core in Compose: pinned pair, rendered config read-only, the users render writes for", () => {
  const src = read("compose.yaml");
  const block = (svc) => src.match(new RegExp(`\\n  ${svc}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|\\nnetworks:)`))?.[1] ?? "";
  const syn = block("synapse"), mas = block("mas");
  assert.match(syn, /image: ghcr\.io\/element-hq\/synapse:v1\.162\.0\n/);
  assert.match(mas, /image: ghcr\.io\/element-hq\/matrix-authentication-service:1\.26\.0\n/);
  assert.match(syn, /- \.\/rendered\/synapse:\/config:ro\n/); assert.match(syn, /- synapse-data:\/data\n/);
  assert.match(syn, /SYNAPSE_CONFIG_PATH: \/config\/homeserver\.yaml\n/);
  assert.match(mas, /- \.\/rendered\/mas:\/config:ro\n/); assert.match(mas, /MAS_CONFIG: \/config\/config\.yaml\n/);
  const bb = read("blackbranch");
  assert.equal(syn.match(/UID: "(\d+)"/)[1], bb.match(/^SYNAPSE_UID=(\d+)$/m)[1]);
  assert.equal(mas.match(/user: "(\d+):\d+"/)[1], bb.match(/^MAS_UID=(\d+)$/m)[1]);
  assert.match(bb, /^LONG_RUNNING=\(postgres stream-api stream-ingest web caddy synapse mas\)$/m);
});

test("rendered/ is root's alone: a host account that shares Synapse's or MAS's uid cannot walk into their secrets", () => {
  // rendered/synapse and rendered/mas belong to the uids their services run as (991, 65532); a host
  // account with one of those uids could read homeserver.yaml through a 755 rendered/. The containers
  // do not need the parent: each is bind-mounted by its own path (Docker, as root, mounts it).
  const home = renderHome();
  try {
    chmodSync(home, 0o755);
    const r = runRender(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(statSync(path.join(home, "rendered")).mode & 0o777, 0o700);
    for (const d of ["synapse", "mas"]) assert.equal(statSync(path.join(home, "rendered", d)).mode & 0o777, 0o700, d);
  } finally { rmSync(home, { recursive: true, force: true }); }
  // The services mount their own folders — caddy too: internet-facing and root in its image, it
  // mounted all of rendered/ and could read Synapse's and MAS's secrets beside its Caddyfile.
  const src = read("compose.yaml");
  assert.match(src, /- \.\/rendered\/synapse:\/config:ro\n/); assert.match(src, /- \.\/rendered\/mas:\/config:ro\n/);
  const caddy = src.match(/\n {2}caddy:\n([\s\S]*?)(?=\n {2}[a-z-]+:\n)/)?.[1] ?? "";
  assert.match(caddy, /\n {4}healthcheck:\n/, "the caddy block was found whole");
  const mounts = [...caddy.matchAll(/\n {6}- (\.\/[^:\n]+):/g)].map((m) => m[1]);
  assert.deepEqual(mounts, ["./rendered/caddy"], "caddy mounts its own folder of rendered/ and nothing else of it");
  assert.doesNotMatch(src, /- \.\/rendered:/, "no service mounts all of rendered/");
  assert.match(read("install.sh"), /getent passwd "\$n"/, "the installer says when a host account already has one of those uids");
});

test("the router's config is in its own folder: render writes rendered/caddy/Caddyfile, root's, and the old one goes once caddy no longer reads it", () => {
  const home = renderHome();
  try {
    mkdirSync(path.join(home, "rendered"), { mode: 0o700 });
    writeFileSync(path.join(home, "rendered/Caddyfile"), "# a box from before\n");
    const r = runRender(home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(path.join(home, "rendered/caddy/Caddyfile"), "utf8"), /import upstream web:3000/);
    assert.equal(statSync(path.join(home, "rendered/caddy")).mode & 0o777, 0o700);
    // `render` leaves the old file: a caddy started before this release still reads it until `up`
    // recreates it with the new mount — and `up` removes it then.
    assert.ok(existsSync(path.join(home, "rendered/Caddyfile")));
    const up = read("blackbranch").match(/\ncmd_up\(\) \{\n([\s\S]*?)\n\}\n/)?.[1] ?? "";
    assert.match(up, /\n {2}info "all services healthy"$/, "the whole of cmd_up was read");
    assert.match(up, /\n {2}compose up -d\n(?: {2}[^\n]*\n)*? {2}rm -f "\$BB_HOME\/rendered\/Caddyfile"\n/, "the old router file goes after everything is started on the new mount");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("namespace: nothing in the bundle sets a legacy prefix or names one", () => {
  const all = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } };
  walk(here);
  assert.ok(all.length >= 15, `vacuity: only ${all.length} files under install/`);
  for (const f of all) {
    const t = readFileSync(f, "utf8");
    // The owner-literal patterns include the legacy Matrix prefix: zero of them anywhere here.
    assert.equal(countLiterals(t, loadConfig()), 0, path.relative(root, f));
    if (f.endsWith(".test.mjs")) continue; // the tests name the setting they forbid
    assert.doesNotMatch(t, /MATRIX_LEGACY_NAMESPACE|legacyNamespace/, path.relative(root, f));
  }
});

// ── The bootstrap, against a fake homeserver ───────────────────────────────────────────────
function fakeHomeserver(server = "example.test", owner = `@admin:${server}`, admin = true) {
  const rooms = new Map(); const aliases = new Map(); const writes = []; const left = []; let n = 0;
  // A room someone else made before the bootstrap ran (an open sign-up, a squatted alias): its
  // m.room.create is THEIRS, with `additional` as its content's additional_creators.
  const plant = (alias, creator, { additional, type, version = "12" } = {}) => {
    const id = `!planted${++n}`;
    const create = { room_version: version, ...(type ? { type } : {}), ...(additional ? { additional_creators: additional } : {}) };
    rooms.set(id, { state: new Map([["m.room.create\u0000", create]]), creator, members: new Set([creator]), body: {}, listed: false });
    if (alias) aliases.set(alias, id);
    return id;
  };
  const srv = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer tok") return send(401, { errcode: "M_UNKNOWN_TOKEN" });
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname).replace("/_matrix/client/v3", "");
    let m;
    if (u === "/account/whoami") return send(200, { user_id: owner });
    if ((m = u.match(/^\/directory\/room\/#([^:]+):(.+)$/))) return aliases.has(m[1]) ? send(200, { room_id: aliases.get(m[1]) }) : send(404, {});
    if (u === "/createRoom" && req.method === "POST") {
      const id = `!room${++n}`;
      const state = new Map([["m.room.create\u0000", { room_version: json.room_version, type: json.creation_content?.type }]]);
      for (const s of json.initial_state ?? []) { state.set(`${s.type}\u0000${s.state_key}`, s.content); writes.push(s.type); }
      writes.push("createRoom", ...Object.keys(json.creation_content ?? {}).map((k) => `creation_content.${k}`));
      rooms.set(id, { state, creator: owner, members: new Set([owner]), body: json, listed: admin && json.visibility === "public" }); aliases.set(json.room_alias_name, id);
      return send(200, { room_id: id });
    }
    // Membership: the owner reads a room's state only while joined (a planted room starts without them).
    if ((m = u.match(/^\/join\/(.+)$/))) { rooms.get(m[1])?.members.add(owner); return send(200, { room_id: m[1] }); }
    if ((m = u.match(/^\/rooms\/([^/]+)\/leave$/))) { rooms.get(m[1])?.members.delete(owner); left.push(m[1]); return send(200, {}); }
    // The whole state as events — the create event's SENDER is only here, never in its content.
    if ((m = u.match(/^\/rooms\/([^/]+)\/state$/)) && req.method === "GET") {
      const room = rooms.get(m[1]); if (!room?.members.has(owner)) return send(403, { errcode: "M_FORBIDDEN" });
      return send(200, [...room.state].map(([k, content]) => {
        const [type, state_key] = k.split("\u0000");
        return { type, state_key, content, sender: type === "m.room.create" ? room.creator : owner, event_id: "$e" };
      }));
    }
    if ((m = u.match(/^\/directory\/list\/room\/(.+)$/))) {
      const room = rooms.get(m[1]); if (!room) return send(404, {});
      if (req.method === "GET") return send(200, { visibility: room.listed ? "public" : "private" });
      if (!admin) return send(403, { errcode: "M_FORBIDDEN" });
      room.listed = json.visibility === "public"; writes.push("directory"); return send(200, {});
    }
    if ((m = u.match(/^\/rooms\/([^/]+)\/state\/([^/]+)(?:\/(.*))?$/))) {
      const room = rooms.get(m[1]); if (!room?.members.has(owner)) return send(403, { errcode: "M_FORBIDDEN" });
      const k = `${m[2]}\u0000${m[3] ?? ""}`;
      if (req.method === "GET") return room.state.has(k) ? send(200, room.state.get(k)) : send(404, {});
      room.state.set(k, json); writes.push(m[2]); return send(200, { event_id: "$e" });
    }
    return send(404, { errcode: "M_UNRECOGNIZED" });
  });
  return { srv, rooms, writes, plant, left };
}
function bootstrap(base, env = {}, token = "tok") {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, "matrix/bootstrap.mjs")],
      { env: { PATH: process.env.PATH, MX_BASE: base, MX_SERVER_NAME: "example.test", MX_SPACE_NAME: "Example Stream", ...env } });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(`${token}\n`);
  });
}

test("bootstrap: creates the space and #general as the owner, idempotently, writing only Matrix's m.* state", async () => {
  const { srv, rooms, writes } = fakeHomeserver();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const first = await bootstrap(base);
    assert.equal(first.code, 0, first.err);
    const ids = JSON.parse(first.out);
    assert.deepEqual(ids.created, ["community space", "#general", "m.space.child", "m.space.parent"]);
    const hub = rooms.get(ids.hub), general = rooms.get(ids.general);
    assert.equal(hub.body.room_version, "12"); assert.equal(general.body.room_version, "12");
    assert.deepEqual(hub.body.creation_content, { type: "m.space" });
    assert.equal(hub.body.name, "Example Stream"); assert.equal(hub.body.room_alias_name, "community-hub");
    assert.equal(general.body.room_alias_name, "general"); assert.equal(general.body.visibility, "public");
    assert.deepEqual(hub.state.get(`m.space.child\u0000${ids.general}`), { via: ["example.test"] });
    assert.deepEqual(general.state.get(`m.space.parent\u0000${ids.hub}`), { via: ["example.test"] });
    assert.deepEqual(general.state.get("m.room.retention\u0000"), { max_lifetime: 30 * 24 * 3600 * 1000 });
    // Run again with the ids recorded, and again with none (found by alias): nothing new.
    const before = writes.length;
    const second = await bootstrap(base, { MX_STORED_HUB: ids.hub, MX_STORED_GENERAL: ids.general });
    assert.equal(second.code, 0, second.err); assert.deepEqual(JSON.parse(second.out).created, []);
    const third = await bootstrap(base);
    assert.equal(third.code, 0, third.err); assert.deepEqual(JSON.parse(third.out), { hub: ids.hub, general: ids.general, created: [] });
    assert.equal(writes.length, before, "a repeat run wrote something");
    // Every state type written is Matrix's own: no site namespace — so none under any prefix.
    const types = writes.filter((w) => w !== "createRoom" && !w.startsWith("creation_content."));
    assert.ok(types.length >= 3, "vacuity: the fake recorded the writes");
    for (const t of types) assert.match(t, /^m\./, `bootstrap wrote ${t}`);
    // A recorded room that is gone is reported, not replaced by a second one…
    const gone = await bootstrap(base, { MX_STORED_HUB: "!gone", MX_STORED_GENERAL: ids.general });
    assert.equal(gone.code, 1); assert.match(gone.err, /the recorded room !gone is gone .* not making a second one silently/);
    assert.equal(rooms.size, 2);
    // …unless asked; then the alias (still there) is reused rather than a duplicate made.
    const re = await bootstrap(base, { MX_STORED_HUB: "!gone", MX_STORED_GENERAL: ids.general, MX_RECREATE: "1" });
    assert.equal(re.code, 0, re.err); assert.equal(JSON.parse(re.out).hub, ids.hub); assert.equal(rooms.size, 2);
    // A token for another server's account, or none, stops it before anything is written.
    const n0 = writes.length;
    assert.equal((await bootstrap(base, {}, "")).code, 1);
    assert.equal((await bootstrap(base, {}, "wrong")).code, 1);
    assert.equal(writes.length, n0);
  } finally { srv.close(); }
});

test("bootstrap lists both rooms in the public room list when it can, and says so when it cannot", async () => {
  // Without admin rights (Synapse's default publication rule), createRoom's visibility is dropped:
  // the run still succeeds, and reports the rooms as unlisted.
  const plain = fakeHomeserver("example.test", "@admin:example.test", false);
  await new Promise((r) => plain.srv.listen(0, "127.0.0.1", r));
  try {
    const r = await bootstrap(`http://127.0.0.1:${plain.srv.address().port}`);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /community space: not in the public room list \(403/);
    assert.ok([...plain.rooms.values()].every((x) => !x.listed));
  } finally { plain.srv.close(); }
  // With them: created listed; a room found by alias that is not listed gets listed, once.
  const adm = fakeHomeserver();
  await new Promise((r) => adm.srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${adm.srv.address().port}`;
  try {
    const first = JSON.parse((await bootstrap(base)).out);
    assert.ok([...adm.rooms.values()].every((x) => x.listed), "both rooms listed at creation");
    assert.ok(!first.created.some((c) => c.startsWith("listed")), "createRoom listed them; no second write");
    adm.rooms.get(first.general).listed = false;
    const again = await bootstrap(base);
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(JSON.parse(again.out).created, ["listed #general"]);
    assert.deepEqual(JSON.parse((await bootstrap(base)).out).created, [], "a third run writes nothing");
  } finally { adm.srv.close(); }
});

test("bootstrap refuses a token that belongs to another server's account", async () => {
  const { srv, rooms } = fakeHomeserver("example.test", "@admin:elsewhere.test");
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await bootstrap(`http://127.0.0.1:${srv.address().port}`);
    assert.equal(r.code, 1); assert.match(r.err, /not an account on example\.test/); assert.equal(rooms.size, 0);
  } finally { srv.close(); }
});

test("bootstrap refuses rooms it did not create: a squatted alias, a recorded room someone else made", async () => {
  // Before the registration switch, sign-up was open before the operator reached the community
  // step: anyone could make #community-hub and #general first and link them. Room v12 creators can
  // never be demoted, so adopting those rooms would hand the community to whoever made them.
  const { srv, rooms, writes, plant, left } = fakeHomeserver();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const evilHub = plant("community-hub", "@mallory:example.test", { type: "m.space" });
    const evilGeneral = plant("general", "@mallory:example.test");
    rooms.get(evilHub).state.set(`m.space.child\u0000${evilGeneral}`, { via: ["example.test"] });
    rooms.get(evilGeneral).state.set(`m.space.parent\u0000${evilHub}`, { via: ["example.test"] });
    const r = await bootstrap(base);
    assert.equal(r.code, 1, "adopted a room someone else made");
    assert.equal(r.out, "", "recorded nothing");
    assert.match(r.err, /#community-hub:example\.test is .* made by @mallory:example\.test, not by @admin:example\.test/);
    assert.match(r.err, /remove the alias/i, "the operator is told what to do");
    assert.equal(rooms.size, 2, "made no room of its own either"); assert.deepEqual(writes, []);
    assert.deepEqual(left, [evilHub], "and did not stay in it");
    // The same check holds for a room already recorded (an install that adopted one before this
    // fix — and joined it, as the old bootstrap did).
    rooms.get(evilHub).members.add("@admin:example.test");
    const stored = await bootstrap(base, { MX_STORED_HUB: evilHub });
    assert.equal(stored.code, 1); assert.match(stored.err, /made by @mallory:example\.test/);
  } finally { srv.close(); }
  // Only a room the owner is the SOLE creator of is theirs. Naming the owner among the additional
  // creators does not make it theirs: the one who made it stays a creator too, for good.
  const shared = fakeHomeserver();
  await new Promise((r) => shared.srv.listen(0, "127.0.0.1", r));
  try {
    shared.plant("community-hub", "@mallory:example.test", { type: "m.space", additional: ["@admin:example.test"] });
    const co = await bootstrap(`http://127.0.0.1:${shared.srv.address().port}`);
    assert.equal(co.code, 1, "adopted a room with a foreign co-creator"); assert.equal(co.out, "");
    assert.match(co.err, /made by @mallory:example\.test, not by @admin:example\.test/); assert.match(co.err, /remove the alias/i);
  } finally { shared.srv.close(); }
  // A room of another version has another creator model (before v12 a creator's power can be
  // taken away and others can hold more): refused even when the owner made it.
  const old = fakeHomeserver();
  await new Promise((r) => old.srv.listen(0, "127.0.0.1", r));
  try {
    old.plant("community-hub", "@admin:example.test", { type: "m.space", version: "11" });
    const v11 = await bootstrap(`http://127.0.0.1:${old.srv.address().port}`);
    assert.equal(v11.code, 1, "adopted a room of another version"); assert.equal(v11.out, "");
    assert.match(v11.err, /room version 11, not 12/); assert.match(v11.err, /remove the alias/i);
  } finally { old.srv.close(); }
  // Vacuity: the owner's own v12 room, planted the same way, IS adopted — the refusals above are
  // about who made it and its version, not about planting.
  const mine = fakeHomeserver();
  await new Promise((r) => mine.srv.listen(0, "127.0.0.1", r));
  try {
    const hub = mine.plant("community-hub", "@admin:example.test", { type: "m.space", additional: ["@admin:example.test"] });
    const ok = await bootstrap(`http://127.0.0.1:${mine.srv.address().port}`);
    assert.equal(ok.code, 0, ok.err); assert.equal(JSON.parse(ok.out).hub, hub);
  } finally { mine.srv.close(); }
});
