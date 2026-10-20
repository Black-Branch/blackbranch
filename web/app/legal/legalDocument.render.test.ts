// The legal page states what THIS install runs (owner decision, review round 4: a beta rewrite).
// Two configurations are built from switch VALUES only — a fresh install's schema defaults, and an
// install with every optional part on (AI features with a plugin bot, YouTube linking, card and
// PayPal payments, Ko-fi and Patreon, Cloudflare in front, a homeserver run elsewhere) — and each
// render is checked for what it must and must not say.
// Run: node --test app/legal/legalDocument.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../lib/testTsx.ts";
process.env.INSTALL_VALUES = JSON.stringify({ "site.name": "Example Stream", "site.origin": "https://example.tv" });
import { INSTANCE_KEYS } from "../lib/instanceSchema.generated.mjs";
import { legalFactsFrom, type LegalInputs } from "./legalFacts.ts";
import type { StreamApiSnapshot } from "../lib/instanceAdminView.ts";
import type { AiRoutesSnapshot } from "../lib/aiAdminView.ts";
import { HOMESERVER_DEFAULT_RETENTION_DAYS, HOMESERVER_GENERAL_RETENTION_DAYS } from "./homeserverRetention.ts";
import { AUTOMOD_HELD_RETENTION_DAYS } from "./automodRetention.ts";
const { LegalDocument } = await import("./LegalDocument.tsx");

const REPO = join(import.meta.dirname, "..", "..", "..");
const defaultOf = (key: string) => INSTANCE_KEYS.find((e) => e.key === key)?.default ?? null;

/** stream-api's /config with each process reporting `values` (stream-api's own keys under self). */
function snapshot(values: Record<string, unknown>, extra: Partial<StreamApiSnapshot> = {}): StreamApiSnapshot {
  const self: NonNullable<StreamApiSnapshot["self"]> = {};
  const ingest: Record<string, { source: string; envName: null; display: unknown; error: null }> = {};
  for (const [key, display] of Object.entries(values)) {
    const e = INSTANCE_KEYS.find((x) => x.key === key);
    assert.ok(e, `unknown key ${key}`);
    const row = { source: "database", envName: null, display, error: null };
    if (e.packages.includes("stream-api")) self[key] = row;
    if (e.packages.includes("stream-ingest")) ingest[key] = row;
  }
  return { self, reports: { "stream-ingest": { at: "2026-01-01T00:00:00Z", state: null, keys: ingest } }, ...extra };
}

const off = { enabled: false as const, reason: "not_configured" };
const via = (connection: string) => ({ enabled: true as const, connection, model: "some-model", source: "db" as const, envName: null });
function slot(id: string, owner: string, route: ReturnType<typeof via> | typeof off, running = true): AiRoutesSnapshot["slots"][number] {
  return { id, kind: id === "embeddings" ? "embed" : "chat", owner, label: id, description: "", needs: [], routes: { "stream-ingest": route }, running };
}

const SWITCHES = ["bot.enabled", "helpdesk.enabled", "automod.enabled", "memory.enabled", "memory.retentionDays",
  "kofi.verificationToken", "patreon.webhookSecret", "streamlabs.socketToken"];

// A fresh install: every switch at the schema's default, no AI routes, nothing configured.
const DEFAULT: LegalInputs = {
  cfg: snapshot(Object.fromEntries(SWITCHES.map((k) => [k, defaultOf(k)]))),
  routes: { slots: ["bot.reply", "automod.classify", "helpdesk.answer", "embeddings"].map((id) => slot(id, "product", off)), providesBot: null, reportedAt: null },
  saved: defaultOf,
  botName: null,
  youtube: { publicData: false, linking: false },
  stripe: false, subscriptions: false, paypal: false, pointsPurchase: false, currencyName: "points", cloudflare: false,
  homeserverRetention: { dms: HOMESERVER_DEFAULT_RETENTION_DAYS, general: HOMESERVER_GENERAL_RETENTION_DAYS },
  errorLogDays: 30,
  plugin: null,
};

