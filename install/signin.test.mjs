// Sign-in providers (ADR 0154): the owner picks Google, Discord, Twitch and one OpenID Connect server
// in the Admin Panel; the host renders each one switched on into the sign-in service's config.
//   schema       — four slots, each a switch and its credentials; each slot's fixed provider id
//   signin.cjs   — the host reads the signin.* keys inside the stream-api image (secrets decrypted
//                  with stream-api's own key), as it reads the mail settings (host-settings.cjs)
//   render.sh    — MAS's `upstream_oauth2.providers`, one entry per slot switched on and complete
//   blackbranch  — the render, a restart with the database down (keeps the last read), a retry with a
//                  slot switched off; the doctor's facts
// Nothing real is called: the host command runs on a scratch home with stand-ins (scratch-home.mjs).
// What MAS itself makes of the rendered file (it accepts it, draws the buttons, a slot switched off
// leaves the sign-in page) was run on the throwaway pair: vault systems/sign-in-providers.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome, renderHome } from "./scratch-home.mjs";
import { DOCTOR } from "../config/doctor.mjs";
import { INSTANCE_KEYS as SCHEMA, signinProviderId } from "../config/instance-schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const { INSTANCE_KEYS } = createRequire(import.meta.url)(path.join(root, "stream-api/instanceSchema.generated.js"));

// The provider ids MAS keys each fixed-issuer slot by — and every person's link to it. They are
// written here as literals on purpose: changing one orphans every account that signed in through it.
// The OpenID slot's id is derived from its issuer (one server, one id), pinned here for one issuer.
const ISSUER = "https://id.example.test/application/o/site/";
const IDS = { google: "01M6W7E48RDHCVFV08SQ68SZTB", discord: "01M6W7E48SQRP7WM6CF3PM0QQH", twitch: "01M6W7E48SP2C7JKD41P73GKF0", oidc: signinProviderId("oidc", ISSUER) };
const SLOTS = ["google", "discord", "twitch", "oidc"];
const FIXED = ["google", "discord", "twitch"];

// ── the schema ────────────────────────────────────────────────────────────────────────────────
test("four slots, each a switch and its credentials; secrets are stream-api's alone; every key is host-rendered", () => {
  const keys = SCHEMA.filter((e) => e.key.startsWith("signin."));
  assert.deepEqual(keys.map((e) => e.key), [
    "signin.google.enabled", "signin.google.clientId", "signin.discord.enabled", "signin.discord.clientId",
    "signin.twitch.enabled", "signin.twitch.clientId", "signin.oidc.enabled", "signin.oidc.issuer", "signin.oidc.clientId", "signin.oidc.humanName",
    "signin.google.clientSecret", "signin.discord.clientSecret", "signin.twitch.clientSecret", "signin.oidc.clientSecret",
  ]);
  for (const e of keys) {
    assert.equal(e.hostRendered, true, e.key); assert.equal(e.reload, "restart", e.key); assert.equal(e.module, "core", e.key);
    const slot = e.key.split(".")[1];
    assert.match(e.env[0], new RegExp(`^SIGNIN_${slot.toUpperCase()}_[A-Z_]+$`), e.key);
    if (e.key.endsWith(".clientSecret")) {
      assert.deepEqual([e.tier, e.secret, e.kind, e.packages], ["secret", true, "secret", ["stream-api"]], `${e.key}: the site never receives it`);
    } else assert.deepEqual([e.tier, e.secret, e.packages], ["instance", false, ["web"]], e.key);
  }
  for (const s of SLOTS) {
    const sw = keys.find((e) => e.key === `signin.${s}.enabled`);
    assert.deepEqual([sw.kind, sw.default], ["bool", false], `${s}: off until the owner switches it on`);
  }
  for (const s of FIXED) {
    const sw = keys.find((e) => e.key === `signin.${s}.enabled`);
    assert.equal(sw.upstreamId, IDS[s], `${s}: the provider id never changes`);
    assert.match(sw.upstreamId, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, `${s}: a ULID`);
    assert.equal(signinProviderId(s, "https://anything.test/"), IDS[s], `${s}: its issuer is fixed, so is its id`);
  }
  assert.equal(new Set(Object.values(IDS)).size, 4);
  assert.deepEqual(SCHEMA.filter((e) => e.upstreamId).map((e) => e.key), FIXED.map((s) => `signin.${s}.enabled`),
    "only the fixed-issuer switches carry an id: the OpenID slot's issuer is the owner's to change");
  // The generated copies carry the same entries (check:instance-schema holds them byte for byte).
  assert.deepEqual(INSTANCE_KEYS.filter((e) => e.key.startsWith("signin.")).map((e) => [e.key, e.upstreamId ?? null]), keys.map((e) => [e.key, e.upstreamId ?? null]));
});

