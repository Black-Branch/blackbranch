// web's instance settings reader (instanceConfigServer.ts) with stub deps, the install-tier
// boot check, and the values derived from it (staff, the public avatar allowlist).
// Run: node --test app/lib/instanceConfigServer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import "./testInstallValues.ts";
import { createInstanceReader, instanceBool } from "./instanceConfigServer.ts";
import { installValuesAttribute, publishInstallValues, resolveInstallValues } from "./installValuesServer.ts";
import { INSTANCE_KEYS, parseInstanceValue } from "./instanceSchema.generated.mjs";

const quiet = { warn() {}, error() {}, log() {} };

function reader(over: Partial<Parameters<typeof createInstanceReader>[0]> = {}) {
  return createInstanceReader({
    env: () => ({}),
    queryPlain: async () => [],
    fetchSecrets: async () => ({ values: {} }),
    queryChainBuilt: async () => false,
    now: () => 1_000,
    log: quiet,
    ...over,
  });
}

test("env > DB > default; plain values from the DB, credentials from stream-api", async () => {
  const r = reader({
    env: () => ({ TWITCH_CHANNEL: "envchan" }),
    queryPlain: async () => [
      { key: "platform.twitch.channel", value: "dbchan" },
      { key: "bot.matrixId", value: "@bot:example.tv" },
      { key: "site.origin", value: "https://evil.example" },  // install tier: never from the DB
      { key: "stripe.secretKey", value: "sk_from_the_wrong_table" }, // secrets never from the plain table
    ],
    fetchSecrets: async () => ({ values: { "stripe.secretKey": "sk_test_from_stream_api_0001" } }),
  });
  assert.equal(r.resolve("bot.matrixId").value, null, "before the load: env + defaults only");
  assert.equal(await r.load(), true);
  assert.deepEqual(r.resolve("platform.twitch.channel"), { value: "envchan", source: "env", envName: "TWITCH_CHANNEL", error: null });
  assert.equal(r.resolve("bot.matrixId").source, "database");
  assert.equal(r.resolve("site.origin").value, "https://example.tv", "install tier = the build value");
  assert.equal(r.resolve("stripe.secretKey").value, "sk_test_from_stream_api_0001");
  assert.deepEqual(r.resolve("staff.extraMatrixIds"), { value: [], source: "default", envName: null, error: null });
});

test("fail-safe: a legacyOn switch with no row reads ON on a chain-built database, loudly; OFF on a baseline one", async () => {
  const lines: string[] = [];
  const log = { warn() {}, log() {}, error: (m: string) => { lines.push(m); } };
  const chain = reader({ queryChainBuilt: async () => true, log });
  await chain.load();
  for (const k of ["modules.stripe", "modules.paypal", "modules.youtube"]) assert.equal(chain.resolve(k).value, true, `${k} held on`);
  assert.equal(chain.resolve("modules.obs").value, false, "a switch that is not legacyOn keeps its default");
  chain.resolve("modules.stripe");
  assert.equal(lines.filter((l) => l.includes("modules.stripe")).length, 1, "one loud line per key, not one per read");
  assert.match(lines[0] ?? "", /blackbranch migrate/);
  assert.deepEqual(chain.heldOn().sort(), ["modules.paypal", "modules.stripe", "modules.youtube"]);

  const fresh = reader({ queryChainBuilt: async () => false });
  await fresh.load();
  assert.equal(fresh.resolve("modules.stripe").value, false, "a baseline-built (fresh) install: off by default");
  assert.deepEqual(fresh.heldOn(), []);

  const unknown = reader({ queryChainBuilt: async () => { throw new Error("no table"); } });
  assert.equal(await unknown.load(), true, "a failed origin query does not fail the load");
  assert.equal(unknown.resolve("modules.stripe").value, true, "origin unknown: ON (no provider is dropped by a guess)");

  const explicit = reader({ queryChainBuilt: async () => true, queryPlain: async () => [{ key: "modules.stripe", value: false }] });
  await explicit.load();
  assert.equal(explicit.resolve("modules.stripe").value, false, "a row always wins");
  const env = reader({ queryChainBuilt: async () => true, env: () => ({ MODULE_PAYPAL: "0" }) });
  await env.load();
  assert.equal(env.resolve("modules.paypal").value, false, "MODULE_<ID> always wins");
});

test("a failed load keeps the last good layer and says so", async () => {
  let fail = false;
  let t = 1_000;
  const r = reader({
    queryPlain: async () => { if (fail) throw new Error("db gone"); return [{ key: "bot.matrixId", value: "@bot:example.tv" }]; },
    now: () => t,
  });
  await r.load();
  fail = true; t = 2_000;
  assert.equal(await r.load(), false);
  assert.equal(r.resolve("bot.matrixId").value, "@bot:example.tv", "the last good layer is kept");
  assert.deepEqual(r.state(), { loaded: true, loadedAt: new Date(1_000).toISOString(), failingSince: new Date(2_000).toISOString() });
});

