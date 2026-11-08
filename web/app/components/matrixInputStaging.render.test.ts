// The community composer's attachments, mounted: a picked file waits as a chip
// with ✕ until Send; Send uploads it and posts the text as its caption; a file
// over the server's limit or an upload that fails says so in the field; a room
// change never carries a staged file into the next room.
//
// The real MatrixInput on a stub client, swapped in for useMatrixClient() the
// way timelineSendFailure.render.test.ts does it.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/components/matrixInputStaging.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dom, React, act, resetStorage, serveJson } from "../lib/testDom.ts";
import { installResizeObserverStub } from "../lib/testTsx.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_CTX = pathToFileURL(path.join(WEB, "app", "lib", "MatrixClientContext.tsx")).href;
const SHIM =
  "data:text/javascript," +
  encodeURIComponent(
    `export * from ${JSON.stringify(REAL_CTX)};\n` +
      "export function useMatrixClient() { return globalThis.__stagingTestCtx; }\n",
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
// jsdom decodes no images: this one "loads" as 640×480 as soon as it is given a source.
class FakeImage {
  naturalWidth = 640;
  naturalHeight = 480;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) { queueMicrotask(() => this.onload?.()); }
}
(globalThis as unknown as { Image: unknown }).Image = FakeImage;
// …and no video: this one reports 1280×720, 4 s, once given a source.
for (const [k, v] of Object.entries({ videoWidth: 1280, videoHeight: 720, duration: 4 })) {
  const proto = k === "duration" ? dom.window.HTMLMediaElement.prototype : dom.window.HTMLVideoElement.prototype;
  Object.defineProperty(proto, k, { get: () => v, configurable: true });
}
Object.defineProperty(dom.window.HTMLMediaElement.prototype, "src", {
  configurable: true,
  set(this: HTMLMediaElement) { queueMicrotask(() => this.onloadedmetadata?.(new dom.window.Event("loadedmetadata") as Event)); },
  get: () => "",
});

const { MatrixInput } = await import("./MatrixInput.tsx");
const { createRoot } = await import("react-dom/client");

const noop = () => {};
function makeRoom(roomId: string) {
  return {
    roomId,
    currentState: { getStateEvents: () => [] },
  };
}
const GENERAL = makeRoom("!general:site.test");
const CLIPS = makeRoom("!clips:site.test");

type Upload = { name: string; type: string };
const MB = 1024 * 1024;
const stub = {
  limit: 10 * MB as number | null,
  failUploads: 0,
  uploads: [] as Upload[],
  sent: [] as { roomId: string; content: Record<string, unknown> }[],
};
let seq = 0;
// A fresh client per test: the upload limit is cached per client, as it is in the app.
const makeClient = () => ({
  getUserId: () => "@me:site.test",
  getMediaConfig: async () => (stub.limit == null ? {} : { "m.upload.size": stub.limit }),
  uploadContent: async (_f: unknown, opts: Upload) => {
    if (stub.failUploads > 0) { stub.failUploads--; throw new Error("network"); }
    stub.uploads.push(opts);
    return { content_uri: `mxc://site.test/m${++seq}` };
  },
  sendEvent: async (roomId: string, _type: string, content: Record<string, unknown>) => {
    stub.sent.push({ roomId, content });
    return { event_id: `$e${stub.sent.length}` };
  },
  on: noop, off: noop, removeListener: noop,
});

function reset(over: Partial<typeof stub> = {}) {
  stub.limit = 10 * MB; stub.failUploads = 0; stub.uploads = []; stub.sent = [];
  Object.assign(stub, over);
  (globalThis as unknown as { __stagingTestCtx: unknown }).__stagingTestCtx = {
    client: makeClient(), status: "ready", startClient: async () => {}, retry: noop,
    pendingVerification: null, clearPendingVerification: noop, matrixId: "@me:site.test", identityKnown: true,
  };
}

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });

