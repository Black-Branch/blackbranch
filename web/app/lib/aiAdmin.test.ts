// The AI section's server side: the view is status only (a key is
// set / `…abcd` / not set, never a value), it says what each process runs and where the route
// came from, and EVERY /api/admin/ai route authorizes on the server.
// Run: node --test app/lib/aiAdmin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "./testInstallValues.ts";
import { buildAiView, type AiRoutesSnapshot } from "./aiAdminView.ts";
import type { StreamApiSnapshot } from "./instanceAdminView.ts";
import { stripComments } from "./testSource.ts";

const PLANTED = "sk-PLANTED-AI-KEY-MUST-NOT-APPEAR-qq77";
const at = "2026-10-08T12:00:00.000Z";

const cfg: StreamApiSnapshot = {
  state: { loaded: true, loadedAt: at, failingSince: null, masterKey: "ok" },
  values: {
    "ai.mode": "advanced",
    "ai.default": { connection: "local", model: "llama3.2" },
    "ai.connections": [{ id: "local", kind: "openai-compatible", label: "Local", baseUrl: "http://10.0.0.5:11434/v1" }],
    "ai.tasks": { "helpdesk.answer": { enabled: true, connection: "anthropic", model: "claude-x" } },
  },
  meta: {},
  secrets: { "ai.connection.local.apiKey": { last4: "qq77", updatedBy: "@admin:example.tv", updatedAt: at, readable: true, error: null } },
  self: {
    "ai.mode": { source: "database", envName: null, display: "advanced", error: null },
    "anthropic.apiKey": { source: "env", envName: "ANTHROPIC_API_KEY", display: "…aaaa", error: null },
  },
  reports: {
    "stream-ingest": {
      at, state: { loaded: true, loadedAt: at, failingSince: null },
      keys: {
        "openai.apiKey": { source: "unset", envName: null, display: null, error: null },
        "helpdesk.enabled": { source: "database", envName: null, display: true, error: null },
      },
    },
  },
  tests: [],
};

const routes: AiRoutesSnapshot = {
  slots: [
    {
      id: "helpdesk.answer", kind: "chat", owner: "product", label: "Help desk answers", description: "d", needs: [],
      routes: { "stream-api": { enabled: true, connection: "anthropic", model: "claude-x", source: "db", envName: null }, "stream-ingest": { enabled: false, reason: "off" } },
      health: { "stream-api": null, "stream-ingest": { status: "failing", consecutive: 3, failingSince: at, lastCode: "timeout", lastOkAt: null } },
      lockedBy: null,
    },
    {
      id: "p.brain", kind: "chat", owner: "plugin:p", package: "stream-ingest", label: "P", description: "d", needs: ["tools"],
      routes: { "stream-ingest": { enabled: true, connection: "anthropic", model: "claude-y", source: "env", envName: "P_MODEL" } },
      lastReportedAt: at, running: false,
    },
  ],
  usage: { day: "2026-10-08", slots: { "helpdesk.answer": { calls: 4, errors: 1, unchecked: 0, tokensIn: 10, tokensOut: 5 } } },
  memory: { state: null, enabled: false, retentionDays: 90, rows: 0, oldest: null, columnDim: 1536, nextPurge: 0 },
  providesBot: null, reportedAt: at,
};

test("the AI view is status only: a planted key in the env appears nowhere in it", () => {
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = PLANTED;
  try {
    const text = JSON.stringify(buildAiView(cfg, routes));
    assert.ok(!text.includes("PLANTED"), "a key value reached the AI view");
  } finally {
    if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior;
  }
});

test("the AI view: connections with key status, slots per process with source, pins, health, usage", () => {
  const v = buildAiView(cfg, routes);
  assert.equal(v.mode.value, "advanced");
  assert.deepEqual(v.defaultRoute, { connection: "local", model: "llama3.2" });
  assert.equal(v.helpdeskEnabled.value, true);
  assert.deepEqual(v.connections.map((c) => [c.id, c.builtin, c.keyName]), [
    ["anthropic", true, "anthropic.apiKey"], ["openai", true, "openai.apiKey"], ["local", false, "ai.connection.local.apiKey"],
  ]);
  const ant = v.connections[0]!;
  assert.deepEqual(ant.key.packages.map((p) => [p.package, p.source, p.envName, p.display]), [
    ["stream-api", "env", "ANTHROPIC_API_KEY", "…aaaa"], ["stream-ingest", null, null, null],
  ]);
  assert.equal(v.connections[2]!.key.stored?.display, "…qq77");
  const hd = v.slots.find((s) => s.id === "helpdesk.answer")!;
  assert.equal(hd.group, "product");
  assert.deepEqual(hd.task, { enabled: true, connection: "anthropic", model: "claude-x" });
  assert.equal(hd.routes.find((r) => r.package === "stream-ingest")!.health!.status, "failing");
  assert.equal(hd.usage!.calls, 4);
  assert.equal(hd.envPinned, null);
  const p = v.slots.find((s) => s.id === "p.brain")!;
  assert.deepEqual([p.group, p.envPinned, p.running], ["plugin", "P_MODEL", false]);
  assert.equal(v.usageDay, "2026-10-08");
});