test("a credential stream-api could not decrypt is an ERROR here — not the default", async () => {
  const r = reader({ fetchSecrets: async () => ({ values: {}, unreadable: ["stripe.secretKey"] }) });
  await r.load();
  const res = r.resolve("stripe.secretKey");
  assert.equal(res.value, null);
  assert.match(res.error ?? "", /cannot be read/);
  const envWins = reader({ env: () => ({ STRIPE_SECRET_KEY: "sk_test_env_0000000001" }), fetchSecrets: async () => ({ values: {}, unreadable: ["stripe.secretKey"] }) });
  await envWins.load();
  assert.equal(envWins.resolve("stripe.secretKey").source, "env");
});

test("the status report shows sources and …last4 — never a secret value", async () => {
  const r = reader({ fetchSecrets: async () => ({ values: { "stripe.secretKey": "sk_live_THIS-IS-SECRET-wxyz" } }) });
  await r.load();
  const rep = r.statusReport();
  assert.deepEqual(rep["stripe.secretKey"], { source: "database", envName: null, display: "…wxyz", error: null });
  assert.equal(rep["openai.apiKey"], undefined, "only keys web consumes");
  assert.ok(!JSON.stringify(rep).includes("THIS-IS-SECRET"));
});

test("install values at boot: resolved from env, a required one missing or a malformed one refused", () => {
  const env = { SITE_NAME: "Example Stream", AUTH_URL: "https://example.tv/", SITE_API_ORIGIN: "https://api.example.tv",
    SITE_API_WS_ORIGIN: "wss://api.example.tv", MATRIX_SERVER_NAME: "example.tv", MATRIX_HOMESERVER_URL: "https://matrix.example.tv",
    MAS_ISSUER: "https://matrix.example.tv/auth/", MAS_CLIENT_ID: "01EXAMPLECLIENT", CURRENCY_NAME: "Coin" };
  const ok = resolveInstallValues(env);
  assert.deepEqual(ok.problems, [], "the owner's runtime env shape (AUTH_URL and the MAS_* aliases) passes");
  assert.equal(ok.values["site.origin"], "https://example.tv", "an origin is normalised");
  assert.equal(ok.values["matrix.oauth.issuer"], "https://matrix.example.tv/auth/");
  assert.equal(ok.values["currency.name"], "Coin");
  assert.equal(ok.values["currency.namePlural"], "points", "an unset key with a product default resolves to it");
  assert.equal("discordBridge.usernameTemplate" in ok.values, false, "an optional key nobody set is simply absent");
  // A switch is carried as its word, so it reaches the reader whichever way it is set — off included.
  assert.equal(ok.values["community.reconciler"], "false", "unset: the default, off");
  assert.equal(resolveInstallValues({ ...env, COMMUNITY_RECONCILER: "true" }).values["community.reconciler"], "true");
  assert.equal(ok.values["community.serviceLocalpart"], "blackbranch", "the product's own name for the account");
  assert.match(resolveInstallValues({ ...env, COMMUNITY_LOCALPART: "Not One" }).problems[0]!, /^community\.serviceLocalpart: COMMUNITY_LOCALPART: /);
  assert.match(resolveInstallValues({ ...env, SITE_API_ORIGIN: "not a url" }).problems[0]!, /site\.apiOrigin: SITE_API_ORIGIN: not a URL/);
  const without = (k: string) => Object.fromEntries(Object.entries(env).filter(([n]) => n !== k));
  assert.deepEqual(resolveInstallValues(without("SITE_NAME")).problems, ["site.name is required — set SITE_NAME in this site's environment"]);
  assert.match(resolveInstallValues(without("MATRIX_HOMESERVER_URL")).problems[0]!, /matrix\.baseUrl is required — set MATRIX_HOMESERVER_URL/);
  // published for every module of the process, and read back through installValue()
  const procEnv: Record<string, string | undefined> = { ...env };
  assert.deepEqual(publishInstallValues(procEnv), []);
  assert.deepEqual(JSON.parse(procEnv.INSTALL_VALUES!), ok.values);
});

test("the browser's copy: public keys only, as JSON for the <html> attribute", () => {
  const json = installValuesAttribute({ "site.name": "A </html> \"quoted\"", "site.origin": "https://example.tv" });
  assert.deepEqual(JSON.parse(json), { "site.name": "A </html> \"quoted\"", "site.origin": "https://example.tv" }, "the values arrive intact (React escapes the attribute)");
  const keys = INSTANCE_KEYS.filter((e) => e.tier === "install" && e.packages.includes("web"));
  assert.ok(keys.length >= 28 && keys.every((e) => e.scope === "public"), "every install key web reads is public — the attribute may carry them all");
});

// ── Typed values from every source ─────────────────────────────────────────────────────────────
/** INSTALL_VALUES as the boot publishes it, with `over` on top (null = left out), for `fn`. */
function withInstallValues(over: Record<string, string | null>, fn: () => void) {
  const prior = process.env.INSTALL_VALUES;
  const values = JSON.parse(prior ?? "{}") as Record<string, string>;
  for (const [k, v] of Object.entries(over)) if (v === null) delete values[k]; else values[k] = v;
  try {
    process.env.INSTALL_VALUES = JSON.stringify(values);
    fn();
  } finally {
    if (prior === undefined) delete process.env.INSTALL_VALUES; else process.env.INSTALL_VALUES = prior;
  }
}

