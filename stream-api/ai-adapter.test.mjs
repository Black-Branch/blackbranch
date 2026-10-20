// The AI adapter (config/ai-adapter.mjs → ./aiAdapter.generated.js) — route resolution, the two
// wire shapes, the error codes, retries and redirects.
//
// No network: every request goes to a recording fake fetch, so no test can reach a provider with
// a key (real or fake). Runs against the GENERATED copy — the code that deploys.
//
// `.test.mjs`, not `.test.js`: this package's deploy copies the top-level `*.js`.
//
// Run: node --test ai-adapter.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";

const { Response, AbortController } = globalThis;
import { ADAPTER_TARGETS, renderAdapter } from "../tools/gen-instance-schema.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { AI_ADAPTER: A } = require("./aiAdapter.generated.js");

/** A fake fetch: answers from a queue of [status, body, headers?] and records every request. */
function fakeFetch(...answers) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body, headers = {}] = answers.length > 1 ? answers.shift() : answers[0];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  f.calls = calls;
  return f;
}
const deps = (fetchImpl, keys = { "anthropic.apiKey": "ak-test", "openai.apiKey": "ok-test" }) =>
  ({ fetchImpl, getSecret: (k) => keys[k] ?? null, sleep: async () => {} });

const PLUGIN = {
  id: "p.chat", kind: "chat", owner: "plugin:p", label: "P", envModel: ["P_MODEL", "SHARED_MODEL"], envConnection: "anthropic",
  defaultRoute: { connection: "anthropic", model: "claude-haiku-4-5" }, maxTokens: 400,
};
const registry = (extra = {}) => ({ slots: { ...Object.fromEntries(A.PRODUCT_SLOTS.map((s) => [s.id, s])), [PLUGIN.id]: PLUGIN, ...extra }, pins: {} });
const anthropicRoute = (over = {}) => A.resolveRoute("p.chat", {}, {}, registry({ "p.chat": { ...PLUGIN, ...over } }));

test("the generated copies are the adapter's own text", () => {
  for (const pkg of Object.keys(ADAPTER_TARGETS)) {
    assert.equal(readFileSync(join(REPO, ADAPTER_TARGETS[pkg].file), "utf8"), renderAdapter(pkg), `${pkg} copy drifted`);
  }
  assert.throws(() => renderAdapter("stream-api", "import x from 'y';\nexport const AI_ADAPTER = {};\n"), /import nothing/);
  assert.throws(() => renderAdapter("stream-api", "export const AI_ADAPTER = {};\nexport const X = 1;\n"), /exactly one name/);
});