test("stream-api unreachable: the view says so instead of showing an empty install", () => {
  const v = buildAiView(null, null);
  assert.equal(v.routesReachable, false);
  assert.equal(v.slots.length, 0);
  assert.equal(v.processes.find((x) => x.package === "stream-api")!.reachable, false);
  assert.equal(v.mode.value, "simple");
});

// ── every route authorizes on the SERVER ─────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const AI_DIR = join(here, "../api/admin/ai");
const routeFiles = readdirSync(AI_DIR, { recursive: true, encoding: "utf8" })
  .filter((p) => p.endsWith("route.ts"))
  .map((p) => ({ path: p, src: stripComments(readFileSync(join(AI_DIR, p), "utf8")) }));

test("every /api/admin/ai handler checks admin first; every MUTATION checks same-origin too", () => {
  assert.ok(routeFiles.length >= 1, "vacuity: no AI admin routes were read");
  let handlers = 0;
  for (const { path, src } of routeFiles) {
    for (const m of src.matchAll(/export async function (GET|PUT|DELETE|POST)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
      handlers++;
      const [, method, body] = m;
      const firstLine = body!.trim().split("\n")[0]!;
      if (method === "GET") assert.match(firstLine, /await requireAdminResponse\(\)/, `${path} GET does not start with the admin check`);
      else assert.match(firstLine, /await requireAdminMutation\(req\)/, `${path} ${method} does not start with the admin + same-origin check`);
      assert.match(body!, /if \(admin instanceof Response\) return admin;/, `${path} ${method} ignores the refusal`);
    }
  }
  assert.ok(handlers >= routeFiles.length, "a route file exports no handler this test recognises");
});

test("the AI section is admin-gated on the server, and the panel imports no server module", () => {
  const page = stripComments(readFileSync(join(here, "../(main)/admin/[section]/page.tsx"), "utf8"));
  assert.match(page, /if \(!\(await requireAdmin\(\)\)\) redirect\("\/"\);/);
  const panel = readFileSync(join(here, "../features/instance/AiPanel.tsx"), "utf8");
  assert.match(panel, /^"use client";/);
  for (const m of panel.matchAll(/^import (type )?[^;]*from "([^"]+)";/gm)) {
    if (m[1]) continue; // type-only: erased
    assert.ok(!/Server|instanceAdminView|aiAdminView|lib\/db/.test(m[2]!), `the client panel imports ${m[2]} at runtime`);
  }
  assert.match(panel, /export default function AiPanel/, "vacuity: the panel was read to its end");
});

test("prompts: every chat task with a default prompt, its default, and this install's own text; the facts and the bot name", () => {
  const withPrompts: AiRoutesSnapshot = {
    ...routes,
    slots: [
      { ...routes.slots[0]!, defaultPrompt: "You are {{bot.name}}." },
      { ...routes.slots[0]!, id: "automod.classify", label: "Automod check", defaultPrompt: "Judge it." },
      { ...routes.slots[0]!, id: "bot.reply", label: "Chat bot", defaultPrompt: null },
      { ...routes.slots[1]!, prompts: [
        { key: "p.voice", label: "P: voice", help: "How it talks.", defaultPrompt: "Code voice." },
        { key: "p.mood", label: "P: mood", help: "", defaultPrompt: "Code mood." },
        { key: "p.broken", label: "P: broken", help: "", defaultPrompt: "" },
      ] },
    ],
  };
  const content = { content: {
    "prompt.helpdesk.answer": { body: "Ours.", updatedBy: "@admin:example.tv", updatedAt: at },
    "prompt.p.voice": { body: "Imported voice.", updatedBy: "import:test", updatedAt: at },
    "helpdesk.facts": { body: "# FAQ", updatedBy: "@admin:example.tv", updatedAt: at },
  } };
  const named: StreamApiSnapshot = {
    ...cfg, values: { ...cfg.values, "bot.name": "Ava" },
    reports: { "stream-ingest": { ...cfg.reports!["stream-ingest"]!, keys: { ...cfg.reports!["stream-ingest"]!.keys, "bot.name": { source: "database", envName: null, display: "Ava", error: null } } } },
  };
  const v = buildAiView(named, withPrompts, content);
  assert.deepEqual(v.prompts.map((p) => [p.slot, p.defaultPrompt, p.own?.body ?? null, p.group, p.help]), [
    ["helpdesk.answer", "You are {{bot.name}}.", "Ours.", "product", null],
    ["automod.classify", "Judge it.", null, "product", null],
    ["p.voice", "Code voice.", "Imported voice.", "plugin", "How it talks."],
    ["p.mood", "Code mood.", null, "plugin", null],
  ], "the bot (no prompt row) is not listed; a plugin's declared prompts are, default vs yours; one without a default is not");
  assert.equal(v.facts?.body, "# FAQ");
  assert.deepEqual([v.botName.value, v.botName.stored], ["Ava", "Ava"]);
  assert.equal(v.contentReachable, true);
  assert.equal(buildAiView(cfg, routes).contentReachable, false, "no content read = said so, not shown as defaults");
});