// Every optional part on. Made-up names only: a plugin bot, a plugin task, a custom connection.
const EVERYTHING: LegalInputs = {
  cfg: snapshot({
    "bot.enabled": false, "helpdesk.enabled": true, "automod.enabled": true, "memory.enabled": true, "memory.retentionDays": 45,
    "kofi.verificationToken": "(set)", "patreon.webhookSecret": "…abcd", "streamlabs.socketToken": null,
  }, { values: { "ai.connections": [{ id: "localbox", label: "Localbox AI" }] } }),
  routes: {
    slots: [
      slot("bot.reply", "product", off), slot("automod.classify", "product", via("anthropic")),
      slot("helpdesk.answer", "product", via("localbox")), slot("embeddings", "product", via("openai")),
      slot("plugin.reply", "gadget", via("anthropic")),
    ],
    providesBot: "Gadget", reportedAt: null,
  },
  saved: defaultOf,
  botName: "Gadget",
  youtube: { publicData: true, linking: true },
  stripe: true, subscriptions: true, paypal: true, pointsPurchase: true, currencyName: "gems", cloudflare: true,
  homeserverRetention: null,
  errorLogDays: 30,
  plugin: {
    derived: "The plugin also keeps PLUGIN-DERIVED notes.",
    memoryOff: ["PLUGIN-OPTOUT notes about you are deleted too;"],
    more: ["PLUGIN-MORE: its log is deleted after 3 days."],
  },
};

const render = (i: LegalInputs) =>
  renderToStaticMarkup(createElement(LegalDocument, { facts: legalFactsFrom(i) })).replace(/<!-- -->/g, "");

const CROSS_POSTING = "Linking an account is private: the link itself is shown only where you choose to show it. Posting is separate: while an account is linked, your messages here are also posted to that platform unless you pick a different destination in the chat box, and a message posted there carries your name there.";

function common(html: string) {
  assert.ok(html.length > 8000 && /\[contact e-mail not set\]<\/div><\/div><\/div>$/.test(html), "vacuity: the whole page rendered, to its footer");
  assert.ok(html.includes(CROSS_POSTING), "the cross-posting sentences, verbatim");
  assert.match(html, /Direct messages started on Example Stream are end-to-end encrypted/);
  assert.match(html, /Other rooms are encrypted\s+only if encryption was switched on for them/);
  assert.doesNotMatch(html, /Private and direct Matrix rooms are end-to-end encrypted/, "the old, wrong encryption claim");
  assert.match(html, /alejo\.io/);
  // Round 6 L-2: the page said deletion waited for new reports; since round 5 a daily prune runs
  // (clientErrorPrune.ts, started by instrumentation.ts — held by the source test below).
  assert.match(html, /Error reports are\s+deleted once they are 30 days old\.\s*<\/li>/);
  assert.doesNotMatch(html, /as new error\s+reports arrive|until the next ones come in/, "the round-5 sentence: deletion no longer waits for new reports");
  assert.match(html, /the sign-in tokens that platform gives us, stored encrypted/, "linked-account tokens (site.accounts) are named");
}

test("a fresh install's page claims no AI, no payments, no YouTube, no Cloudflare", () => {
  const html = render(DEFAULT);
  common(html);
  assert.match(html, /Example Stream does not use AI features\./);
  assert.doesNotMatch(html, /AI data collection|AI-derived data|Let the bot remember my messages|keeps no log/);
  assert.doesNotMatch(html, /Anthropic|OpenAI/);
  assert.match(html, /Example Stream does not take payments\./);
  assert.match(html, /does not take payments, so there is nothing to refund/);
  assert.doesNotMatch(html, /Stripe|PayPal|Ko-fi|Patreon|Streamlabs|Subscriptions|Gift subscriptions/);
  assert.doesNotMatch(html, /YouTube API Services|YouTube Data API|Manage your YouTube account/);
  assert.match(html, /connect\s+a Twitch, Kick, or other account/, "YouTube is not offered for linking");
  assert.doesNotMatch(html, /Cloudflare/);
  assert.match(html, new RegExp(`after ${HOMESERVER_DEFAULT_RETENTION_DAYS} days, and messages in #general after ${HOMESERVER_GENERAL_RETENTION_DAYS} days`));
  assert.doesNotMatch(html, /PLUGIN-/);
});