test("install_bool_is_typed: an install switch set in .env reads as a boolean, so instanceBool sees it on", () => {
  // The boot publishes every install value as text; the reader hands out the schema's type.
  const published = resolveInstallValues({ COMMUNITY_RECONCILER: "true" }).values["community.reconciler"];
  assert.equal(published, "true", "vacuity: the boot carries the switch as its word");
  withInstallValues({ "community.reconciler": published! }, () => {
    assert.deepEqual(reader().resolve("community.reconciler"), { value: true, source: "env", envName: "COMMUNITY_RECONCILER", error: null });
    assert.equal(instanceBool("community.reconciler"), true, "the site sees the switch on");
  });
  withInstallValues({ "community.reconciler": "false" }, () => {
    assert.equal(reader().resolve("community.reconciler").value, false);
    assert.equal(instanceBool("community.reconciler"), false);
  });
});

test("install_bool_default_is_typed: an install switch nobody set reads as its default, a boolean", () => {
  withInstallValues({ "community.reconciler": null }, () => {
    assert.deepEqual(reader().resolve("community.reconciler"), { value: false, source: "default", envName: null, error: null });
  });
});

test("instance_bool_from_db_row_is_typed: a stored switch, as a boolean or as its word, reads as a boolean", async () => {
  for (const [stored, want] of [[true, true], ["true", true], [false, false], ["false", false]] as const) {
    const r = reader({ queryPlain: async () => [{ key: "community.keepElementEdits", value: stored }] });
    await r.load();
    assert.deepEqual(r.resolve("community.keepElementEdits"), { value: want, source: "database", envName: null, error: null }, String(stored));
  }
});

test("instance_bool_from_env_is_typed: a switch set in the environment reads as a boolean", async () => {
  const r = reader({ env: () => ({ COMMUNITY_KEEP_ELEMENT_EDITS: "1" }), queryPlain: async () => [{ key: "community.keepElementEdits", value: false }] });
  await r.load();
  assert.deepEqual(r.resolve("community.keepElementEdits"), { value: true, source: "env", envName: "COMMUNITY_KEEP_ELEMENT_EDITS", error: null });
});

/** A value of `e`'s kind that its own parser accepts, as text (how env and the boot carry it). */
function sampleText(e: (typeof INSTANCE_KEYS)[number]): string | null {
  const named = "values" in e && Array.isArray(e.values) ? e.values.map(String) : [];
  const tries = e.kind === "bool" ? ["true"] : e.kind === "number" ? [String(e.min ?? 1)]
    : [...named, "@someone:example.tv", "example.tv", "someone", "https://example.tv"];
  return tries.find((t) => parseInstanceValue(e, t).ok) ?? null;
}
const TYPED: Record<string, (v: unknown) => boolean> = {
  bool: (v) => typeof v === "boolean",
  number: (v) => typeof v === "number",
  list: (v) => Array.isArray(v),
};

test("no_kind_leaks_text: every bool, number and list key web reads is its type from env, a stored row, the boot and the default", async () => {
  const keys = INSTANCE_KEYS.filter((e) => e.packages.includes("web") && !e.secret && e.kind in TYPED);
  let checked = 0;
  for (const e of keys) {
    const text = sampleText(e);
    assert.ok(text !== null, `${e.key}: no sample its parser accepts`);
    const is = TYPED[e.kind]!;
    if (e.tier === "install") {
      withInstallValues({ [e.key]: text }, () => {
        const v = reader().resolve(e.key).value;
        assert.ok(is(v), `${e.key} from the boot's text: ${JSON.stringify(v)}`);
      });
    } else {
      const fromEnv = reader({ env: () => ({ [e.env[0]!]: text! }) });
      await fromEnv.load();
      assert.ok(is(fromEnv.resolve(e.key).value), `${e.key} from env: ${JSON.stringify(fromEnv.resolve(e.key).value)}`);
      const fromDb = reader({ queryPlain: async () => [{ key: e.key, value: text }] });
      await fromDb.load();
      assert.ok(is(fromDb.resolve(e.key).value), `${e.key} from a stored row: ${JSON.stringify(fromDb.resolve(e.key).value)}`);
    }
    const d = reader().resolve(e.key);
    if (d.source === "default") assert.ok(is(d.value) || (e.kind === "number" && d.value === null), `${e.key} default: ${JSON.stringify(d.value)}`);
    checked++;
  }
  // The scan's bound: every non-secret bool, number and list key the schema gives web.
  assert.equal(checked, keys.length);
  assert.ok(keys.some((e) => e.kind === "bool" && e.tier === "install"), "vacuity: the install switch is among them");
  assert.ok(keys.filter((e) => e.kind === "bool").length >= 10 && keys.filter((e) => e.kind === "number").length >= 10
    && keys.filter((e) => e.kind === "list").length >= 5, "vacuity: switches, numbers and lists were read");
});
