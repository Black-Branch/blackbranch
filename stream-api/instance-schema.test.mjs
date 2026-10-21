// The instance settings schema: its generator, its drift gate, and the ONE resolver every
// package runs.
//
// `.test.mjs`, not `.test.js`: it imports ES modules, and this package's deploy copies the
// top-level `*.js` (same reasoning as orphan-gate.test.mjs).
//
// Run: node --test instance-schema.test.mjs

import test from "node:test";
import console from "node:console";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { INSTANCE_KEYS } from "../config/instance-schema.mjs";
import { TARGETS, render, isCurrent, main } from "../tools/gen-instance-schema.mjs";
import { MODULES } from "../config/modules.mjs";
import { SETUP_CORE, setupProblems } from "../config/setup-core.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// The behavioural tests run against stream-api's GENERATED copy — the code that actually
// deploys — not the root schema module.
const { resolveInstanceValue, parseInstanceValue, INSTANCE_KEYS: GEN_KEYS } = require("./instanceSchema.generated.js");
const entry = (key) => {
  const e = GEN_KEYS.find((k) => k.key === key);
  assert.ok(e, `no key ${key}`);
  return e;
};

test("every package's generated copy is current (the gate's own assertion, on the real tree)", () => {
  for (const pkg of Object.keys(TARGETS)) {
    const have = readFileSync(join(REPO, TARGETS[pkg].file), "utf8");
    assert.ok(isCurrent(pkg, have), `${TARGETS[pkg].file} has drifted — run node tools/gen-instance-schema.mjs`);
  }
});

test("the gate fails on a one-byte edit, a missing file, and an edited function body", () => {
  for (const pkg of Object.keys(TARGETS)) {
    const good = render(pkg);
    assert.equal(isCurrent(pkg, good), true);
    assert.equal(isCurrent(pkg, good + " "), false, `${pkg}: trailing byte accepted`);
    assert.equal(isCurrent(pkg, null), false, `${pkg}: a missing copy accepted`);
    // The tempting hand-fix: tweak the resolver in one package only.
    const tweaked = good.replace("if (!parsed.ok) return", "if (parsed.ok === false) return");
    assert.notEqual(tweaked, good, "premise: the mutation must change the text");
    assert.equal(isCurrent(pkg, tweaked), false, `${pkg}: an edited resolver accepted`);
  }
});

test("every package that carries a function carries the SAME source text", () => {
  // The point of emitting fn.toString(): one resolver, not three that a test says agree.
  // Each package carries only what it uses, but the resolver itself travels to all three.
  const bodyOf = (text, name) => {
    const start = text.search(new RegExp(`(^|\\n)(async )?function ${name}\\(`));
    if (start < 0) return null;
    const end = text.indexOf("\n}\n", start);
    assert.ok(end > start, `${name} has no end`);
    return text.slice(start, end + 2).trim();
  };
  const texts = Object.values(TARGETS).map((t) => readFileSync(join(REPO, t.file), "utf8"));
  for (const name of ["parseInstanceValue", "resolveInstanceValue", "runProviderCheck", "normalizeCheckResult", "describeCheck"]) {
    const bodies = texts.map((t) => bodyOf(t, name)).filter((b) => b !== null);
    assert.ok(bodies.length >= 2, `${name} is in fewer than two packages`);
    if (["parseInstanceValue", "resolveInstanceValue", "runProviderCheck"].includes(name)) assert.equal(bodies.length, 3, `${name} must be in all three`);
    assert.ok(bodies[0].length > 300, `${name} extracted as ${bodies[0].length} chars — the scan went blind`);
    for (const b of bodies) assert.equal(b, bodies[0], `${name} differs between packages`);
  }
});