test("route resolution: env pin > settings > plugin default; product slots are off until configured", () => {
  const reg = registry();
  assert.deepEqual(
    [A.resolveRoute("p.chat", {}, {}, reg).model, A.resolveRoute("p.chat", {}, {}, reg).source], ["claude-haiku-4-5", "default"]);
  const db = { tasks: { "p.chat": { connection: "openai", model: "gpt-x" } }, mode: "advanced" };
  assert.deepEqual([A.resolveRoute("p.chat", db, {}, reg).connection.id, A.resolveRoute("p.chat", db, {}, reg).model], ["openai", "gpt-x"]);
  const env = { SHARED_MODEL: "shared", P_MODEL: "" };
  const r = A.resolveRoute("p.chat", db, env, reg);
  assert.deepEqual([r.model, r.source, r.envName, r.connection.id], ["shared", "env", "SHARED_MODEL", "anthropic"], "an empty first alias must fall through to the next");
  assert.equal(A.resolveRoute("p.chat", { ...db, tasks: { "p.chat": { enabled: false } } }, {}, reg).reason, "off");

  // Product: no row → off; a row → on; simple mode with a default → the default wins.
  assert.equal(A.resolveRoute("helpdesk.answer", {}, {}, reg).reason, "off");
  const on = { tasks: { "helpdesk.answer": { enabled: true, connection: "anthropic", model: "h" } } };
  assert.equal(A.resolveRoute("helpdesk.answer", on, {}, reg).model, "h");
  assert.equal(A.resolveRoute("helpdesk.answer", { ...on, default: { connection: "openai", model: "d" } }, {}, reg).model, "d", "simple mode: one model");
  assert.equal(A.resolveRoute("helpdesk.answer", { ...on, mode: "advanced", default: { connection: "openai", model: "d" } }, {}, reg).model, "h");
  assert.equal(A.resolveRoute("helpdesk.answer", { tasks: { "helpdesk.answer": { enabled: true } } }, {}, reg).reason, "not_configured");
  assert.equal(A.resolveRoute("nope", {}, {}, reg).reason, "unknown_slot");

  // A plugin's pin on a product slot.
  const pinned = { ...reg, pins: { "helpdesk.answer": { env: ["HD_MODEL"], connection: "anthropic" } } };
  assert.equal(A.resolveRoute("helpdesk.answer", on, { HD_MODEL: "pinned" }, pinned).model, "pinned");

  // The embedder: OpenAI-compatible only; a custom connection's key is its own.
  assert.equal(A.resolveRoute("embeddings", { embeddings: { connection: "anthropic", model: "x" } }, {}, reg).reason, "needs_unmet");
  const custom = A.resolveRoute("embeddings", {
    embeddings: { connection: "local", model: "nomic" },
    connections: [{ id: "local", kind: "openai-compatible", label: "L", baseUrl: "http://10.0.0.5:11434/v1/" }],
  }, {}, reg);
  assert.deepEqual(custom.connection, { id: "local", kind: "openai-compatible", baseUrl: "http://10.0.0.5:11434/v1", keyName: "ai.connection.local.apiKey" });
  assert.equal(A.resolveRoute("embeddings", { embeddings: { connection: "gone", model: "x" } }, {}, reg).reason, "not_configured");
});

test("Anthropic: the request is the Messages API body, tools only when there are any, server tools after client tools", async () => {
  const f = fakeFetch([200, { model: "claude-haiku-4-5-20251001", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1, server_tool_use: { web_search_requests: 2 } } }]);
  const out = await A.chat(anthropicRoute(), { system: "S", messages: [{ role: "user", content: "q" }], maxTokens: 60, temperature: 1 }, deps(f));
  const c = f.calls[0];
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.equal(c.init.headers["x-api-key"], "ak-test");
  assert.equal(c.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(c.init.redirect, "manual");
  assert.deepEqual(c.body, { model: "claude-haiku-4-5", max_tokens: 60, temperature: 1, system: "S", messages: [{ role: "user", content: "q" }] });
  assert.deepEqual([out.text, out.stopReason, out.usage, out.model], ["hi", "end_turn", { in: 3, out: 1, searches: 2 }, "claude-haiku-4-5"],
    "the route's model (what a trace records), not the provider's dated id");

  const g = fakeFetch([200, { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "search", input: { q: "x" } }] }]);
  const tools = [{ name: "search", description: "d", input_schema: { type: "object" } }];
  const server = [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }];
  const t = await A.chat(anthropicRoute(), { messages: [{ role: "user", content: "q" }], tools, serverTools: server }, deps(g));
  assert.deepEqual(g.calls[0].body.tools, [...tools, ...server]);
  assert.deepEqual(t.toolCalls, [{ id: "tu1", name: "search", input: { q: "x" } }]);
  assert.equal(t.content[0].type, "tool_use", "content is handed back as blocks for the tool loop");
  const h = fakeFetch([200, { content: [] }]);
  await A.chat(anthropicRoute(), { messages: [], tools: [], serverTools: [] }, deps(h));
  assert.equal("tools" in h.calls[0].body, false, "an empty tools array was sent");
});