test("the OpenID slot's id follows its server: issuer A then issuer B → different ids (no inherited links); the same server twice → the same id", () => {
  const a = signinProviderId("oidc", "https://idp-a.example.test/realms/site/");
  const b = signinProviderId("oidc", "https://idp-b.example.test/realms/site/");
  assert.match(a, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/); assert.match(b, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.notEqual(a, b, "a new server starts with no links");
  assert.notEqual(a, signinProviderId("oidc", "https://idp-a.example.test/realms/other"), "another realm on one host is another server");
  // One server however it is typed: the trailing /, the host's case, whitespace.
  for (const same of ["https://idp-a.example.test/realms/site/", "https://idp-a.example.test/realms/site", " https://IDP-A.example.test/realms/site// "]) {
    assert.equal(signinProviderId("oidc", same), a, same);
  }
  assert.equal(signinProviderId("oidc", ""), null); assert.equal(signinProviderId("oidc", null), null);
  assert.equal(signinProviderId("oidc", "http://idp-a.example.test/"), null, "no id for an address the sign-in service refuses");
  assert.notEqual(a, IDS.google); assert.notEqual(signinProviderId("oidc", "https://accounts.google.com"), IDS.google);
  // The SHA-256 written out in the schema (the site's pages run it) agrees with node's own, across
  // lengths that cross the 64-byte block edge.
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const ref = (iss) => {
    const u = new URL(iss);
    let n = BigInt(`0x${createHash("sha256").update(`blackbranch-signin-oidc\n${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`).digest("hex").slice(0, 32)}`);
    let id = "";
    for (let i = 0; i < 26; i++) { id = A[Number(n & 31n)] + id; n >>= 5n; }
    return id;
  };
  for (let k = 0; k < 200; k++) {
    const iss = `https://idp.example.test/${"x".repeat(k)}`;
    assert.equal(signinProviderId("oidc", iss), ref(iss), `length ${k}`);
  }
  // Pinned for one issuer: a change to the derivation would move every install's OpenID links.
  assert.equal(signinProviderId("oidc", "https://idp-a.example.test/realms/site/"), "71FRZ9JFR5J1QDN1P72HH6CMB9");
});

// ── signin.cjs ────────────────────────────────────────────────────────────────────────────────
function fakeApp(rows) {
  const app = mkdtempSync(path.join(tmpdir(), "bb-app-"));
  for (const f of ["instance-config.js", "instanceSchema.generated.js"]) copyFileSync(path.join(root, "stream-api", f), path.join(app, f));
  mkdirSync(path.join(app, "node_modules/pg"), { recursive: true });
  writeFileSync(path.join(app, "node_modules/pg/index.js"), `const rows = ${JSON.stringify(rows)};
class Pool { async query(sql) { return { rows: sql.includes("instance_secrets") ? rows.secrets : rows.config }; } async end() {} }
module.exports = { Pool };\n`);
  return app;
}
const runReader = (app, env) => spawnSync(process.execPath, [path.join(here, "matrix/signin.cjs")], { encoding: "utf8", env: { PATH: process.env.PATH, BB_APP_DIR: app, ...env } });
const lines = (out) => Object.fromEntries(out.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
/** A ULID as the uuid MAS stores it under (its 128 bits as hex). */
const uuidOf = (ulid) => {
  let n = 0n;
  for (const c of ulid) n = n * 32n + BigInt("0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(c));
  const h = n.toString(16).padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

test("signin.cjs resolves every signin.* key as stream-api would, decrypting the secrets, and names each slot's id", () => {
  const mk = randomBytes(32);
  const { encryptSecret } = createRequire(import.meta.url)(path.join(root, "stream-api/instance-config.js"));
  const app = fakeApp({
    config: [{ key: "signin.discord.enabled", value: true }, { key: "signin.discord.clientId", value: "1234567890" },
      { key: "signin.oidc.enabled", value: true }, { key: "signin.oidc.issuer", value: ISSUER }, { key: "signin.oidc.clientId", value: "site" }],
    secrets: [{ key: "signin.discord.clientSecret", ciphertext: encryptSecret("signin.discord.clientSecret", "d'secret\"x", mk) },
      { key: "signin.oidc.clientSecret", ciphertext: encryptSecret("signin.oidc.clientSecret", "o-secret", mk) }],
  });
  try {
    let r = runReader(app, { INSTANCE_MASTER_KEY: mk.toString("hex") });
    assert.equal(r.status, 0, r.stderr);
    const v = lines(r.stdout);
    assert.deepEqual(Object.keys(v).sort(), SLOTS.flatMap((s) => {
      const P = `MX_SIGNIN_${s.toUpperCase()}`;
      return [`${P}_ON`, `${P}_ID`, `${P}_UUID`, `${P}_CLIENT_ID`, `${P}_CLIENT_SECRET`, ...(s === "oidc" ? [`${P}_ISSUER`, `${P}_NAME`] : [])];
    }).sort());
    assert.equal(v.MX_SIGNIN_GOOGLE_ON, "false"); assert.equal(v.MX_SIGNIN_GOOGLE_CLIENT_ID, "");
    assert.equal(v.MX_SIGNIN_DISCORD_ON, "true"); assert.equal(v.MX_SIGNIN_DISCORD_CLIENT_SECRET, "d'secret\"x");
    assert.equal(v.MX_SIGNIN_OIDC_ISSUER, "https://id.example.test/application/o/site/", "the issuer as typed: MAS compares it byte for byte");
    for (const s of SLOTS) {
      assert.equal(v[`MX_SIGNIN_${s.toUpperCase()}_ID`], IDS[s]);
      assert.equal(v[`MX_SIGNIN_${s.toUpperCase()}_UUID`], uuidOf(IDS[s]));
    }
    // Another OpenID server (a new address): another id, so it inherits none of the first one's links.
    r = runReader(app, { INSTANCE_MASTER_KEY: mk.toString("hex"), SIGNIN_OIDC_ISSUER: "https://idp-b.example.test/" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines(r.stdout).MX_SIGNIN_OIDC_ID, signinProviderId("oidc", "https://idp-b.example.test/"));
    assert.notEqual(lines(r.stdout).MX_SIGNIN_OIDC_ID, IDS.oidc);
    // No address yet: no id (the render then leaves the slot out).
    const bare = fakeApp({ config: [{ key: "signin.oidc.enabled", value: true }], secrets: [] });
    try {
      const v2 = lines(runReader(bare, {}).stdout);
      assert.deepEqual([v2.MX_SIGNIN_OIDC_ID, v2.MX_SIGNIN_OIDC_UUID], ["", ""]);
    } finally { rmSync(bare, { recursive: true, force: true }); }
    // env > database, as everywhere else.
    r = runReader(app, { INSTANCE_MASTER_KEY: mk.toString("hex"), SIGNIN_GOOGLE_ENABLED: "true", SIGNIN_GOOGLE_CLIENT_ID: "g.apps.example" });
    assert.match(r.stdout, /^MX_SIGNIN_GOOGLE_ON=true$/m); assert.match(r.stdout, /^MX_SIGNIN_GOOGLE_CLIENT_ID=g\.apps\.example$/m);
    // A secret that does not decrypt is an error, never an empty value.
    r = runReader(app, { INSTANCE_MASTER_KEY: randomBytes(32).toString("hex") });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /signin\.(discord|oidc)\.clientSecret does not decrypt/); assert.equal(r.stdout, "");
  } finally { rmSync(app, { recursive: true, force: true }); }
});

// ── render.sh: MAS's upstream providers ───────────────────────────────────────────────────────
const ON = {
  MX_SIGNIN_GOOGLE_ON: "true", MX_SIGNIN_GOOGLE_ID: IDS.google, MX_SIGNIN_GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com", MX_SIGNIN_GOOGLE_CLIENT_SECRET: "g'sec\"ret",
  MX_SIGNIN_DISCORD_ON: "true", MX_SIGNIN_DISCORD_ID: IDS.discord, MX_SIGNIN_DISCORD_CLIENT_ID: "1234567890123", MX_SIGNIN_DISCORD_CLIENT_SECRET: "dsec",
  MX_SIGNIN_TWITCH_ON: "true", MX_SIGNIN_TWITCH_ID: IDS.twitch, MX_SIGNIN_TWITCH_CLIENT_ID: "abcdef0123", MX_SIGNIN_TWITCH_CLIENT_SECRET: "tsec",
  MX_SIGNIN_OIDC_ON: "true", MX_SIGNIN_OIDC_ID: IDS.oidc, MX_SIGNIN_OIDC_CLIENT_ID: "site", MX_SIGNIN_OIDC_CLIENT_SECRET: "osec",
  MX_SIGNIN_OIDC_ISSUER: ISSUER, MX_SIGNIN_OIDC_NAME: "Our members' login",
};
function renderMas(extraEnv) {
  const env = {
    PATH: "/usr/bin:/bin", MX_ISSUER: "https://matrix.example.test/auth/", MX_SERVER_NAME: "example.test", MX_MAS_DB_URI: "postgresql://mas:pw@postgres/mas",
    MX_MAIL_FROM: "noreply@example.test", MX_CLIENT_ID: "00000000000000000000000000", MX_CLIENT_SECRET: "secret", MX_REDIRECT_URI: "https://example.test/api/auth/mas-callback",
    MX_SYNAPSE_ENDPOINT: "http://synapse:8008/", MX_MAS_SECRET: "s", MX_ENCRYPTION_SECRET: "e".repeat(64), MX_REGISTRATION: "open", ...extraEnv,
  };
  const home = renderHome();
  try {
    env.MX_MAS_KEYS_FILE = path.join(home, "matrix/mas-keys.yaml");
    return spawnSync("bash", ["-c", `. "${path.join(here, "matrix/render.sh")}"; mx_render_mas`], { encoding: "utf8", env });
  } finally { rmSync(home, { recursive: true, force: true }); }
}
/** The provider entry rendered for one id, as text (from its `- id:` line to the next entry or the block's end). */
const entry = (yaml, id) => {
  const at = yaml.indexOf(`    - id: "${id}"\n`);
  if (at < 0) return null;
  const rest = yaml.slice(at);
  const end = rest.slice(1).search(/\n {4}- id: |\n[a-z#]/);
  return rest.slice(0, end < 0 ? undefined : end + 2);
};

test("no slot switched on: no upstream block at all — MAS offers only its own password sign-in, as before", () => {
  const r = renderMas({});
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /upstream_oauth2|upstream\/callback/);
  const off = renderMas({ ...ON, MX_SIGNIN_GOOGLE_ON: "false", MX_SIGNIN_DISCORD_ON: "false", MX_SIGNIN_TWITCH_ON: "false", MX_SIGNIN_OIDC_ON: "false" });
  assert.equal(off.status, 0, off.stderr);
  assert.doesNotMatch(off.stdout, /upstream_oauth2/, "credentials alone switch nothing on");
  assert.doesNotMatch(off.stdout, /g'sec|dsec|tsec|osec/, "a slot switched off leaves no secret in the file");
});

test("every slot switched on: one provider each, in a fixed order, under its fixed id, before the secrets", () => {
  const r = renderMas(ON);
  assert.equal(r.status, 0, r.stderr);
  const y = r.stdout;
  assert.match(y, /\nupstream_oauth2:\n {2}providers:\n {4}- id: /);
  const order = SLOTS.map((s) => y.indexOf(`- id: "${IDS[s]}"`));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), "Google, Discord, Twitch, then the OpenID server");
  assert.ok(y.indexOf("\nupstream_oauth2:") < y.indexOf("\nsecrets:"), "the block sits in MAS's top level, before the keys");

  const g = entry(y, IDS.google);
  assert.equal(g, [
    `    - id: "${IDS.google}"`,
    `      human_name: 'Google'`,
    `      brand_name: google`,
    `      issuer: "https://accounts.google.com"`,
    `      client_id: "123-abc.apps.googleusercontent.com"`,
    `      client_secret: 'g''sec"ret'`,
    `      token_endpoint_auth_method: client_secret_post`,
    `      scope: "openid profile email"`,
    `      registration_token_required: false`,
    `      claims_imports:`,
    `        localpart:`,
    `          action: ignore`,
    `        displayname:`,
    `          action: ignore`,
    `        email:`,
    `          action: ignore`,
    `        account_name:`,
    `          template: "{{ user.email }}"`,
    ``].join("\n"));

  const d = entry(y, IDS.discord);
  assert.match(d, /\n {6}human_name: 'Discord'\n {6}brand_name: discord\n {6}issuer: "https:\/\/discord\.com"\n/);
  assert.match(d, /\n {6}scope: "openid identify email"\n/);
  // Discord's user name and its chosen display name come from its own API, not the id token.
  assert.match(d, /\n {6}fetch_userinfo: true\n {6}userinfo_endpoint: "https:\/\/discord\.com\/api\/users\/@me"\n/);
  assert.match(d, /\n {8}localpart:\n {10}action: suggest\n {10}template: "\{\{ user\.username \}\}"\n/);
  assert.match(d, /\n {8}displayname:\n {10}action: suggest\n {10}template: "\{\{ user\.global_name \}\}"\n/);
  // No address is imported from any provider: MAS stores an imported address as verified whatever the
  // provider said, so the person adds one on their account page and MAS checks it itself.
  for (const s of SLOTS) assert.match(entry(y, IDS[s]), /\n {8}email:\n {10}action: ignore\n {8}account_name:\n/, `${s}: no address imported`);
  // No rendered template decides anything from a provider claim (a template's truthiness is not a check).
  const templates = [...y.matchAll(/^ {10}template: (.*)$/gm)].map((m) => m[1]);
  assert.ok(templates.length >= 10, `vacuity: ${templates.length} templates read`);
  for (const t of templates) assert.doesNotMatch(t, /\{%|\bif\b|\belse\b|\bis\b|==/, t);

  const t = entry(y, IDS.twitch);
  assert.match(t, /\n {6}human_name: 'Twitch'\n {6}issuer: "https:\/\/id\.twitch\.tv\/oauth2"\n/);
  assert.doesNotMatch(t, /brand_name/, "MAS draws no Twitch logo");
  assert.match(t, /\n {6}token_endpoint_auth_method: client_secret_post\n {6}scope: "openid user:read:email"\n/);
  // Twitch puts its user name and address in the id token only when asked for them by name.
  assert.match(t, /\n {6}additional_authorization_parameters:\n {8}claims: '\{"id_token":\{"preferred_username":null,"email":null,"email_verified":null\}\}'\n/);
  assert.match(t, /\n {8}localpart:\n {10}action: suggest\n {10}template: "\{\{ user\.preferred_username \| lower \}\}"\n/);

  const o = entry(y, IDS.oidc);
  assert.match(o, /\n {6}human_name: 'Our members'' login'\n {6}issuer: "https:\/\/id\.example\.test\/application\/o\/site\/"\n/);
  assert.match(o, /\n {6}token_endpoint_auth_method: client_secret_basic\n {6}scope: "openid profile email"\n/);
  assert.match(o, /\n {8}localpart:\n {10}action: suggest\n {10}template: "\{\{ user\.preferred_username \}\}"\n/);

  for (const s of SLOTS) {
    const e = entry(y, IDS[s]);
    // A name the provider suggests is only ever SUGGESTED: an existing account is never taken over by it.
    assert.doesNotMatch(e, /action: (force|require)|on_conflict/, `${s}: never forces a user name`);
    assert.match(e, /\n {6}registration_token_required: false\n/, `${s}: sign-up open, new accounts allowed`);
  }
});

test("sign-up closed: a provider still signs people in, but makes no new account without an invitation token", () => {
  const r = renderMas({ ...ON, MX_REGISTRATION: "closed" });
  assert.equal(r.status, 0, r.stderr);
  for (const s of SLOTS) assert.match(entry(r.stdout, IDS[s]), /\n {6}registration_token_required: true\n/, s);
});

test("the OpenID server's button: its own name, else the issuer's host", () => {
  const r = renderMas({ ...ON, MX_SIGNIN_OIDC_NAME: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(entry(r.stdout, IDS.oidc), /\n {6}human_name: 'id\.example\.test'\n/);
});

test("a slot that cannot render is left out and says why; the rest of the sign-in service still renders", () => {
  const cases = [
    ["MX_SIGNIN_GOOGLE_CLIENT_ID", "", "google", /Google sign-in is on but has no client id/],
    ["MX_SIGNIN_GOOGLE_CLIENT_SECRET", "", "google", /Google sign-in is on but has no client secret/],
    ["MX_SIGNIN_DISCORD_CLIENT_ID", 'a"b', "discord", /Discord sign-in: the client id/],
    ["MX_SIGNIN_TWITCH_CLIENT_SECRET", "two\nlines", "twitch", /Twitch sign-in: the client secret holds a line break/],
    ["MX_SIGNIN_OIDC_ISSUER", "", "oidc", /OpenID sign-in is on but has no address/],
    ["MX_SIGNIN_OIDC_ISSUER", "ftp://id.example.test/", "oidc", /OpenID sign-in: the address must start with https:\/\//],
    // MAS 1.26 refuses to discover an http:// issuer ("issuer's URL doesn't use a https scheme"): left out, not a broken button.
    ["MX_SIGNIN_OIDC_ISSUER", "http://id.example.test/", "oidc", /OpenID sign-in: the address must start with https:\/\//],
    // ... also with the empty id signin.cjs gives an address it cannot derive one from.
    ["MX_SIGNIN_OIDC_ISSUER", "http://id.example.test/", "oidc", /OpenID sign-in: the address must start with https:\/\//, { MX_SIGNIN_OIDC_ID: "" }],
    ["MX_SIGNIN_OIDC_ISSUER", "https://id.example.test/\"x", "oidc", /OpenID sign-in: the address/],
    ["MX_SIGNIN_OIDC_NAME", "a\nb", "oidc", /OpenID sign-in: the button's name holds a line break/],
    ["MX_SIGNIN_TWITCH_ID", "not-a-ulid", "twitch", /Twitch sign-in: its provider id is not a ULID/],
  ];
  for (const [k, v, slot, says, more = {}] of cases) {
    const r = renderMas({ ...ON, [k]: v, ...more });
    assert.equal(r.status, 0, `${k}=${JSON.stringify(v)}: ${r.stderr}`);
    assert.match(r.stderr, says, k);
    assert.doesNotMatch(r.stderr, k === "MX_SIGNIN_TWITCH_ID" ? /^$/ : /not a ULID/, `${k}: the real reason, not a missing id`);
    assert.equal(entry(r.stdout, IDS[slot]), null, `${k}: ${slot} left out`);
    for (const other of SLOTS.filter((s) => s !== slot)) assert.notEqual(entry(r.stdout, IDS[other]), null, `${k}: ${other} still offered`);
    assert.match(r.stdout, /\nsecrets:\n/, `${k}: the rest rendered`);
  }
  // Every slot unusable: no block at all, never an empty provider list.
  const none = renderMas({ ...ON, MX_SIGNIN_GOOGLE_CLIENT_ID: "", MX_SIGNIN_DISCORD_CLIENT_ID: "", MX_SIGNIN_TWITCH_CLIENT_ID: "", MX_SIGNIN_OIDC_CLIENT_ID: "" });
  assert.equal(none.status, 0); assert.doesNotMatch(none.stdout, /upstream_oauth2/);
});

// ── the host: render, restart, retry ──────────────────────────────────────────────────────────
const SIGNIN_OUT = (on) => [
  ...SLOTS.flatMap((s) => {
    const P = `MX_SIGNIN_${s.toUpperCase()}`;
    const v = on.includes(s);
    return [`${P}_ON=${v}`, `${P}_ID=${IDS[s]}`, `${P}_UUID=${uuidOf(IDS[s])}`, `${P}_CLIENT_ID=${v ? `${s}-client` : ""}`, `${P}_CLIENT_SECRET=${v ? `${s}-secret` : ""}`,
      ...(s === "oidc" ? [`${P}_ISSUER=${v ? ISSUER : ""}`, `${P}_NAME=`] : [])];
  }), ""].join("\n");

test("render gives MAS the slots switched on; with the database down (restart) it keeps the last ones read; a slot switched off leaves MAS's config", () => {
  const h = fakeHome();
  try {
    const mas = () => readFileSync(path.join(h.home, "rendered/mas/config.yaml"), "utf8");
    writeFileSync(path.join(h.fake, "signin-out"), SIGNIN_OUT(["google", "discord"]));
    let r = h.run("render");
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(entry(mas(), IDS.google), null); assert.notEqual(entry(mas(), IDS.discord), null); assert.equal(entry(mas(), IDS.twitch), null);
    assert.match(h.calls(), /--entrypoint node stream-api \/bb-matrix\/signin\.cjs/);
    const cache = path.join(h.home, "state/signin.env");
    assert.equal(statSync(cache).mode & 0o777, 0o600, "the cached secrets are root's alone");
    // A restart before the database is up: the render keeps the providers it had (people can still sign in).
    rmSync(path.join(h.fake, "signin-out"));
    r = h.runWith({ FAKE_UNHEALTHY: "postgres" }, "render");
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(entry(mas(), IDS.google), null, "kept from the last settings read");
    // Retry with the database back and Google switched off: the render follows the settings, and the
    // old secret leaves the cache.
    writeFileSync(path.join(h.fake, "signin-out"), SIGNIN_OUT(["discord"]));
    r = h.run("render");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(entry(mas(), IDS.google), null); assert.notEqual(entry(mas(), IDS.discord), null);
    assert.doesNotMatch(readFileSync(cache, "utf8"), /google-secret/);
    // Settings that cannot be read (a secret that does not decrypt): the render goes on with the last read.
    writeFileSync(path.join(h.fake, "signin-out"), "");
    writeFileSync(path.join(h.fake, "signin-status"), "1");
    r = h.run("render");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /keeping the sign-in providers read last/);
    assert.notEqual(entry(mas(), IDS.discord), null);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// MAS takes a provider that left its config out of the sign-in page at its next start (it marks it
// disabled), and keeps every person's link to it, so switching the slot back on gives them their sign-in
// back. `config sync --prune` would DELETE the provider and every link with it (MAS 1.26
// storage-pg upstream_oauth2/provider.rs delete_by_id): nothing here ever runs it.
test("switching a slot off never prunes: no host command deletes a provider or its links", () => {
  const bb = read("blackbranch"), render = read("matrix/render.sh");
  for (const [name, src] of [["blackbranch", bb], ["render.sh", render]]) assert.doesNotMatch(src.replace(/^\s*#.*$/gm, ""), /--prune/, name);
  // Vacuity: both files were read to their end.
  assert.match(bb, /\n {2}\*\) die "unknown command \\"\$cmd\\" \(blackbranch help\)" ;;\nesac\n$/);
  assert.match(render, /\n\t\trespond 404\n\t\}\nEOF\n\}\n$/);
});

// ── the doctor ────────────────────────────────────────────────────────────────────────────────
test("the host's facts: each slot on, complete, listed by MAS and answering — never a secret or a client id", () => {
  const h = fakeHome();
  try {
    mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
    writeFileSync(path.join(h.fake, "signin-out"), SIGNIN_OUT(["google", "oidc"]));
    assert.equal(h.run("render").status, 0);
    // MAS lists Google (enabled) and nothing else; the discovery answers come from inside stream-api.
    writeFileSync(path.join(h.fake, "mas-providers"), `${uuidOf(IDS.google)}\n`);
    writeFileSync(path.join(h.fake, "signin-discovery"), JSON.stringify({ google: { status: 200, issuer: true }, oidc: { status: 200, issuer: false } }));
    h.runWith({ BB_DOCTOR_NODE: process.execPath }, "doctor");
    const facts = JSON.parse(readFileSync(path.join(h.home, "results/doctor-host.json"), "utf8"));
    assert.deepEqual(facts.signin, { read: true, slots: {
      google: { on: true, complete: true, listed: true, discovery: { status: 200, issuer: true } },
      discord: { on: false, complete: false, listed: false, discovery: null },
      twitch: { on: false, complete: false, listed: false, discovery: null },
      oidc: { on: true, complete: true, listed: false, discovery: { status: 200, issuer: false } },
    } });
    const txt = JSON.stringify(facts);
    assert.doesNotMatch(txt, /-secret|-client/, "no secret and no client id in the facts");
    // The issuer travels to the check as an argument (not secret), the secrets never do.
    assert.doesNotMatch(h.calls(), /google-secret|oidc-secret/);
    // MAS's view: its own table, read-only.
    assert.match(h.calls(), /compose exec -T postgres psql -U postgres -d mas/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("doctor rows: grey off, red incomplete / not offered / not answering / a different issuer, ok offered and answering", () => {
  const facts = (slot) => ({ signin: { read: true, slots: { google: { on: false, complete: false, listed: false, discovery: null }, discord: { on: false, complete: false, listed: false, discovery: null },
    twitch: { on: false, complete: false, listed: false, discovery: null }, oidc: { on: false, complete: false, listed: false, discovery: null }, ...slot } } });
  const row = (host, id = "signin.google") => DOCTOR.evaluate({ host: { v: 1, at: "2026-10-10T00:00:00Z", ...host }, hostState: "ok", site: null, siteError: "x" }).find((r) => r.id === id);
  assert.deepEqual(DOCTOR.CHECKS.filter((c) => c.id.startsWith("signin.")).map((c) => [c.id, c.area, c.side]),
    SLOTS.map((s) => [`signin.${s}`, "Matrix", "host"]));
  assert.equal(row({}).status, "grey", "an older host's facts: not checked");
  assert.equal(row({ signin: { read: false } }).status, "grey");
  assert.deepEqual([row(facts({})).status, row(facts({})).detail], ["grey", "off"]);
  const on = { on: true, complete: true, listed: true, discovery: { status: 200, issuer: true } };
  assert.deepEqual([row(facts({ google: on })).status, row(facts({ google: on })).detail], ["ok", "on the sign-in page, and Google answers"]);
  assert.match(row(facts({ oidc: { ...on } }), "signin.oidc").detail, /^on the sign-in page, and your OpenID server answers$/);
  const red = [
    [{ ...on, complete: false }, /^on, but its client id or secret is not set or not usable: nobody sees the button$/],
    [{ ...on, listed: false }, /^on, but the sign-in service does not offer it yet$/],
    [{ ...on, discovery: { status: 0, issuer: null } }, /^on the sign-in page, but Google does not answer this server$/],
    [{ ...on, discovery: { status: 404, issuer: null } }, /^on the sign-in page, but Google answered 404$/],
    [{ ...on, discovery: { status: 200, issuer: false } }, /names a different address for itself/],
  ];
  for (const [g, says] of red) {
    const r = row(facts({ google: g }));
    assert.equal(r.status, "fail", String(says)); assert.match(r.detail, says);
    assert.ok(r.fix.length > 20);
  }
  assert.equal(row(facts({ google: { ...on, listed: null } })).status, "grey", "MAS not asked (its database down): no verdict");
  for (const s of SLOTS) assert.ok(!DOCTOR.UPDATE_CHECKS.includes(`signin.${s}`), "a provider is outside the box: never an update check");
});
