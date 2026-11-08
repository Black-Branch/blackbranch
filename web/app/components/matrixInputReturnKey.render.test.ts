// The community composer's Return key (Community › Return key, client polish Task 17).
// "send" (the default, unchanged): Enter sends, the keyboard's key says Send, and the send arrow
// follows the viewer's own Send-button setting. "newline": Enter adds a line (the browser's own
// default action, so the handler must NOT prevent it), the keyboard's key says Return, the send
// arrow is always there, and Ctrl/⌘+Enter still sends.
//
// The real MatrixInput on a stub client, swapped in for useMatrixClient() the way
// matrixInputStaging.render.test.ts does it.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/matrixInputReturnKey.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dom, React, act, resetStorage, serveJson } from "../lib/testDom.ts";
import { installResizeObserverStub } from "../lib/testTsx.ts";
import { stripComments, stripCssComments } from "../lib/testSource.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_CTX = pathToFileURL(path.join(WEB, "app", "lib", "MatrixClientContext.tsx")).href;
const SHIM =
  "data:text/javascript," +
  encodeURIComponent(
    `export * from ${JSON.stringify(REAL_CTX)};\n` +
      "export function useMatrixClient() { return globalThis.__returnKeyTestCtx; }\n",
  );
type Hooks = { resolve(s: string, c: unknown, next: (s: string, c: unknown) => unknown): unknown };
(nodeModule as unknown as { registerHooks: (h: Hooks) => void }).registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("file:") && /(^|\/)MatrixClientContext(\.tsx)?$/.test(specifier)) {
      return { url: SHIM, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

installResizeObserverStub();

const { MatrixInput } = await import("./MatrixInput.tsx");
const { createRoot } = await import("react-dom/client");

const noop = () => {};
const ROOM = { roomId: "!general:site.test", currentState: { getStateEvents: () => [] } };
(globalThis as unknown as { __returnKeyTestCtx: unknown }).__returnKeyTestCtx = {
  client: { getUserId: () => "@me:site.test", getMediaConfig: async () => ({}), on: noop, off: noop, removeListener: noop },
  status: "ready", startClient: async () => {}, retry: noop,
  pendingVerification: null, clearPendingVerification: noop, matrixId: "@me:site.test", identityKnown: true,
};

const RETURN_KEY = "chatStyle_mxReturnKey";

function mount(stored?: string) {
  resetStorage();
  serveJson({});
  if (stored) dom.window.localStorage.setItem(RETURN_KEY, stored);
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const submits: string[] = [];
  function Harness() {
    const [value, setValue] = React.useState("first line");
    return React.createElement(MatrixInput as never, { value, onChange: setValue, onSubmit: () => submits.push(value), room: ROOM });
  }
  act(() => root.render(React.createElement(Harness)));
  const field = () => host.querySelector("textarea") as HTMLTextAreaElement;
  const send = () => host.querySelector('button[aria-label="Send"]') as HTMLButtonElement;
  return {
    submits,
    field,
    send,
    /** Fires Enter; returns whether the handler prevented the browser's own action (a new line). */
    async enter(mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) {
      const ev = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...mods });
      await act(async () => { field().dispatchEvent(ev); });
      return ev.defaultPrevented;
    },
    async setMode(mode: "send" | "newline") {
      await act(async () => {
        dom.window.localStorage.setItem(RETURN_KEY, mode);
        dom.window.dispatchEvent(new dom.window.CustomEvent("bb:setting", { detail: RETURN_KEY }));
      });
    },
    unmount() { act(() => root.unmount()); host.remove(); },
  };
}

test("send: unchanged — Enter sends, the key says Send, the arrow follows the Send-button setting", async () => {
  const m = mount();
  assert.equal(m.field().getAttribute("enterkeyhint"), "send");
  assert.equal(m.send().getAttribute("data-send-button"), null, "the arrow is not forced on");
  assert.equal(await m.enter(), true, "Enter's own new line is prevented");
  assert.deepEqual(m.submits, ["first line"]);
  assert.equal(await m.enter({ shiftKey: true }), false, "Shift+Enter still adds a line");
  assert.equal(m.submits.length, 1);
  m.unmount();
});

test("newline: Enter inserts a newline, send button rendered", async () => {
  const m = mount("newline");
  assert.equal(m.field().getAttribute("enterkeyhint"), "enter", "the phone keyboard's key says Return");
  assert.equal(m.send().getAttribute("data-send-button"), "always", "the send arrow is always shown");
  assert.equal(await m.enter(), false, "Enter keeps its own action: a new line");
  assert.deepEqual(m.submits, [], "Enter did not send");
  assert.equal(await m.enter({ ctrlKey: true }), true);
  assert.equal(await m.enter({ metaKey: true }), true);
  assert.deepEqual(m.submits, ["first line", "first line"], "Ctrl/⌘+Enter sends");
  m.unmount();
});

test("restart: the stored choice holds on the next mount", async () => {
  const a = mount("newline");
  a.unmount();
  // mount() clears storage first, so the second mount reads the value it is handed, as a reload reads the stored one.
  const b = mount("newline");
  assert.equal(await b.enter(), false);
  assert.deepEqual(b.submits, []);
  b.unmount();
});

test("retry: switching back and forth while the composer is open takes effect at once", async () => {
  const m = mount();
  await m.setMode("newline");
  assert.equal(await m.enter(), false);
  await m.setMode("send");
  assert.equal(await m.enter(), true);
  assert.equal(m.field().getAttribute("enterkeyhint"), "send");
  await m.setMode("newline");
  assert.equal(m.send().getAttribute("data-send-button"), "always");
  assert.deepEqual(m.submits, ["first line"], "exactly the one Enter in send mode sent");
  m.unmount();
});

test("the stylesheet shows an always-on arrow even with the Send-button setting off", () => {
  const css = stripCssComments(readFileSync(path.join(WEB, "app", "globals.css"), "utf8"));
  assert.match(css, /\.chat-send-btn \{ display: none !important; \}/);
  assert.match(css, /\.chat-send-btn\[data-send-button="always"\] \{ display: flex !important; \}/);
  // The live chat's composer is untouched: it never asks for the arrow.
  const live = stripComments(readFileSync(path.join(WEB, "app", "features", "chat", "ChatInput.tsx"), "utf8"));
  assert.doesNotMatch(live, /data-send-button|enterKeyHint=/);
  assert.match(live.trimEnd().slice(-40), /<\/form>\s*\);\s*\}$/, "vacuity: ChatInput.tsx was read to its end");
});