test("OpenAI-compatible: the scorer's exact body, and tool calls mapped both ways", async () => {
  const route = A.resolveRoute("s", {}, {}, { slots: { s: { id: "s", kind: "chat", owner: "plugin:x", defaultRoute: { connection: "openai", model: "gpt-4o-mini" } } } });
  const f = fakeFetch([200, { choices: [{ message: { content: "0.45" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2 } }]);
  const out = await A.chat(route, { maxTokens: 10, temperature: 0.1, system: "PROMPT", messages: [{ role: "user", content: "msg" }] }, deps(f));
  assert.equal(f.calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer ok-test");
  assert.deepEqual(f.calls[0].body, { model: "gpt-4o-mini", max_tokens: 10, temperature: 0.1, messages: [{ role: "system", content: "PROMPT" }, { role: "user", content: "msg" }] },
    "not byte-for-byte the request the OpenAI SDK sent — scores would stop being comparable");
  assert.deepEqual([out.text, out.stopReason, out.usage.in], ["0.45", "end_turn", 9]);

  // An Anthropic-shaped tool turn goes out as OpenAI tool_calls / tool messages, and comes back as blocks.
  const g = fakeFetch([200, { choices: [{ message: { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "search", arguments: "{\"q\":\"y\"}" } }] }, finish_reason: "tool_calls" }] }]);
  const r = await A.chat(route, {
    tools: [{ name: "search", description: "d", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "tool_use", id: "c1", name: "search", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "found" }] },
    ],
  }, deps(g));
  assert.deepEqual(g.calls[0].body.messages.slice(1), [
    { role: "assistant", content: "looking", tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "found" },
  ]);
  assert.deepEqual(g.calls[0].body.tools, [{ type: "function", function: { name: "search", description: "d", parameters: { type: "object" } } }]);
  assert.deepEqual([r.stopReason, r.toolCalls], ["tool_use", [{ id: "c2", name: "search", input: { q: "y" } }]]);
  assert.deepEqual(r.content, [{ type: "tool_use", id: "c2", name: "search", input: { q: "y" } }]);
});

test("embeddings: base64 float32 (what the SDK asked for) and plain arrays, in input order", async () => {
  const route = A.resolveRoute("embeddings", { embeddings: { connection: "openai", model: "text-embedding-3-small" } }, {}, registry());
  const floats = new Float32Array([0.1, -0.2, 0.30000001]);
  const b64 = Buffer.from(floats.buffer).toString("base64");
  const f = fakeFetch([200, { data: [{ index: 1, embedding: [1, 2, 3] }, { index: 0, embedding: b64 }], usage: { prompt_tokens: 4 } }]);
  const out = await A.embed(route, ["a", "b"], {}, deps(f));
  assert.deepEqual(f.calls[0].body, { model: "text-embedding-3-small", input: ["a", "b"], encoding_format: "base64" });
  assert.deepEqual(out.vectors[0], Array.from(floats), "base64 must decode to the same float32 bits");
  assert.deepEqual(out.vectors[1], [1, 2, 3]);
  assert.equal(out.dim, 3);
  const one = fakeFetch([200, { data: [{ index: 0, embedding: [1] }] }]);
  await A.embed(route, ["solo"], {}, deps(one));
  assert.equal(one.calls[0].body.input, "solo", "a single text goes as a string, as the SDK sent it");
  await assert.rejects(A.embed(route, ["a", "b"], {}, deps(fakeFetch([200, { data: [{ index: 0, embedding: [1] }] }]))), (e) => e.code === "bad_response");
  await assert.rejects(A.embed(route, ["a"], {}, deps(fakeFetch([200, {}]), {})), (e) => e.code === "key_missing");
});