function mount(props: Record<string, unknown> = {}) {
  resetStorage();
  serveJson({});
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const submits: string[] = [];
  // The harness reports its state out after each commit (not during render).
  const out: { setRoom: (r: typeof GENERAL) => void; value: string } = { setRoom: noop, value: "" };
  function Harness(extra: Record<string, unknown>) {
    const [value, setValue] = React.useState("");
    const [room, setRoom] = React.useState(GENERAL);
    React.useEffect(() => { out.setRoom = setRoom; out.value = value; }, [value]);
    return React.createElement(MatrixInput as never, {
      value, onChange: setValue, onSubmit: () => submits.push(value), room, ...extra,
    });
  }
  act(() => root.render(React.createElement(Harness, props)));
  const q = <T extends Element>(s: string) => host.querySelector(s) as T | null;
  return {
    host,
    submits,
    value: () => out.value,
    chips: () => [...host.querySelectorAll("[data-attachment-chip]")].map((c) => c.getAttribute("data-attachment-chip")),
    // The field's own note while it is empty, else the line under the chips.
    note: () => q<HTMLElement>("[data-refusal-note]")?.getAttribute("title") ?? q<HTMLElement>("[data-attachment-note]")?.textContent ?? null,
    async pick(...files: File[]) {
      const input = q<HTMLInputElement>('input[type="file"]')!;
      assert.ok(input, "the composer has a file input");
      Object.defineProperty(input, "files", { value: files, configurable: true });
      await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      await settle();
    },
    async type(text: string) {
      const ta = q<HTMLTextAreaElement>("textarea")!;
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(ta, text);
        ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async enter() {
      const ta = q<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        ta.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      await settle();
    },
    async click(sel: string) {
      const b = q<HTMLButtonElement>(sel);
      assert.ok(b, `no ${sel}`);
      await act(async () => { b!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
      await settle();
    },
    async switchRoom(r: typeof GENERAL) { await act(async () => out.setRoom(r)); await settle(); },
    unmount() { act(() => root.unmount()); host.remove(); },
  };
}

const png = (name = "shot.png", bytes = 16) => new File([new Uint8Array(bytes)], name, { type: "image/png" });

test("pick → chip, no upload", async () => {
  reset();
  const m = mount();
  await m.pick(png());
  assert.deepEqual(m.chips(), ["shot.png"], "the picked file waits as a chip");
  assert.ok(m.host.querySelector('[data-attachment-chip] button[aria-label="Remove shot.png"]'), "with its ✕");
  assert.equal(stub.uploads.length, 0, "nothing uploaded");
  assert.equal(stub.sent.length, 0, "nothing posted");
  m.unmount();
});

test("Enter uploads, then sends the caption: the first file carries the text, the others go bare", async () => {
  reset();
  const m = mount();
  await m.pick(png("a.png"), new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" }));
  await m.type("look");
  await m.enter();
  assert.equal(stub.uploads.length, 2);
  assert.equal(stub.sent.length, 2);
  const [first, second] = stub.sent.map((s) => s.content) as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(first.msgtype, "m.image");
  assert.equal(first.body, "look", "the text is the first file's caption");
  assert.equal(first.filename, "a.png");
  assert.equal(first.url, "mxc://site.test/m1");
  assert.deepEqual({ w: (first.info as Record<string, unknown>).w, h: (first.info as Record<string, unknown>).h }, { w: 640, h: 480 });
  assert.equal(second.msgtype, "m.video", "a video posts as a video, so it plays");
  assert.equal(second.body, "clip.mp4", "no caption: body is the file name");
  assert.deepEqual(second.info, { mimetype: "video/mp4", size: 8, w: 1280, h: 720, duration: 4000 }, "the player gets its box and length");
  assert.equal(m.value(), "", "the box is cleared");
  assert.deepEqual(m.chips(), [], "the chips are gone");
  assert.deepEqual(m.submits, [], "the plain text send is not used");
  m.unmount();
});

test("Send button with files staged and no text: body is the file name", async () => {
  reset();
  const m = mount();
  await m.pick(png("b.png"));
  await m.click('button[aria-label="Send"]');
  assert.equal(stub.sent.length, 1);
  assert.equal(stub.sent[0]!.content.body, "b.png");
  m.unmount();
});

test("✕ removes", async () => {
  reset();
  const m = mount();
  await m.pick(png("a.png"), png("b.png"));
  await m.click('button[aria-label="Remove a.png"]');
  assert.deepEqual(m.chips(), ["b.png"]);
  await m.enter();
  assert.deepEqual(stub.uploads.map((u) => u.name), ["b.png"], "only what is still staged is sent");
  m.unmount();
});

test("over the limit → note, no upload", async () => {
  reset({ limit: 1 * MB });
  const m = mount();
  await m.pick(png("big.png", 2 * MB));
  assert.equal(m.note(), "Too large — the limit is 1 MB");
  assert.deepEqual([...m.host.querySelectorAll("[data-note-option]")].map((o) => o.textContent), ["Too large — the limit is 1 MB", "Too large — 1 MB max", "Over 1 MB"],
    "the field gets the short form too, so a phone never shows a cut sentence");
  assert.deepEqual(m.chips(), [], "not staged");
  assert.equal(stub.uploads.length, 0);
  m.unmount();
});

test("rejected upload → note; the file and the text stay", async () => {
  reset({ failUploads: 1 });
  const m = mount();
  await m.pick(png("a.png"));
  await m.type("look");
  await m.enter();
  assert.equal(m.note(), "Couldn't upload a.png — try again");
  assert.equal(stub.sent.length, 0, "nothing posted");
  assert.deepEqual(m.chips(), ["a.png"], "still staged, so Send tries again");
  assert.equal(m.value(), "look", "the caption was not sent, so it is not lost");
  m.unmount();
});

test("retry: the second Send after a rejected upload posts it once, with the caption", async () => {
  reset({ failUploads: 1 });
  const m = mount();
  await m.pick(png("a.png"));
  await m.type("look");
  await m.enter();
  await m.enter();
  assert.equal(stub.sent.length, 1, "posted exactly once");
  assert.equal(stub.sent[0]!.content.body, "look");
  assert.equal(m.note(), null, "the note is gone once it went");
  assert.deepEqual(m.chips(), []);
  m.unmount();
});

test("room change clears staged files", async () => {
  reset();
  const m = mount();
  await m.pick(png("a.png"));
  assert.deepEqual(m.chips(), ["a.png"]);
  await m.switchRoom(CLIPS);
  assert.deepEqual(m.chips(), [], "the chip is gone");
  await m.type("hi");
  await m.enter();
  assert.equal(stub.uploads.length, 0, "nothing uploaded");
  assert.deepEqual(stub.sent, [], "nothing posted to #clips");
  assert.deepEqual(m.submits, ["hi"], "Enter is an ordinary text send again");
  await m.switchRoom(GENERAL);
  assert.deepEqual(m.chips(), [], "and it does not come back in #general");
  m.unmount();
});

test("restart: a remounted composer starts with nothing staged and no note", async () => {
  reset({ limit: 1 * MB });
  const a = mount();
  await a.pick(png("big.png", 2 * MB));
  await a.pick(png("a.png"));
  a.unmount();
  const b = mount();
  assert.deepEqual(b.chips(), []);
  assert.equal(b.note(), null);
  b.unmount();
});

test("paste stages too", async () => {
  reset();
  const m = mount();
  const ta = m.host.querySelector("textarea")!;
  const file = png("pasted.png");
  const ev = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { items: [{ kind: "file", getAsFile: () => file }] } });
  await act(async () => { ta.dispatchEvent(ev); });
  await settle();
  assert.deepEqual(m.chips(), ["pasted.png"]);
  assert.equal(ev.defaultPrevented, true, "the file is not also pasted as text");
  assert.equal(stub.uploads.length, 0, "staged, not uploaded");
  m.unmount();
});

test("up to 10 files are staged", async () => {
  reset();
  const m = mount();
  await m.pick(...Array.from({ length: 12 }, (_, i) => png(`p${i}.png`)));
  assert.equal(m.chips().length, 10);
  m.unmount();
});

// ── From a thread's reply box (Task 10b) ─────────────────────────────────────
// The thread panel and the forum Reply dialog hand the composer the thread they
// are in; every file then carries the same m.thread relation a typed reply does.
const THREAD = (latest = "$latest", rootId = "$root") => ({ rootId, latestId: () => latest });
const threadRel = (fallback: string, rootId = "$root") => ({ rel_type: "m.thread", event_id: rootId, is_falling_back: true, "m.in_reply_to": { event_id: fallback } });

test("thread: a file sent from a thread's box names the thread root, with its caption", async () => {
  reset();
  const m = mount({ thread: THREAD() });
  await m.pick(png("a.png"));
  await m.type("look");
  await m.enter();
  assert.equal(stub.sent.length, 1);
  assert.equal(stub.sent[0]!.roomId, "!general:site.test");
  assert.deepEqual(stub.sent[0]!.content["m.relates_to"], threadRel("$latest"), "the thread relation, exactly");
  assert.equal(stub.sent[0]!.content.body, "look", "the caption goes with it");
  m.unmount();
});

test("thread: several files stay in order — each falls back to the one sent before it", async () => {
  reset();
  const m = mount({ thread: THREAD() });
  await m.pick(png("a.png"), png("b.png"), png("c.png"));
  await m.enter();
  assert.deepEqual(stub.sent.map((s) => s.content["m.relates_to"]), [threadRel("$latest"), threadRel("$e1"), threadRel("$e2")]);
  m.unmount();
});

test("thread: the main composer's file carries no relation at all", async () => {
  reset();
  const m = mount();
  await m.pick(png("a.png"));
  await m.type("look");
  await m.enter();
  assert.equal(stub.sent.length, 1);
  assert.equal("m.relates_to" in stub.sent[0]!.content, false, "a main-channel file is not tied to anything");
  m.unmount();
});

test("thread retry: a rejected upload, then Send again — posted once, still in the thread", async () => {
  reset({ failUploads: 1 });
  const m = mount({ thread: THREAD() });
  await m.pick(png("a.png"));
  await m.type("look");
  await m.enter();
  assert.equal(stub.sent.length, 0);
  await m.enter();
  assert.equal(stub.sent.length, 1, "posted exactly once");
  assert.deepEqual(stub.sent[0]!.content["m.relates_to"], threadRel("$latest"));
  assert.equal(stub.sent[0]!.content.body, "look");
  m.unmount();
});

test("thread restart: a remounted thread composer starts empty and still sends into the thread", async () => {
  reset();
  const a = mount({ thread: THREAD() });
  await a.pick(png("a.png"));
  a.unmount();
  const b = mount({ thread: THREAD("$newer") });
  assert.deepEqual(b.chips(), [], "nothing carried over");
  await b.pick(png("b.png"));
  await b.enter();
  assert.equal(stub.sent.length, 1);
  assert.deepEqual(stub.sent[0]!.content["m.relates_to"], threadRel("$newer"), "the fallback is read at send time");
  b.unmount();
});

test("thread: onSent hears the posted event once every file went", async () => {
  reset();
  const heard: unknown[] = [];
  const m = mount({ thread: THREAD(), onSent: (id: unknown) => heard.push(id) });
  await m.pick(png("a.png"), png("b.png"));
  await m.enter();
  assert.deepEqual(heard, ["$e2"], "called once, with the last event");
  m.unmount();
});