test("schema entries are well-formed (vacuity floor on the key count)", () => {
  assert.ok(INSTANCE_KEYS.length >= 47, `only ${INSTANCE_KEYS.length} keys — the schema lost entries`);
  const seen = new Set();
  const envSeen = new Map();
  for (const e of INSTANCE_KEYS) {
    assert.ok(!seen.has(e.key), `duplicate key ${e.key}`);
    seen.add(e.key);
    assert.ok(["string", "list", "origin", "wsOrigin", "url", "serverName", "matrixId", "localpartTemplate", "enum", "secret", "backupRepository",
      "bool", "number", "aiRoute", "aiTasks", "aiConnections", "memoryState", "setupState"].includes(e.kind), `${e.key}: kind`);
    assert.ok(["install", "instance", "secret"].includes(e.tier), `${e.key}: tier`);
    assert.equal(e.secret, e.tier === "secret", `${e.key}: secret flag and tier disagree`);
    assert.equal(e.kind === "secret", e.tier === "secret", `${e.key}: secret kind and tier disagree`);
    assert.ok(["live", "restart"].includes(e.reload), `${e.key}: reload`);
    // Nothing is compiled into web's build, so every install key — the
    // ones web reads included — is read from the environment when its process starts: `restart`.
    if (e.tier === "install") assert.equal(e.reload, "restart", `${e.key}: an install key applies at its process's restart`);
    assert.ok(e.env.every((n) => /^[A-Z][A-Z0-9_]*$/.test(n)), `${e.key}: env names`);
    // Only the structured AI kinds go without an env name (JSON is not an env setting), and a
    // key with a declared writer must never be overridable from env.
    const structured = ["aiRoute", "aiTasks", "aiConnections", "memoryState", "setupState"].includes(e.kind);
    assert.ok(structured ? e.env.length === 0 : e.env.length >= 1, `${e.key}: env names (${structured ? "none for a structured kind" : "at least one"})`);
    if (e.writer) assert.equal(e.env.length, 0, `${e.key}: a writer-only key cannot have an env override`);
    assert.ok(e.packages.length >= 1 && e.packages.every((p) => ["web", "stream-api", "stream-ingest"].includes(p)), `${e.key}: packages`);
    assert.ok(e.label && e.description, `${e.key}: label/description`);
    // Neutral defaults only: an owner value here would be hardcoded in three files.
    // A product default (off, a number, an enum value) is allowed; an owner VALUE is not.
    const neutral = e.default === null || (Array.isArray(e.default) && e.default.length === 0) || e.default === false ||
      (e.kind === "number" && typeof e.default === "number") || (e.kind === "enum" && (e.values || []).includes(e.default)) ||
      // A product list (automod's categories): declared as such, and plain lower-case words only.
      (e.kind === "list" && e.productDefault === true && Array.isArray(e.default) && e.default.every((x) => /^[a-z][a-z-]{0,30}$/.test(x))) ||
      // A product WORD (e.g. the currency's neutral "point" / "points" / "pts", "Karma"): declared
      // as such, plain letters and spaces only — an owner's name, domain or id cannot pass it.
      (e.kind === "string" && e.productDefault === true && typeof e.default === "string" && /^[A-Za-z][A-Za-z ]{0,30}$/.test(e.default));
    assert.ok(neutral, `${e.key}: non-neutral default`);
    if (e.required) assert.equal(e.tier, "install", `${e.key}: only install-tier keys are required at boot`);
    // One env name, one key — otherwise two keys would fight over one variable.
    for (const n of e.env) {
      assert.ok(!envSeen.has(n), `${n} is claimed by both ${envSeen.get(n)} and ${e.key}`);
      envSeen.set(n, e.key);
    }
  }
});

test("env > DB > default, canonical name before aliases, empty env is unset", () => {
  const e = entry("platform.twitch.broadcasterId");
  assert.deepEqual(resolveInstanceValue(e, {}, null), { value: null, source: "unset", envName: null, error: null });
  assert.equal(resolveInstanceValue(e, {}, { [e.key]: "42" }).source, "database");
  assert.deepEqual(resolveInstanceValue(e, { TWITCH_USER_ID: "7" }, { [e.key]: "42" }),
    { value: "7", source: "env", envName: "TWITCH_USER_ID", error: null });
  assert.equal(resolveInstanceValue(e, { TWITCH_BROADCASTER_ID: "1", TWITCH_USER_ID: "7" }, null).value, "1",
    "the canonical name must beat the alias");
  assert.equal(resolveInstanceValue(e, { TWITCH_BROADCASTER_ID: "  ", TWITCH_USER_ID: "7" }, null).envName, "TWITCH_USER_ID",
    "an empty canonical value is unset, not an override");
  const list = entry("staff.extraMatrixIds");
  assert.deepEqual(resolveInstanceValue(list, {}, null), { value: [], source: "default", envName: null, error: null });
  assert.deepEqual(resolveInstanceValue(list, { STAFF_EXTRA_MATRIX_IDS: "@a:x, @b:x,,@a:x" }, null).value, ["@a:x", "@b:x"]);
});

test("install tier never reads the database", () => {
  const e = entry("site.origin");
  assert.equal(resolveInstanceValue(e, {}, { "site.origin": "https://evil.example" }).source, "unset");
  assert.deepEqual(resolveInstanceValue(e, { AUTH_URL: "https://Example.TV/" }, null),
    { value: "https://example.tv", source: "env", envName: "AUTH_URL", error: null });
});