test("every provider failure maps to one fixed code, and the provider's text never leaves", async () => {
  const cases = [
    [401, {}, "key_rejected"], [403, {}, "key_rejected"], [402, {}, "quota"],
    [429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } }, "quota"],
    [400, { error: { type: "invalid_request_error", message: "Your credit balance is too low" } }, "quota"],
    [404, {}, "model_not_found"], [400, { error: { code: "model_not_found" } }, "model_not_found"],
    [429, {}, "rate_limited"], [500, {}, "server_error"], [529, {}, "server_error"],
    [400, { error: { message: "secret text echoed back sk-live-123" } }, "bad_request"], [302, {}, "bad_response"],
  ];
  for (const [status, body, code] of cases) {
    assert.equal(A.classifyError(status, body, null), code, `${status} ${JSON.stringify(body)}`);
    const f = fakeFetch([status, body]);
    const err = await A.chat({ ...anthropicRoute(), retries: 0 }, { messages: [] }, deps(f)).catch((e) => e);
    assert.equal(err.code, code);
    assert.doesNotMatch(err.message, /sk-live|exceeded|credit balance|echoed/, "provider text reached the error message");
  }
  assert.equal(A.classifyError(null, null, Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
  assert.equal(A.classifyError(null, null, new TypeError("fetch failed")), "network");
});

test("retries: only network/429/5xx, at most route.retries, honouring retry-after; never a 4xx; never past an abort", async () => {
  const waits = [];
  const d = (f) => ({ ...deps(f), sleep: async (ms) => { waits.push(ms); } });
  const f = fakeFetch([429, {}, { "retry-after": "3" }], [503, {}], [200, { content: [{ type: "text", text: "ok" }] }]);
  assert.equal((await A.chat(anthropicRoute(), { messages: [] }, d(f))).text, "ok");
  assert.equal(f.calls.length, 3);
  assert.deepEqual(waits, [3000, 1000]);
  const g = fakeFetch([401, {}]);
  await assert.rejects(A.chat(anthropicRoute(), { messages: [] }, d(g)), (e) => e.code === "key_rejected");
  assert.equal(g.calls.length, 1, "a rejected key was retried");
  const h = fakeFetch([503, {}]);
  await assert.rejects(A.chat({ ...anthropicRoute(), retries: 0 }, { messages: [] }, d(h)));
  assert.equal(h.calls.length, 1, "retries: 0 still retried");
  const ac = new AbortController();
  ac.abort();
  const i = fakeFetch([200, { content: [] }]);
  await assert.rejects(A.chat(anthropicRoute(), { messages: [], signal: ac.signal }, { ...deps((...a) => { const p = i(...a); return p.then(() => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }); }) }), (e) => e.code === "aborted");
});

test("a redirect is refused and the key is never sent on to it; a missing key never makes a request", async () => {
  const f = fakeFetch([307, "", { location: "https://evil.example/v1/messages" }]);
  await assert.rejects(A.chat({ ...anthropicRoute(), retries: 0 }, { messages: [] }, deps(f)), (e) => e.code === "bad_response");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.redirect, "manual");
  const g = fakeFetch([200, {}]);
  await assert.rejects(A.chat(anthropicRoute(), { messages: [] }, deps(g, {})), (e) => e.code === "key_missing");
  assert.equal(g.calls.length, 0);
  await assert.rejects(A.chat({ slot: "x", enabled: false, reason: "off" }, { messages: [] }, deps(g)), (e) => e.code === "off");
});

test("Detect: ids only, safe characters, sorted and capped — Ollama's /v1/models shape", async () => {
  const f = fakeFetch([200, { object: "list", data: [{ id: "llama3.2:latest" }, { id: "nomic-embed-text:latest" }, { id: "bad id<script>" }, { id: "a".repeat(200) }] }]);
  const out = await A.listModels({ id: "local", kind: "openai-compatible", baseUrl: "http://10.0.0.5:11434/v1", keyName: "ai.connection.local.apiKey" }, deps(f, {}));
  assert.deepEqual(out.models, ["llama3.2:latest", "nomic-embed-text:latest"]);
  assert.equal(f.calls[0].url, "http://10.0.0.5:11434/v1/models");
  assert.equal("authorization" in f.calls[0].init.headers, false, "a keyless local server was sent a bearer");
  const p = await A.probe(anthropicRoute(), { ...deps(fakeFetch([200, { content: [{ type: "text", text: "ok" }] }])), now: (() => { let t = 0; return () => (t += 5); })() });
  assert.deepEqual(p, { ok: true, code: "ok", latencyMs: 5 });
});

