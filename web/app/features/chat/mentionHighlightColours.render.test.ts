// Ticket #229: a viewer can colour mentions and highlights, and the two are separate.
//
// The defect: a message that names you (or replies to you) and a message that contains one of
// your highlight words (Behavior › Words) were the SAME row — one class, one hard-coded amber —
// so neither could be told apart or recoloured. Now the live chat marks them apart
// (`chat-row-mention` / `chat-row-word`), and each colour is one CSS variable a setting writes
// (`--chat-mention` / `--chat-highlight`), with today's amber as the fallback when it is unset.
//
// Run: node --test app/features/chat/mentionHighlightColours.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dom, React, act } from "../../lib/testDom.ts";
import { installResizeObserverStub, installRafStub } from "../../lib/testTsx.ts";

installResizeObserverStub();
installRafStub();
for (const k of ["HTMLElement", "Node", "Element"] as const) {
  (globalThis as Record<string, unknown>)[k] ??= dom.window[k];
}
const { default: ChatMessage } = await import("./ChatMessage.tsx");
const { useChatRowDerivations } = await import("../../lib/useChatRowDerivations.ts");
const { ENTRIES, DEFAULTS, applyEffect, readValues, settingSet } = await import("../../lib/settingsRegistry.ts");
const { createRoot } = await import("react-dom/client");

type Props = Parameters<typeof ChatMessage>[0];
type Msg = Props["msg"];

const mounted: (() => Promise<void>)[] = [];
test.afterEach(async () => { for (const u of mounted.splice(0)) await u(); });

async function mount(el: React.ReactElement): Promise<HTMLElement> {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  mounted.push(async () => { await act(async () => { root.unmount(); }); host.remove(); });
  return host;
}

const line = (id: number, username: string, message: string, extra: Partial<Msg> = {}) =>
  ({ id, platform: "native", username, matrixId: `@${username.toLowerCase()}:site.test`, message, ts: id, ...extra }) as unknown as Msg;

async function rowOf(props: Partial<Props> & { msg: Msg }): Promise<HTMLElement> {
  const host = await mount(React.createElement(ChatMessage, { emotes: {}, ...props }));
  const row = host.querySelector(".chat-msg-row");
  assert.ok(row, "the chat row did not render");
  return row as HTMLElement;
}

// ── The rows: a mention and a highlight are different marks ───────────────────

test("a mention row carries the mention mark, not the highlight mark", async () => {
  const row = await rowOf({ msg: line(1, "Robin", "@casey hello"), highlight: true });
  assert.ok(row.classList.contains("chat-row-mention"));
  assert.ok(!row.classList.contains("chat-row-word"), "a mention painted as a highlight");
});

test("a highlight row (one of your words) carries the highlight mark, not the mention mark", async () => {
  const row = await rowOf({ msg: line(2, "Robin", "tacos tonight"), wordHighlight: true });
  assert.ok(row.classList.contains("chat-row-word"), "a highlight-word row has no mark of its own");
  assert.ok(!row.classList.contains("chat-row-mention"), "a highlight-word row still wears the mention mark");
});

test("a highlight-word reply does not colour its reply line as 'to you'", async () => {
  const host = await mount(React.createElement(ChatMessage, {
    emotes: {}, wordHighlight: true,
    msg: line(3, "Robin", "tacos", { reply_to_username: "Sam", reply_to_message: "hi", reply_to_id: 9 } as Partial<Msg>),
  }));
  assert.equal(host.querySelector(".chat-reply-me"), null, "the reply line says 'to you' for a reply to someone else");
});

test("original path: an ordinary row carries neither mark", async () => {
  const row = await rowOf({ msg: line(4, "Robin", "hello") });
  assert.ok(!row.classList.contains("chat-row-mention") && !row.classList.contains("chat-row-word"));
});

// ── The derivation: who decides which mark a row gets ─────────────────────────

type Rows = ReturnType<typeof useChatRowDerivations>;
async function derive(messages: Msg[], words: string[]): Promise<Rows> {
  let out: Rows | null = null;
  function Probe() { out = useChatRowDerivations({ messages, rendered: messages, userId: "@casey:site.test", ownIds: null, ownColor: null, words }); return null; }
  await mount(React.createElement(Probe));
  assert.ok(out, "the hook did not run");
  return out;
}

test("the derivation sends a name to the mention mark and a word to the highlight mark", async () => {
  const msgs = [line(10, "Robin", "@casey look"), line(11, "Robin", "tacos tonight"), line(12, "Robin", "@casey tacos"), line(13, "Robin", "plain")];
  const d = await derive(msgs, ["tacos"]);
  const marks = d.rows.map((r) => [r.highlight, r.wordHighlight]);
  assert.deepEqual(marks, [[true, false], [false, true], [true, false], [false, false]],
    "a name is a mention; a word alone is a highlight; both = mention (it is about you)");
  // The mention sound still fires for both, as before.
  assert.deepEqual(msgs.map((m) => d.mentionsMe(m)), [true, true, true, false]);
});

test("your own message is never marked, even when it holds one of your words", async () => {
  const d = await derive([line(20, "Casey", "tacos @casey")], ["tacos"]);
  assert.deepEqual([d.rows[0]?.highlight, d.rows[0]?.wordHighlight], [false, false]);
});

// ── The settings: one variable each, removed (not blanked) at Default ─────────