test("a value that does not parse is an ERROR, never a silent default", () => {
  const origin = entry("site.origin");
  for (const bad of ["example.tv", "ftp://example.tv", "https://example.tv/path", "https://u:p@example.tv"]) {
    const r = resolveInstanceValue(origin, { SITE_ORIGIN: bad }, null);
    assert.equal(r.value, null, bad);
    assert.match(r.error, /^SITE_ORIGIN: /, bad);
  }
  assert.equal(resolveInstanceValue(entry("site.apiWsOrigin"), { SITE_API_WS_ORIGIN: "https://x.tv" }, null).value, null);
  assert.equal(resolveInstanceValue(entry("site.apiWsOrigin"), { SITE_API_WS_ORIGIN: "wss://x.tv" }, null).value, "wss://x.tv");
  const mx = entry("bot.matrixId");
  assert.equal(parseInstanceValue(mx, "@bot:example.tv").ok, true);
  assert.equal(parseInstanceValue(mx, "bot:example.tv").ok, false);
  assert.equal(parseInstanceValue(mx, "@Bot:example.tv").ok, false, "Matrix localparts are lower case");
  const en = entry("paypal.env");
  assert.equal(parseInstanceValue(en, "live").ok, true);
  assert.equal(parseInstanceValue(en, "prod").ok, false);
  // A corrupt stored row reports itself instead of resolving to the default.
  const r = resolveInstanceValue(mx, {}, { "bot.matrixId": "nope" });
  assert.equal(r.source, "database");
  assert.match(r.error, /stored value/);
  assert.equal(parseInstanceValue(entry("anthropic.apiKey"), "sk-a\nb").ok, false, "a line break in a secret");
});

test("Matrix kinds: url as typed, serverName lower-cased, localpartTemplate shape", () => {
  const issuer = entry("matrix.oauth.issuer");
  assert.deepEqual(resolveInstanceValue(issuer, { MAS_ISSUER: " https://hs.example/auth/ " }, null),
    { value: "https://hs.example/auth/", source: "env", envName: "MAS_ISSUER", error: null },
    "the MAS_* alias still works, and the value is kept AS TYPED (an issuer is compared byte for byte)");
  assert.equal(resolveInstanceValue(issuer, { MATRIX_OAUTH_ISSUER: "https://a/", MAS_ISSUER: "https://b/" }, null).value, "https://a/");
  for (const bad of ["hs.example/auth", "ftp://hs.example/", "https://hs.example/auth?x=1", "https://u@hs.example/"]) {
    assert.equal(parseInstanceValue(issuer, bad).ok, false, bad);
  }
  const sn = entry("matrix.serverName");
  assert.deepEqual(parseInstanceValue(sn, "Example.TV"), { ok: true, value: "example.tv" });
  assert.equal(parseInstanceValue(sn, "example.tv:8448").ok, true);
  for (const bad of ["https://example.tv", "-x.tv", "example.tv/", "ex ample.tv", "@a:example.tv"]) {
    assert.equal(parseInstanceValue(sn, bad).ok, false, bad);
  }
  const base = entry("matrix.baseUrl");
  assert.equal(parseInstanceValue(base, "https://matrix.example.tv/").value, "https://matrix.example.tv", "an origin, trailing slash dropped");
  assert.equal(parseInstanceValue(base, "https://matrix.example.tv/_matrix").ok, false);
  const tpl = entry("discordBridge.usernameTemplate");
  assert.equal(parseInstanceValue(tpl, "discord_{{.}}").ok, true);
  for (const bad of ["discord_", "{{.}}", "{{.}}_{{.}}", "Discord_{{.}}", "dis cord_{{.}}"]) {
    assert.equal(parseInstanceValue(tpl, bad).ok, false, bad);
  }
  // The client secret is a credential, never an install value.
  assert.equal(entry("matrix.oauth.clientSecret").tier, "secret");
  assert.deepEqual(entry("matrix.oauth.clientSecret").env, ["MATRIX_OAUTH_CLIENT_SECRET", "MAS_CLIENT_SECRET"]);
});

