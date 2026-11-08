// A missing or failed picture shows the coloured letter circle (Discord's), never the browser's
// broken-image icon — INCLUDING a picture that had already failed before React attached its
// onError (a server-rendered <img> whose 404 landed before hydration; a cached 404 that settles
// before commit). React's onError never fires for those, so `useImgFallback` reads the image the
// moment its ref attaches: `complete && naturalWidth === 0` is a picture that has failed.
//
// jsdom loads no images, so each test stubs `complete`/`naturalWidth` on the image BEFORE its ref
// attaches (on the prototype for a client mount; on the server-rendered element for hydration).
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/useImgFallback.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "./testDom.ts";
import "./testTsx.ts";

const { useImgFallback } = await import("./useImgFallback.ts");
const { createRoot, hydrateRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");

// ── The image's load state, per src: what a real browser would report for each picture ─────────
type LoadState = { complete: boolean; naturalWidth: number };
const states = new Map<string, LoadState>();
const proto = dom.window.HTMLImageElement.prototype;
Object.defineProperty(proto, "complete", { configurable: true, get(this: HTMLImageElement) {
  return states.get(this.getAttribute("src") ?? "")?.complete ?? false;
} });
Object.defineProperty(proto, "naturalWidth", { configurable: true, get(this: HTMLImageElement) {
  return states.get(this.getAttribute("src") ?? "")?.naturalWidth ?? 0;
} });
const BROKEN: LoadState = { complete: true, naturalWidth: 0 };
const LOADED: LoadState = { complete: true, naturalWidth: 64 };
const PENDING: LoadState = { complete: false, naturalWidth: 0 };

// A picture-or-letter, the shape every call site has.
function Pic({ src }: { src: string }) {
  const img = useImgFallback(src);
  return img.ok
    ? React.createElement("img", { src, alt: "", ref: img.ref, onError: img.onError })
    : React.createElement("span", { "data-letter": "" }, "K");
}

async function mount(src: string) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Pic, { src })); });
  return {
    host,
    rerender: (s: string) => act(async () => { root.render(React.createElement(Pic, { src: s })); }),
    unmount: () => act(async () => { root.unmount(); host.remove(); }),
  };
}
const shows = (host: Element) => (host.querySelector("img") ? "img" : host.querySelector("[data-letter]") ? "letter" : "nothing");

test("complete + width 0 at mount → fallback (a picture that failed before the ref attached)", async () => {
  states.set("/a/broken", BROKEN);
  const m = await mount("/a/broken");
  assert.equal(shows(m.host), "letter", "the already-failed picture shows the letter, not a broken image");
  await m.unmount();
});

test("incomplete at mount, then loads → image kept", async () => {
  states.set("/a/slow", PENDING);
  const m = await mount("/a/slow");
  assert.equal(shows(m.host), "img", "a picture still loading is left alone");
  states.set("/a/slow", LOADED);
  await act(async () => { m.host.querySelector("img")!.dispatchEvent(new dom.window.Event("load")); });
  assert.equal(shows(m.host), "img", "the loaded picture stays");
  await m.unmount();
});

test("loaded at mount → image kept", async () => {
  states.set("/a/cached", LOADED);
  const m = await mount("/a/cached");
  assert.equal(shows(m.host), "img");
  await m.unmount();
});

test("error after mount → fallback", async () => {
  states.set("/a/late", PENDING);
  const m = await mount("/a/late");
  assert.equal(shows(m.host), "img");
  await act(async () => { m.host.querySelector("img")!.dispatchEvent(new dom.window.Event("error")); });
  assert.equal(shows(m.host), "letter");
  await m.unmount();
});

test("retry: a new picture after a failure is tried again (an avatar change)", async () => {
  states.set("/a/v1", BROKEN);
  states.set("/a/v2", PENDING);
  const m = await mount("/a/v1");
  assert.equal(shows(m.host), "letter");
  await m.rerender("/a/v2");
  assert.equal(shows(m.host), "img", "the new src gets its chance");
  assert.equal(m.host.querySelector("img")!.getAttribute("src"), "/a/v2");
  await act(async () => { m.host.querySelector("img")!.dispatchEvent(new dom.window.Event("error")); });
  assert.equal(shows(m.host), "letter", "and falls back again when it too fails");
  await m.unmount();
});

test("restart: a fresh mount (a reload) tries the picture again — kept when it now loads, letter when still broken", async () => {
  states.set("/a/flaky", BROKEN);
  const first = await mount("/a/flaky");
  assert.equal(shows(first.host), "letter");
  await first.unmount();
  states.set("/a/flaky", LOADED);
  const second = await mount("/a/flaky");
  assert.equal(shows(second.host), "img", "nothing stale carries a failure across a remount");
  await second.unmount();
  states.set("/a/flaky", BROKEN);
  const third = await mount("/a/flaky");
  assert.equal(shows(third.host), "letter");
  await third.unmount();
});

test("hydration: a server-rendered picture whose 404 landed before React → the letter, no mismatch error", async () => {
  // The real defect: the server sends <img src=…>, the browser fails it while the JS is still
  // loading, and React — attaching onError afterwards — never hears the error event.
  const src = "/a/ssr-broken";
  const html = renderToString(React.createElement(Pic, { src }));
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;
  dom.window.document.body.appendChild(host);
  const img = host.querySelector("img")!;
  assert.ok(img, "the server rendered the picture");
  // Stubbed on THIS element, before the ref attaches: it has already failed.
  Object.defineProperty(img, "complete", { value: true, configurable: true });
  Object.defineProperty(img, "naturalWidth", { value: 0, configurable: true });
  const recoverable: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | null = null;
  await act(async () => {
    root = hydrateRoot(host, React.createElement(Pic, { src }), { onRecoverableError: (e) => { recoverable.push(e); } });
  });
  assert.deepEqual(recoverable, [], "hydration itself matched");
  assert.equal(shows(host), "letter", "the broken picture became the letter after hydration");
  await act(async () => { root!.unmount(); });
  host.remove();
});

test("vacuity: the hook module was read and exports the hook", () => {
  const src = readFileSync(new URL("./useImgFallback.ts", import.meta.url), "utf8");
  assert.match(src, /export function useImgFallback\(/);
  assert.equal(typeof useImgFallback, "function");
});