test("an install with every part on names each part, its providers and its numbers", () => {
  const html = render(EVERYTHING);
  common(html);
  assert.match(html, /5\. AI features \(Gadget\)/);
  assert.match(html, /a chat participant \(“Gadget”\) that answers in chat/);
  assert.match(html, /automod, which checks chat messages/);
  assert.match(html, /answers to questions asked in the help pop-up/);
  assert.match(html, /The AI features run on Anthropic, Localbox AI, and OpenAI/);
  assert.match(html, /<strong class="text-body-dim">Anthropic, Localbox AI, and OpenAI<\/strong> — the chat messages/);
  assert.match(html, /Each one is deleted automatically after 45 days\./);
  assert.match(html, /Let the bot remember my messages/);
  for (const t of ["PLUGIN-DERIVED", "PLUGIN-OPTOUT", "PLUGIN-MORE"]) assert.ok(html.includes(t), `the plugin's ${t} text`);
  assert.doesNotMatch(html, /keeps no log of its replies/, "the plugin says what it logs; the product line would contradict it");
  assert.match(html, /processed by Stripe and PayPal/);
  assert.match(html, /<strong class="text-body-dim">Stripe<\/strong> — payment processing/);
  assert.match(html, /<strong class="text-body-dim">PayPal<\/strong> — payment processing/);
  assert.match(html, /Ko-fi and Patreon/);
  assert.doesNotMatch(html, /Streamlabs/, "a service with no token is not named");
  assert.match(html, /Subscriptions/);
  assert.match(html, /Gift subscriptions/);
  assert.match(html, /We use the YouTube Data API to read public information/);
  assert.match(html, /If you choose to link your YouTube account/);
  assert.match(html, /connect\s+a Twitch, YouTube, Kick, or other account/);
  assert.match(html, /<strong class="text-body-dim">Cloudflare<\/strong>/);
  assert.doesNotMatch(html, /On our Matrix server/, "a homeserver run elsewhere: its retention is not this page's to state");
});

// AI without a plugin, as the product runs it: helpdesk, automod and memory on, the bot as given.
const PRODUCT_AI = (bot: boolean): LegalInputs => ({
  ...EVERYTHING, plugin: null, botName: null,
  cfg: snapshot({ "bot.enabled": bot, "helpdesk.enabled": true, "automod.enabled": true, "memory.enabled": true, "memory.retentionDays": 45 }),
  routes: {
    ...EVERYTHING.routes!, providesBot: null,
    slots: EVERYTHING.routes!.slots.filter((s) => s.owner === "product").map((s) => (s.id === "bot.reply" ? slot("bot.reply", "product", via("anthropic")) : s)),
  },
});

test("AI with no plugin and no bot: no sentence about a bot's replies (round 5 PB3)", () => {
  const html = render(PRODUCT_AI(false));
  assert.ok(html.length > 8000, "vacuity: the page rendered");
  assert.match(html, /automod, which checks chat messages/, "precondition: AI features are on");
  assert.doesNotMatch(html, /log of its replies|a chat participant/, "an install with no bot says nothing about one");
  assert.doesNotMatch(html, /PLUGIN-|Gadget”\)/);
});

test("the product's own bot: its replies are chat lines, and it keeps no other log", () => {
  const html = render(PRODUCT_AI(true));
  assert.match(html, /a chat participant that answers in chat/, "precondition: the bot is on");
  assert.match(html, /Its replies are chat messages like anyone else’s; it keeps no other log of them\./);
});

// Automod's records, as stream-api/automod.js writes them: site.automod_held (the verdict WITH the
// message text), deleted AUTOMOD_HELD_RETENTION_DAYS after it was held, and site.user_marks (the
// "suspicious" mark, no message text). An open mark automod placed is deleted by the same daily
// job once none of its evidence is left; nothing else deletes a mark (round 6 D-E — see the
// source test below).
const AUTOMOD_KEPT = /<strong class="text-body-dim">AI-derived data:<\/strong>[^<]*automod keeps a record of each chat message it judges risky: the message’s text, who sent it, the kind of risk it saw, how sure it was and the reason it gave, for moderators to review\. That record, the message’s text with it, is deleted 30 days after the message was held, whatever a moderator decided\. Someone with several such messages in a short time gets a “suspicious” mark that moderators see; the mark holds no message text\. Automatic marks are removed when their last supporting evidence is deleted \(at the next daily run\); a mark a moderator has cleared is kept as a moderation record with no time limit, also after an account is deleted\./;

test("automod on, memory off: the page names what automod keeps and for how long (round 5 PB3)", () => {
  const i = PRODUCT_AI(false);
  const html = render({ ...i, cfg: snapshot({ "helpdesk.enabled": true, "automod.enabled": true, "memory.enabled": false }) });
  assert.ok(html.length > 8000, "vacuity: the page rendered");
  assert.match(html, AUTOMOD_KEPT);
  assert.doesNotMatch(html, /none is kept/, "the false claim, while automod keeps verdicts and text");
  assert.doesNotMatch(html, /nothing it sees is kept/, "the second false claim");
  assert.match(html, /The AI does not turn chat into memory for later recall; what it does keep is listed under AI-derived data above\./);
});