test("value kinds: bool, number (nullable), and the structured AI values are bounded and strict", () => {
  const bool = entry("memory.enabled");
  assert.deepEqual(parseInstanceValue(bool, "1"), { ok: true, value: true });
  assert.deepEqual(parseInstanceValue(bool, false), { ok: true, value: false });
  assert.equal(parseInstanceValue(bool, "maybe").ok, false);
  const days = entry("memory.retentionDays");
  assert.deepEqual(parseInstanceValue(days, null), { ok: true, value: null }, "null = forever");
  assert.deepEqual(parseInstanceValue(days, "forever"), { ok: true, value: null });
  assert.deepEqual(parseInstanceValue(days, "30"), { ok: true, value: 30 });
  for (const bad of [0, 4000, 1.5, "ten"]) assert.equal(parseInstanceValue(days, bad).ok, false, `retention accepted ${bad}`);
  assert.equal(parseInstanceValue(entry("memory.minWords"), null).ok, false, "a non-nullable number accepted null");
  assert.deepEqual(resolveInstanceValue(days, {}, { "memory.retentionDays": null }), { value: null, source: "database", envName: null, error: null });
  assert.equal(resolveInstanceValue(days, {}, {}).value, 90);

  const route = entry("ai.embeddings");
  assert.deepEqual(parseInstanceValue(route, { connection: "openai", model: "text-embedding-3-small" }).value, { connection: "openai", model: "text-embedding-3-small" });
  assert.equal(parseInstanceValue(route, { connection: "openai", model: "m", baseUrl: "http://x" }).ok, false, "an extra field (a URL!) accepted");
  assert.equal(parseInstanceValue(route, { connection: "Open AI", model: "m" }).ok, false);

  const tasks = entry("ai.tasks");
  assert.equal(parseInstanceValue(tasks, { "helpdesk.answer": { enabled: true, connection: "anthropic", model: "claude-haiku-4-5" } }).ok, true);
  assert.equal(parseInstanceValue(tasks, { "helpdesk.answer": { enabled: "yes" } }).ok, false);
  assert.equal(parseInstanceValue(tasks, { "helpdesk.answer": { model: "m" } }).ok, false, "a model without its connection");
  assert.equal(parseInstanceValue(tasks, { "x": { apiKey: "sk-1" } }).ok, false, "a key smuggled into a task");

  const conns = entry("ai.connections");
  assert.equal(parseInstanceValue(conns, [{ id: "local", kind: "openai-compatible", label: "Ollama", baseUrl: "http://10.0.0.5:11434/v1/" }]).value[0].baseUrl, "http://10.0.0.5:11434/v1");
  assert.equal(parseInstanceValue(conns, [{ id: "openai", kind: "openai-compatible", label: "x", baseUrl: "http://x" }]).ok, false, "a custom connection took a built-in id");
  assert.equal(parseInstanceValue(conns, [{ id: "a", kind: "openai-compatible", label: "x", baseUrl: "http://u:p@x" }]).ok, false, "credentials in a URL");

  const st = entry("memory.state");
  const good = { model: "m", connection: "openai", dim: 1536, since: "2026-06-22T23:18:09.426Z", status: "on" };
  assert.equal(parseInstanceValue(st, good).ok, true);
  assert.equal(parseInstanceValue(st, { ...good, dim: 3072 }).ok, false, "past the HNSW limit");
  assert.equal(parseInstanceValue(st, { ...good, status: "off" }).ok, false);
  assert.equal(parseInstanceValue(st, "{not json").ok, false);
  assert.equal(parseInstanceValue(entry("bot.name"), "x".repeat(33)).ok, false, "bot.name past 32 characters");
});

// ── The setup lists (config/modules.mjs `setup`, config/setup-core.mjs) ─────────────────────────
test("the setup lists are well-formed, and a bad shape fails check:instance-schema in every package", () => {
  assert.deepEqual(setupProblems({ modules: MODULES, core: SETUP_CORE, keys: INSTANCE_KEYS }), []);
  assert.ok(MODULES.some((m) => Array.isArray(m.setup) && m.setup.length), "vacuity: no manifest carries a setup list");
  const quiet = console.error; console.error = () => {};
  try {
    for (const pkg of Object.keys(TARGETS)) assert.equal(main(["--check", pkg]), 0, `${pkg}: the real lists must pass`);
    const obs = MODULES.find((m) => m.id === "obs");
    const step0 = obs.setup[0];
    const withStep = (patch) => MODULES.map((m) => (m.id === "obs" ? { ...m, setup: [{ ...step0, ...patch }, ...m.setup.slice(1)] } : m));
    const broken = {
      "an unknown field": withStep({ colour: "red" }),
      "an install-tier field (set in .env, not on a page)": withStep({ fields: ["obs.url"] }),
      "a field that is no key": withStep({ fields: ["obs.nothing"] }),
      "an unknown placeholder": withStep({ paste: [{ label: "Callback", value: "{site}/cb" }] }),
      "a plain-http link": withStep({ links: [{ label: "Docs", url: "http://example.org" }] }),
      "a test that is no check": withStep({ test: "obs.soundSource" }),
      "need neither required nor optional": withStep({ need: "maybe" }),
      "a step with nothing to do": withStep({ links: [], paste: [], fields: [], test: null }),
      "a duplicate step id": MODULES.map((m) => (m.id === "obs" ? { ...m, setup: [step0, step0] } : m)),
      "an empty list": MODULES.map((m) => (m.id === "obs" ? { ...m, setup: [] } : m)),
      "setup on a site-plugin module": MODULES.map((m) => (m.id === "radio" ? { ...m, setup: obs.setup } : m)),
    };
    for (const [what, modules] of Object.entries(broken)) {
      assert.ok(setupProblems({ modules, core: SETUP_CORE, keys: INSTANCE_KEYS }).length > 0, `${what}: no problem reported`);
      assert.equal(main(["--check", "web"], { modules }), 1, `${what}: the gate passed`);
    }
    const core = [{ ...SETUP_CORE[0], release: "now", steps: [] }];
    assert.equal(main(["--check", "stream-api"], { core }), 1, "a core list released now with no steps");
    // A step's Test must check one of its own fields.
    assert.equal(main(["--check", "web"], { modules: withStep({ test: "elevenlabs.apiKey" }) }), 1, "a test of a key the step does not fill");
  } finally { console.error = quiet; }
});

