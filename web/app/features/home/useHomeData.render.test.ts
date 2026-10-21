import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mountHook, serveJson } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
import { resetHomeStore } from "../../lib/homeStore.ts";
const { useHomeData } = await import("./useHomeData.ts");

const body = { status: { live: false, viewers: null, community: null }, lastStream: null, news: [], vods: [], threads: [], boards: null, platforms: [], generatedAt: "2026-09-25T12:00:00.000Z" };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => { resetHomeStore(); sessionStorage.clear(); });

test("active: fetches /api/home once on mount and exposes the body", async () => {
  const calls: string[] = [];
  const box = serveJson(body);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => { calls.push(String(url)); return realFetch(url); }) as typeof fetch;
  const h = await mountHook(() => useHomeData(true));
  try {
    await h.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(calls, ["/api/home"]);
    assert.equal(h.current.data?.generatedAt, box.current.generatedAt);
    assert.equal(h.current.loading, false);
    assert.equal(h.current.error, false);
  } finally {
    await h.unmount();
  }
});

test("inactive: no request at all — an unmounted-but-approaching pane must not poll", async () => {
  let calls = 0;
  globalThis.fetch = (() => { calls++; return Promise.resolve(new Response("{}")); }) as typeof fetch;
  const h = await mountHook(() => useHomeData(false));
  try {
    await h.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(calls, 0);
    assert.equal(h.current.data, null);
  } finally {
    await h.unmount();
  }
});

test("a failed fetch sets error and keeps the last good body", async () => {
  serveJson(body);
  const h = await mountHook(() => useHomeData(true));
  // unmount in `finally`: the hook holds a 60s interval, and a failed
  // assertion that skipped the unmount would leave the process alive until the
  // runner gives up.
  try {
    await h.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(h.current.data?.generatedAt, body.generatedAt);
    globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch;
    // jsdom's Event, not Node's — the window's dispatchEvent rejects a foreign Event class.
    await h.act(async () => { window.dispatchEvent(new window.Event("bb:home-refresh")); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(h.current.error, true);
    assert.equal(h.current.data?.generatedAt, body.generatedAt, "the stale body stays on screen");
  } finally {
    await h.unmount();
  }
});

test("a remembered body paints BEFORE the fetch answers, and the fetched body is remembered for the next page", async () => {
  sessionStorage.setItem("home_payload_v1", JSON.stringify({ v: 2, body: { ...body, generatedAt: "2026-09-26T08:00:00.000Z" } }));
  let release!: () => void;
  globalThis.fetch = (() => new Promise<Response>((r) => { release = () => r(json(body)); })) as typeof fetch;
  const h = await mountHook(() => useHomeData(true));
  try {
    assert.equal(h.current.data?.generatedAt, "2026-09-26T08:00:00.000Z", "from the store, fetch still pending");
    await h.act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(h.current.data?.generatedAt, body.generatedAt, "the fetch replaced it");
    assert.equal(JSON.parse(sessionStorage.getItem("home_payload_v1")!).body.generatedAt, body.generatedAt);
  } finally {
    await h.unmount();
  }
});

test("nothing remembered: the server's body shows until the fetch lands", async () => {
  let release!: () => void;
  globalThis.fetch = (() => new Promise<Response>((r) => { release = () => r(json({ ...body, generatedAt: "2026-09-26T10:00:00.000Z" })); })) as typeof fetch;
  const h = await mountHook(() => useHomeData(true, { ...body, generatedAt: "2026-09-26T09:00:00.000Z" }));
  try {
    assert.equal(h.current.data?.generatedAt, "2026-09-26T09:00:00.000Z", "the server's copy");
    await h.act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(h.current.data?.generatedAt, "2026-09-26T10:00:00.000Z", "the fetch (always newer than the server render it follows) replaced it");
  } finally {
    await h.unmount();
  }
});

test("the NEWER of the remembered body and the server's body wins — an older remembered body must not replace the fresh server render", async () => {
  sessionStorage.setItem("home_payload_v1", JSON.stringify({ v: 2, body: { ...body, generatedAt: "2026-09-26T08:00:00.000Z" } }));
  let release!: () => void;
  globalThis.fetch = (() => new Promise<Response>((r) => { release = () => r(json({ ...body, generatedAt: "2026-09-26T10:00:00.000Z" })); })) as typeof fetch;
  const h = await mountHook(() => useHomeData(true, { ...body, generatedAt: "2026-09-26T09:00:00.000Z" }));
  try {
    assert.equal(h.current.data?.generatedAt, "2026-09-26T09:00:00.000Z", "the server's newer body, not the older remembered one");
    await h.act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(h.current.data?.generatedAt, "2026-09-26T10:00:00.000Z");
  } finally {
    await h.unmount();
  }
});