test("automod on, memory on: both are listed, and the memory switch is not said to clear automod's records", () => {
  const html = render(PRODUCT_AI(false));
  assert.match(html, /AI-derived data:<\/strong> embeddings \(numerical representations\) of chat messages, so the AI can recall earlier chat\. Also, automod keeps/);
  assert.match(html, AUTOMOD_KEPT);
  assert.match(html, /<li>automod’s records of your messages it judged risky stay until they are deleted 30 days after the message was held, and an open “suspicious” mark automod placed stays until the last of those records is deleted: they are moderation records;<\/li>/);
  assert.doesNotMatch(html, /mark stays: they are|mark holds no message text and is kept/, "the round-5 claim that every mark stays");
});

test("AI without automod or memory or plugin notes: nothing is kept, and the page says so", () => {
  const html = render({ ...PRODUCT_AI(false), cfg: snapshot({ "helpdesk.enabled": true }) });
  assert.match(html, /answers to questions asked in the help pop-up/, "precondition: an AI feature is on");
  assert.match(html, /AI-derived data:<\/strong> none is kept: the AI works on chat as it happens\./);
  assert.match(html, /The AI does not remember chat: nothing it sees is kept for later recall\./);
  assert.doesNotMatch(html, /automod keeps/);
});

test("a held message keeps its words with the moderation record, open case or not", () => {
  for (const html of [render(DEFAULT), render(EVERYTHING)]) {
    assert.match(html, /A message held for review keeps its words with that moderation record until 30 days after it was\s+held, whether or not the case is still open; then the record is deleted\./);
  }
});

test("held rows are pruned by automod.js at the page's number; only automod's open marks go, and only with their evidence", () => {
  // The page says a held row goes AUTOMOD_HELD_RETENTION_DAYS after it was held, an automatic mark
  // goes when its last evidence is deleted, and a cleared mark stays. All three are held here: the
  // ONE prune of site.automod_held and the ONE delete of site.user_marks are stream-api/automod.js's,
  // the delete is limited to OPEN marks of source 'automod' with no evidence row left, and the
  // daily run does both (round 6 D-E). L-2's daily error-report prune is held at the end.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && !/testlib/.test(p)) files.push(p);
    }
  };
  for (const d of ["stream-api", "stream-ingest", join("web", "app"), join("web", "lib")]) walk(join(REPO, d));
  assert.ok(files.some((f) => f.endsWith(join("stream-api", "automod.js"))), "vacuity: automod.js was scanned");
  assert.ok(files.length > 300, `vacuity: ${files.length} files scanned`);
  const deleting = (table: string) => files.filter((f) => new RegExp(`DELETE\\s+FROM\\s+site\\.${table}\\b`).test(readFileSync(f, "utf8")));
  assert.deepEqual(deleting("automod_held").map((f) => f.slice(REPO.length + 1)), [join("stream-api", "automod.js")],
    "the held-row prune moved, vanished or gained a second writer — the page's retention sentence must follow");
  assert.deepEqual(deleting("user_marks").map((f) => f.slice(REPO.length + 1)), [join("stream-api", "automod.js")],
    "a second writer deletes marks, or the evidence sweep moved — the page's mark sentences must follow");
  const automod = readFileSync(join(REPO, "stream-api", "automod.js"), "utf8");
  assert.match(automod, /`DELETE FROM site\.automod_held WHERE held_at < now\(\) - make_interval\(days => \$1::int\)`/, "the prune is limited by status or source, or counts from another column");
  const days = /\nconst AUTOMOD_HELD_RETENTION_DAYS = (\d+);\n/.exec(automod);
  assert.ok(days, "automod.js's retention constant moved");
  assert.equal(AUTOMOD_HELD_RETENTION_DAYS, Number(days[1]), "the page's number is not the prune's");
  assert.match(automod, /pool\.query\(PRUNE_SQL, \[AUTOMOD_HELD_RETENTION_DAYS\]\)/, "the prune does not use the constant");
  assert.equal(automod.match(/DELETE FROM site\.user_marks/g)?.length, 1, "automod.js deletes marks in more than one place");
  const sweep = /const MARK_SWEEP_SQL = `([\s\S]*?)`;/.exec(automod)?.[1] ?? "";
  assert.match(sweep, /DELETE FROM site\.user_marks m\s+WHERE m\.source = 'automod' AND m\.cleared_at IS NULL\s+AND NOT EXISTS \(SELECT 1 FROM site\.automod_held h WHERE h\.id = ANY\(m\.evidence\)\)/,
    "the mark sweep reaches a carried, a moderator's or a cleared mark, or one with evidence left");
  assert.match(automod, /const held = await pruneHeld\(\);\s+const marks = await sweepOrphanMarks\(\);/, "the daily run does not sweep marks after the held rows");
  assert.match(automod, /const pruneRun = \(\) => dailyPrune\(\)/, "the timer does not run the daily job");
  // L-2: "deleted once they are N days old" holds on a quiet install only because clientErrorPrune.ts runs daily from boot.
  const errPrune = readFileSync(join(REPO, "web", "app", "lib", "clientErrorPrune.ts"), "utf8");
  assert.match(errPrune, /\nconst DAY_MS = 24 \* 60 \* 60_000;\n/, "the error-report prune is no longer daily");
  assert.match(readFileSync(join(REPO, "web", "instrumentation.ts"), "utf8"), /\n\s+startClientErrorPrune\(\);\n/, "the error-report prune is not started at boot");
});