const ctx = {} as Parameters<typeof applyEffect>[2];
const root = () => dom.window.document.documentElement.style;

test("Mention colour and Highlight colour each write their own variable", () => {
  assert.equal(DEFAULTS.mentionColor, "", "Default must be 'unset', so the CSS keeps today's colour");
  assert.equal(DEFAULTS.highlightColor, "");
  applyEffect("mentionColor", "#ff0000", ctx);
  applyEffect("highlightColor", "#00ff00", ctx);
  assert.equal(root().getPropertyValue("--chat-mention"), "#ff0000");
  assert.equal(root().getPropertyValue("--chat-highlight"), "#00ff00");
  applyEffect("mentionColor", "", ctx);
  assert.equal(root().getPropertyValue("--chat-mention"), "", "Default left a blank value instead of removing it");
  assert.equal(root().getPropertyValue("--chat-highlight"), "#00ff00", "resetting one moved the other");
  applyEffect("highlightColor", "", ctx);
});

test("both are prePaint looks: a reload restores them before first paint", () => {
  for (const k of ["mentionColor", "highlightColor"] as const) {
    assert.equal(ENTRIES[k].prePaint, true, `${k} would flash the default on reload`);
    assert.ok(!ENTRIES[k].behavior, `${k} is a look: Reset and saved looks carry it`);
  }
  const layout = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
  assert.match(layout, /getItem\('chatStyle_mentionColor'\)[\s\S]{0,40}\n[^\n]*setProperty\('--chat-mention', _mnc\)/);
  assert.match(layout, /getItem\('chatStyle_highlightColor'\)[\s\S]{0,40}\n[^\n]*setProperty\('--chat-highlight', _hlc\)/);
});

test("restart: a stored colour survives a fresh read of the settings, and a retry changes it again", () => {
  settingSet(ENTRIES.mentionColor.ls, "#123456");
  assert.equal(readValues().mentionColor, "#123456", "the stored colour was lost on reload");
  settingSet(ENTRIES.mentionColor.ls, "#abcdef");
  assert.equal(readValues().mentionColor, "#abcdef", "a second change did not take");
  settingSet(ENTRIES.mentionColor.ls, "");
  assert.equal(readValues().mentionColor, "", "back to Default");
});

// ── The CSS: every surface reads the same two variables, today's colours as fallback ──

const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const rule = (sel: string) => {
  const at = css.indexOf(sel + " {");
  assert.ok(at >= 0, `rule ${sel} is missing`);
  return css.slice(at, css.indexOf("}", at) + 1);
};

test("mention rows (live chat AND Community) read --chat-mention, falling back to today's amber", () => {
  assert.match(rule("html:not(.chat-mention-hl-off) .chat-msg-row.chat-row-mention"),
    /background: color-mix\(in srgb, var\(--chat-mention, #f0b464\) 8%, transparent\);/);
  assert.match(rule("html:not(.chat-mention-hl-off) .chat-reply-me"), /color: var\(--chat-mention, #f0b464\);/);
  assert.match(rule("html:not(.chat-mention-hl-off) .chat-row-mention-mx"),
    /border-left: 2px solid var\(--chat-mention, rgb\(251 191 36\)\);/);
  assert.match(rule("html:not(.chat-mention-hl-off) .chat-row-mention-mx:not([data-hl])"),
    /background: color-mix\(in srgb, var\(--chat-mention, rgb\(251 191 36\)\) 10%, transparent\);/);
});

test("highlight rows read --chat-highlight, falling back to today's amber, and lose to a mention", () => {
  assert.match(rule("html:not(.chat-mention-hl-off) .chat-msg-row.chat-row-word"),
    /background: color-mix\(in srgb, var\(--chat-highlight, #f0b464\) 8%, transparent\);/);
  const up = css.indexOf(".chat-msg-row.chat-row-up {"), word = css.indexOf(".chat-msg-row.chat-row-word {"),
    men = css.indexOf(".chat-msg-row.chat-row-mention {");
  assert.ok(up >= 0 && up < word && word < men, "order must be upvote < highlight < mention (last wins)");
});

test("the menu puts both colours in one Colours group with a preview", async () => {
  const { SECTIONS, WINDOW_ONLY_KEYS } = await import("../../lib/settingsMenu.ts");
  const sec = SECTIONS.find((s) => s.title === "Mentions & highlights");
  assert.ok(sec, "no Mentions & highlights group");
  assert.equal(sec.tab, "colours");
  assert.deepEqual(sec.items.map((i) => i.key), ["mentionColor", "highlightColor"]);
  assert.equal(sec.preview, "mentionColours");
  assert.equal(ENTRIES.mentionColor.control.label, "Mention colour");
  assert.equal(ENTRIES.highlightColor.control.label, "Highlight colour");
  // The /chat window shows mentions and highlights too.
  assert.ok(WINDOW_ONLY_KEYS.has("mentionColor") && WINDOW_ONLY_KEYS.has("highlightColor"));
});

test("vacuity: globals.css and ChatMessage.tsx were read to their end", () => {
  assert.match(css, /\n\S[^\n]*\n*$/, "globals.css read empty");
  assert.ok(css.length > 50_000, "globals.css read short");
  const row = readFileSync(join(process.cwd(), "app", "features", "chat", "ChatMessage.tsx"), "utf8");
  assert.match(row.trimEnd(), /\}\);$/, "ChatMessage.tsx did not end at its memo close");
});
