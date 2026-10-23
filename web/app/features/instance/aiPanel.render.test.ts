// Admin Panel → AI, mounted page by page: Simple shows one model for everything and keeps the
// per-service table, Detect and the tuning numbers out of sight; Advanced and the Advanced folds
// hold them. The sentences are the short ones the panel review agreed.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/aiPanel.render.test.ts
import "../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: AiPanel } = await import("./AiPanel.tsx");
const { buildAiView } = await import("../../lib/aiAdminView.ts");
const { buildInstanceView } = await import("../../lib/instanceAdminView.ts");
const { createRoot } = await import("react-dom/client");

type View = ReturnType<typeof buildAiView>;
const route = { enabled: true, connection: "anthropic", model: "model-a", source: "db" } as never;
function aiView(over: Partial<View> = {}): View {
  const v = buildAiView(null, null);
  return {
    ...v,
    routesReachable: true,
    slots: [
      { id: "bot.reply", kind: "chat", group: "product", owner: "product", label: "Chat bot replies", description: "Answers mentions.", needs: [],
        running: true, lockedBy: null, routes: [{ package: "stream-ingest", route, health: null }], envPinned: null, task: { enabled: true }, usage: null },
      { id: "automod.classify", kind: "chat", group: "product", owner: "product", label: "Automod check", description: "Checks messages.", needs: [],
        running: true, lockedBy: null, routes: [{ package: "stream-api", route, health: null }], envPinned: null, task: { enabled: true }, usage: null },
    ],
    prompts: [{ slot: "automod.classify", label: "Automod policy", defaultPrompt: "Be careful.", own: null, group: "product", help: null }],
    memory: { state: { model: "embed-1", connection: "openai", dim: 1536, since: "2026-10-01T00:00:00Z", status: "on" }, enabled: true, retentionDays: 90, rows: 1200, oldest: "2026-10-01T00:00:00Z", columnDim: 1536, nextPurge: 0 },
    bot: { speakOn: { site: true, twitch: "casey_bot" }, replies: 0, skippedUnlinked: 0, screened: 0, failed: 0, cooldown: 0 },
    ...over,
  } as View;
}