test("points purchases: what is stored, only when points can be bought", () => {
  const html = render(EVERYTHING);
  assert.match(html, /When you buy gems: the amount, the date, the payment processor’s reference and the gems added to\s+your balance\. Your balance and its history \(gems earned, bought and spent\) are kept with your account\./);
  assert.doesNotMatch(render({ ...EVERYTHING, pointsPurchase: false }), /When you buy/);
  assert.doesNotMatch(render(DEFAULT), /When you buy/);
});

test("subscriptions are described only when a subscription price is set", () => {
  const html = render({ ...EVERYTHING, subscriptions: false });
  assert.ok(html.length > 8000, "vacuity: the page rendered");
  assert.doesNotMatch(html, /<B>Subscriptions|>Subscriptions<|Subscriptions:|subscription status/, "no tier price: no subscriptions");
  assert.match(html, /Gift subscriptions/, "gifts are a one-time card payment and stay");
  assert.match(render(EVERYTHING), /a customer or payment identifier and your subscription status/);
});

test("a switched-on feature whose task has no model is not claimed", () => {
  const facts = legalFactsFrom({ ...DEFAULT, cfg: snapshot({ "automod.enabled": true, "memory.enabled": true }) });
  assert.equal(facts.ai.automod, false);
  assert.equal(facts.ai.memory, false);
});

test("stream-api unreachable: each switch falls back to web's own reading", () => {
  const facts = legalFactsFrom({ ...DEFAULT, cfg: null, routes: null, saved: (k) => (k === "automod.enabled" ? true : defaultOf(k)) });
  assert.equal(facts.ai.automod, true);
  assert.equal(facts.ai.memory, false);
});

test("the numbers come from where the code keeps them", () => {
  const render = readFileSync(join(REPO, "install", "matrix", "render.sh"), "utf8");
  const dms = /default_policy:\s*\n\s*max_lifetime: (\d+)d/.exec(render);
  assert.ok(dms, "the homeserver's default retention moved");
  assert.equal(HOMESERVER_DEFAULT_RETENTION_DAYS, Number(dms[1]));
  const boot = readFileSync(join(REPO, "install", "matrix", "bootstrap.mjs"), "utf8");
  const general = /const GENERAL_RETENTION_MS = (\d+) \* 24 \* 60 \* 60 \* 1000;/.exec(boot);
  assert.ok(general, "#general's retention moved");
  assert.equal(HOMESERVER_GENERAL_RETENTION_DAYS, Number(general[1]));
  const server = readFileSync(join(REPO, "web", "app", "legal", "legalFactsServer.ts"), "utf8");
  assert.match(server, /errorLogDays: PRUNE_AFTER_DAYS,/, "the error-log number is the pruner's own constant");
  assert.match(server, /import \{ PRUNE_AFTER_DAYS \} from "@\/app\/api\/client-error\/route";/);
  assert.match(server, /plugin: pluginPrivacy\(\),\s*\}\);\s*\}\s*$/, "END anchor");
});