test("the platform and payment lists — every product list released, paste values only from this install's addresses", () => {
  const ids = SETUP_CORE.map((c) => c.id);
  assert.deepEqual(ids, ["twitch", "kick", "streamplace", "donations"]);
  for (const c of SETUP_CORE) assert.equal(c.release, "now", `${c.id} is released`);
  for (const id of ["youtube", "stripe", "paypal"]) {
    const m = MODULES.find((x) => x.id === id);
    assert.ok(m && m.kind === "module" && m.defaultOn === false && m.legacyOn === true && m.setup.length, `${id}: a product switch, off on a fresh install, kept on for the owner`);
    assert.ok(!m.packages.includes("stream-api"), `${id} owns nothing in stream-api`);
    assert.equal(entry(`modules.${id}`).legacyOn, true);
  }
  const pastes = [...MODULES.flatMap((m) => m.setup ?? []), ...SETUP_CORE.flatMap((c) => c.steps)].flatMap((s) => s.paste.map((p) => p.value));
  assert.ok(pastes.includes("{origin}/api/billing/webhook") && pastes.includes("{origin}/api/billing/paypal/webhook") && pastes.includes("{origin}/api/auth/link/twitch/callback"));
  // No address a provider is told to call may be written out: every URL is a template on this install.
  for (const v of pastes) if (/^https?:/.test(v)) assert.fail(`a hardcoded address in a paste value: ${v}`);
});

test("setup.state: bounded and strict — only display values by .env name, never what .env cannot hold", () => {
  const e = entry("setup.state");
  assert.deepEqual(parseInstanceValue(e, { step: "site", install: { SITE_NAME: "My Stream", CURRENCY_NAME: "" }, skipped: ["obs:names"] }),
    { ok: true, value: { step: "site", install: { SITE_NAME: "My Stream", CURRENCY_NAME: "" }, skipped: ["obs:names"] } });
  assert.equal(parseInstanceValue(e, { install: { SITE_ORIGIN: "https://elsewhere.test" } }).ok, false, "an identity key");
  assert.equal(parseInstanceValue(e, { install: { STREAM_API_SECRET: "x" } }).ok, false, "a secret");
  for (const bad of ['say "hi"', "a $HOME b", "back\\slash", "two\nlines", "x".repeat(301)]) {
    assert.equal(parseInstanceValue(e, { install: { SITE_NAME: bad } }).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseInstanceValue(e, { step: "Bad Step" }).ok, false);
  assert.equal(parseInstanceValue(e, { adminPending: { id: "nope", username: "a" } }).ok, false);
  assert.ok(parseInstanceValue(e, { adminPending: { id: "01M4KCB6G706G6FZXTVVS68WMB", username: "owner" } }).ok);
  assert.equal(parseInstanceValue(e, { other: 1 }).ok, false);
  assert.deepEqual(parseInstanceValue(e, { core: ["twitch", "kick", "twitch"] }), { ok: true, value: { core: ["twitch", "kick"] } }, "the lists chosen on the modules page");
  assert.equal(parseInstanceValue(e, { core: ["Twitch!"] }).ok, false);
  assert.equal(parseInstanceValue(e, { core: "twitch" }).ok, false);
  assert.equal(parseInstanceValue(e, "not json").ok, false);
});
