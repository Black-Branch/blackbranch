// React #185 ("maximum update depth exceeded") on the home page, from typing in the chat box.
//
// React 19.2 counts consecutive commits that end with work still waiting (a sync, continuous or
// default-priority update queued but not yet rendered) and throws #185 at the 51st. A keystroke is a
// sync commit. If typing queues default-priority work that only React's scheduler task renders — a
// state update from a passive effect, or from a requestAnimationFrame callback — then a browser that
// delivers key input ahead of that task (Safari on the phone that hit this, three nights running)
// adds one to the count per keystroke, and the next keystroke's first setState throws. The page dies.
//
// The harness holds React's scheduler tasks (node: setImmediate) while it types, so only the
// keystrokes' own sync work runs: exactly the order that phone produced. A keystroke must finish its
// own work; it must leave nothing for later.
//
// Run: node --test app/features/chat/composerTypingLoop.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// React's scheduler captures setImmediate when it loads, so the gate goes in BEFORE react-dom.
type Job = () => void;
const realSetImmediate = globalThis.setImmediate;
const gate = { hold: false, queue: [] as Job[] };
(globalThis as unknown as { setImmediate: unknown }).setImmediate = ((fn: (...a: unknown[]) => void, ...args: unknown[]) => {
  if (gate.hold) { gate.queue.push(() => fn(...args)); return 0; }
  return realSetImmediate(fn, ...args);
}) as unknown as typeof setImmediate;

const { dom, React, act, serveJson } = await import("../../lib/testDom.ts");
await import("../../lib/testTsx.ts");

serveJson({});
// A frame callback runs on a timer here, the way a browser runs it between key events.
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 1);
(dom.window as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
if (!dom.window.Element.prototype.scrollIntoView) dom.window.Element.prototype.scrollIntoView = () => {};

const { default: ChatInput } = await import("./ChatInput.tsx");
const { createRoot } = await import("react-dom/client");

const errors: unknown[] = [];
dom.window.addEventListener("error", (e) => { errors.push((e as ErrorEvent).error ?? (e as ErrorEvent).message); e.preventDefault(); });
process.on("uncaughtException", (e) => { errors.push(e); });

const noop = () => {};
function props() {
  return {
    replyTo: null, onClearReply: noop, onRestoreReply: noop, mentionCandidates: [], isMod: false,
    onSendMessage: async () => null, anchorToBottom: noop, matrixId: "@someone:example.org", canonicalId: null,
    onShowTimestampsChange: noop, onShowMatrixNameChange: noop, isPopout: false,
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => realSetImmediate(r));
  await new Promise<void>((r) => setTimeout(r, 20));
}

async function mount() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(ChatInput, props())); });
  await act(async () => { await settle(); });
  const box = host.querySelector("textarea");
  assert.ok(box, "the composer's textarea mounted");
  return { host, box: box as HTMLTextAreaElement, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;

/** One keystroke the way a browser delivers it: the value and caret move, then `input` fires. */
async function key(box: HTMLTextAreaElement, ch: string) {
  valueSetter.call(box, box.value + ch);
  box.setSelectionRange(box.value.length, box.value.length);
  box.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
  // Microtasks (React's sync flush) and timers (frame callbacks) run; scheduler tasks wait.
  await new Promise<void>((r) => setTimeout(r, 2));
}

/** Type `n` characters with React's scheduler tasks held, then release them. Returns the errors seen. */
async function typeBurst(box: HTMLTextAreaElement, n: number) {
  const before = errors.length;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  box.focus();
  gate.hold = true;
  try {
    for (let i = 0; i < n && errors.length === before; i++) await key(box, "abcdefghij"[i % 10]!);
  } finally {
    gate.hold = false;
    for (const job of gate.queue.splice(0)) job();
    await settle();
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  }
  return errors.slice(before);
}

const depth = (es: unknown[]) => es.filter((e) => /Maximum update depth|#185/.test(String((e as Error)?.message ?? e)));

test("typing 80 characters while the browser holds React's scheduler tasks never trips React #185", async () => {
  const m = await mount();
  const seen = await typeBurst(m.box, 80);
  assert.deepEqual(depth(seen).map((e) => String((e as Error).stack ?? e).split("\n").slice(0, 8).join("\n")), [], "a keystroke left work for later and React counted it as a render loop");
  assert.equal(m.box.value.length, 80, "every keystroke reached the box (the harness typed the whole burst)");
  await m.unmount();
});

test("restart: a composer mounted again (a page reload) types the same burst cleanly", async () => {
  const m = await mount();
  const seen = await typeBurst(m.box, 80);
  assert.deepEqual(depth(seen).map(String), []);
  assert.equal(m.box.value.length, 80);
  await m.unmount();
});

test("retry: typing again after the held work has run stays clean, and the box keeps every character", async () => {
  const m = await mount();
  assert.deepEqual(depth(await typeBurst(m.box, 60)).map(String), []);
  assert.deepEqual(depth(await typeBurst(m.box, 60)).map(String), []);
  assert.equal(m.box.value.length, 120);
  await m.unmount();
});