test("health: a hard code alarms at once, anything else after a run of three, one alert per episode, reset by a success", () => {
  const at = "2026-10-08T12:00:00.000Z";
  let h = null;
  let r = A.nextHealth(h, { ok: false, code: "server_error" }, at);
  assert.equal(r.alert, null);
  assert.equal(A.healthStatus(r.health), "flaky");
  r = A.nextHealth(r.health, { ok: false, code: "timeout" }, "2026-10-08T12:01:00.000Z");
  assert.equal(r.alert, null);
  r = A.nextHealth(r.health, { ok: false, code: "network" }, "2026-10-08T12:02:00.000Z");
  assert.equal(r.alert, "failing", "a run of three did not alarm");
  assert.equal(r.health.failingSince, at, "failingSince is the FIRST failure of the run");
  assert.equal(A.healthStatus(r.health), "failing");
  r = A.nextHealth(r.health, { ok: false, code: "network" }, at);
  assert.equal(r.alert, null, "a fourth failure alarmed again");
  r = A.nextHealth(r.health, { ok: true }, "2026-10-08T12:05:00.000Z");
  assert.deepEqual([r.alert, r.health.consecutive, r.health.failingSince, A.healthStatus(r.health)], [null, 0, null, "ok"]);
  r = A.nextHealth(r.health, { ok: false, code: "key_rejected" }, at);
  assert.equal(r.alert, "key_rejected", "a rejected key waited for a run");
  assert.equal(A.healthStatus(r.health), "failing");
  r = A.nextHealth(null, { ok: false, code: "provider said <script>" }, at);
  assert.equal(r.health.lastCode, "http_error", "a code outside the fixed set was kept");
  h = r.health;
  assert.equal(A.healthStatus(null), "ok");
  assert.ok(h, "vacuity: the last case ran");
});

test("the memory panel's embed probe: a candidate route, its vector length, `dimensions` only when asked, Anthropic refused", async () => {
  const f = fakeFetch([200, { data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.5) }], usage: { prompt_tokens: 1 } }]);
  const openai = A.findConnection("openai", []);
  const r = await A.runCheck("embed", A.candidateEmbedRoute(openai, "text-embedding-3-large"), deps(f), { dimensions: 1536 });
  assert.deepEqual([r.ok, r.code, r.dim], [true, "ok", 1536]);
  assert.equal(f.calls[0].url, "https://api.openai.com/v1/embeddings");
  assert.equal(f.calls[0].body.dimensions, 1536);
  assert.equal(f.calls[0].init.headers.authorization, "Bearer ok-test");
  await A.runCheck("embed", A.candidateEmbedRoute(openai, "m"), deps(f));
  assert.equal("dimensions" in f.calls[1].body, false, "dimensions sent although nobody asked for it");
  const ant = await A.runCheck("embed", A.candidateEmbedRoute(A.findConnection("anthropic", []), "x"), deps(f));
  assert.deepEqual([ant.ok, ant.code], [false, "needs_unmet"]);
  assert.equal(A.candidateEmbedRoute(openai, "bad model <x>"), null);
  assert.deepEqual(await A.runCheck("embed", null, deps(f)), { ok: false, code: "not_configured" });
  const bad = await A.runCheck("embed", A.candidateEmbedRoute(openai, "m"), deps(fakeFetch([401, { error: { message: "no" } }])));
  assert.deepEqual([bad.ok, bad.code], [false, "key_rejected"]);
});

test("renderTemplate fills known names, blanks unknown ones, and touches nothing else", () => {
  assert.equal(A.renderTemplate("Hi {{bot.name}} on {{ site.name }}! {{nope}} {x}", { "bot.name": "Ava", "site.name": "TV" }), "Hi Ava on TV!  {x}");
  assert.equal(A.renderTemplate("{{toString}} {{__proto__}}", {}), " {{__proto__}}", "an inherited name is not a value; a name outside the pattern is left as typed");
});