let served: View = aiView();
globalThis.fetch = (async () => new Response(JSON.stringify(served), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

async function mount(sub: string, v: View) {
  served = v;
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(AiPanel as never, { sub, inst: buildInstanceView(null), reloadInst: () => {}, note: () => {} }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}
const buttons = (el: Element, text: string) => [...el.querySelectorAll("button")].filter((b) => b.textContent === text);
const simple = (over: Partial<View> = {}) => aiView({ mode: { value: "simple", sources: [] }, ...over });
const advanced = (over: Partial<View> = {}) => aiView({ mode: { value: "advanced", sources: [] }, ...over });

test("Models, Simple: one line for the mode; no per-service table, no Detect, no token cap; each connection says whether its key is set", async () => {
  const { el, done } = await mount("models", simple());
  assert.equal(el.querySelector("[data-mode-line]")?.textContent, "Simple: one model for everything. Advanced: pick a model per task.");
  assert.ok(el.querySelectorAll("[data-connection]").length >= 2, "vacuity: the built-in connections are listed");
  assert.deepEqual(buttons(el, "Detect models"), []);
  assert.deepEqual(buttons(el, "Detect"), []);
  assert.equal(el.querySelector('[aria-label="Key, per service"]'), null);
  assert.equal(el.querySelectorAll("[data-key-summary]").length, el.querySelectorAll("[data-connection]").length);
  await done();
});

test("Models, Advanced: the per-service table, Detect and the token cap are there", async () => {
  const { el, done } = await mount("models", advanced());
  assert.equal(el.querySelector("[data-mode-line]")?.textContent, "Simple: one model for everything. Advanced: pick a model per task.");
  assert.ok(buttons(el, "Detect models").length >= 2);
  assert.ok(el.querySelector('[aria-label="Key, per service"]'));
  assert.equal(el.querySelector("[data-key-summary]"), null);
  await done();
});

test("the chat service not answering is one plain sentence that says what to do", async () => {
  const { el, done } = await mount("models", simple({ routesReachable: false }));
  assert.ok(el.textContent?.includes("The chat service is not answering. Restart it from the server, then reload this page."));
  await done();
});

test("a task row in Simple says what it runs on in one line; Advanced lists it per service", async () => {
  const s = await mount("bot", simple());
  assert.ok(s.el.querySelector('[data-slot="bot.reply"] [data-runs-on]')?.textContent?.includes("anthropic · model-a"));
  assert.equal(s.el.querySelector('[aria-label="What it runs on, per service"]'), null);
  await s.done();
  const a = await mount("bot", advanced());
  assert.equal(a.el.querySelector("[data-runs-on]"), null);
  assert.ok(a.el.querySelector('[aria-label="What it runs on, per service"]'));
  await a.done();
});

test("Chat Bot: the sentence says which platforms it answers on; Bot usernames are under a closed Advanced fold", async () => {
  const { el, done } = await mount("bot", simple());
  assert.equal(el.querySelector("[data-answers-on]")?.textContent?.split(". It sends")[0],
    "Answers messages that mention its name on the site and Twitch. Mentions on YouTube, Kick and Streamplace are skipped");
  const fold = el.querySelector('section[aria-label="Advanced"] details');
  assert.ok(fold, "an Advanced fold");
  assert.equal((fold as HTMLDetailsElement).open, false);
  await done();
  const { answersOn } = await import("./AiPanel.tsx");
  assert.equal(answersOn({ site: true, twitch: null }), "Answers messages that mention its name on the site. Mentions on Twitch, YouTube, Kick and Streamplace are skipped.");
  assert.match(answersOn({ site: false, twitch: null }), /nowhere yet/);
});

test("Automod: switch, skip supporters and the explanation up top; the five numbers under a closed Advanced fold; the policy line; categories after the policy", async () => {
  const { el, done } = await mount("automod", simple());
  const card = el.querySelector('section[aria-label="Automod"]')!;
  assert.ok(card.textContent?.includes("Check chat messages") && card.textContent.includes("Do not check paying supporters"));
  const fold = card.querySelector("details")!;
  assert.equal(fold.open, false, "closed");
  assert.equal(fold.querySelector("summary")?.textContent, "Advanced");
  assert.equal(fold.querySelectorAll("[data-automod-numbers] input").length, 5, "the five tuning numbers, in the fold");
  assert.equal(card.querySelectorAll("input").length, 5, "nothing else to type outside the fold");
  assert.ok(el.textContent?.includes("What counts as risky, in your words. The categories below are added for you."));
  const order = [...el.querySelectorAll("section[aria-label]")].map((s) => s.getAttribute("aria-label"));
  assert.ok(order.indexOf("Prompts") >= 0 && order.indexOf("Categories") === order.indexOf("Prompts") + 1, order.join(", "));
  await done();
});

test("Embeddings: memory's state is one sentence; changing the embedder and the word floor are under Advanced", async () => {
  const { el, done } = await mount("embeddings", simple());
  const status = el.querySelector("[data-memory-status]")!;
  assert.match(status.textContent ?? "", /^Memory is on with openai · embed-1: 1,200 messages kept since .+, kept for 90 days\.$/);
  assert.equal(el.querySelector("dl"), null, "no table of facts");
  const fold = el.querySelector('section[aria-label="Memory"] details') as HTMLDetailsElement;
  assert.equal(fold.open, false);
  assert.ok(buttons(fold, "Change embedder…").length === 1, "Change embedder is in the fold");
  assert.ok(fold.querySelector("[data-word-floor]"), "the word floor is in the fold");
  assert.equal(buttons(el, "Change embedder…").length, 1, "and nowhere else");
  assert.ok(el.textContent?.includes("Keep memories for"), "the retention picker stays outside");
  await done();
  const off = await mount("embeddings", simple({ memory: { state: null, enabled: false, retentionDays: null, rows: 0, oldest: null, columnDim: 1536, nextPurge: 0 } }));
  assert.equal(off.el.querySelector("[data-memory-status]")?.textContent, "Memory is off.");
  assert.ok(buttons(off.el, "Turn on memory").length === 1);
  await off.done();
});
