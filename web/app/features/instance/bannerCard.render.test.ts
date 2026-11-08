// Admin Panel › Site › Community › Banner, mounted in the Community page: the card shows the
// community's banner (or says there is none), uploads a picture as multipart to the banner route,
// refuses a wrong type or an oversized file before sending anything, and Remove clears it.
// Run: systemd-run --user --scope -p MemoryMax=8G env -u DATABASE_URL node --test app/features/instance/bannerCard.render.test.ts
import "../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: CommunityPanel } = await import("./CommunityPanel.tsx");
const { createRoot } = await import("react-dom/client");

const MXC = "mxc://example.test/banner1";
const hub = (bannerMxc: string | null) => ({ id: 1, parentId: null, kind: "hub", name: "Community", topic: null, avatarMxc: null, bannerMxc, orderKey: "a0", matrixRoomId: "!hub:example.test", gateTier: null });
const view = (bannerMxc: string | null) => ({
  spaces: [hub(bannerMxc)], rooms: [], roles: [], lastApply: null, lastReport: null, latestStartedAt: null,
  reconciler: true, canAsk: true, host: null, hostReport: null, retentionCapDays: 180,
});

let current: string | null = null;
let sent: { url: string; method: string; body: unknown }[] = [];
let notes: string[] = [];
let answer = { status: 200, body: { ok: true, bannerMxc: MXC, requestedAt: null as string | null } as Record<string, unknown> };
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  sent.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
  if (String(url) === "/api/admin/community") return Response.json(view(current));
  return Response.json(answer.body, { status: answer.status });
}) as typeof fetch;

async function mount() {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(CommunityPanel as never, { inst: null, reloadInst: () => {}, note: (m: string) => { notes.push(m); } })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}
const card = (el: Element) => el.querySelector('section[aria-label="Banner"]');
const text = (n: Element | null | undefined) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
const reset = (banner: string | null) => { current = banner; sent = []; notes = []; answer = { status: 200, body: { ok: true, bannerMxc: MXC, requestedAt: null } }; };

/** Choose a file in the card's picker, as a person does. */
async function pick(el: Element, file: File) {
  const input = card(el)!.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const file = (type: string, bytes: number, name = "banner") => new dom.window.File([new Uint8Array(bytes)], name, { type }) as unknown as File;
const writes = () => sent.filter((s) => s.url === "/api/admin/community/banner");

test("with no banner the card says so and offers an upload, with the limits in plain words", async () => {
  reset(null);
  const m = await mount();
  try {
    const c = card(m.el);
    assert.ok(c, "the Banner card");
    assert.equal(text(c!.querySelector("h2")), "Banner");
    assert.match(text(c), /No banner yet/);
    assert.match(text(c), /PNG, JPEG or WebP, up to 2 MB/);
    assert.equal(c!.querySelector("img"), null);
    assert.equal(c!.querySelector('input[type="file"]')!.getAttribute("accept"), "image/png,image/jpeg,image/webp");
    assert.ok(![...c!.querySelectorAll("button")].some((b) => text(b) === "Remove"), "nothing to remove");
  } finally { await m.done(); }
});

test("a set banner is shown; Remove clears it with a DELETE", async () => {
  reset(MXC);
  const m = await mount();
  try {
    const c = card(m.el)!;
    assert.equal(c.querySelector("img")!.getAttribute("src"), "/api/matrix/media/thumbnail/example.test/banner1?width=800&height=600&method=scale");
    const remove = [...c.querySelectorAll("button")].find((b) => text(b) === "Remove")!;
    assert.ok(remove);
    answer.body = { ok: true, bannerMxc: null, requestedAt: "2026-10-30T12:00:00Z" };
    await act(async () => { (remove as HTMLElement).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.deepEqual(writes().map((w) => w.method), ["DELETE"]);
    assert.ok(notes.includes("Banner removed."), JSON.stringify(notes));
  } finally { await m.done(); }
});

test("choosing a picture sends it as multipart field banner, then reloads the page", async () => {
  reset(null);
  const m = await mount();
  try {
    await pick(m.el, file("image/webp", 1000));
    const w = writes();
    assert.equal(w.length, 1);
    assert.equal(w[0]!.method, "POST");
    assert.ok(w[0]!.body instanceof dom.window.FormData || w[0]!.body instanceof FormData, "multipart");
    assert.ok((w[0]!.body as FormData).get("banner"), "field banner");
    assert.ok(sent.filter((s) => s.url === "/api/admin/community").length >= 2, "the page reloaded after the save");
    assert.ok(notes.some((n) => /^Saved/.test(n)), JSON.stringify(notes));
  } finally { await m.done(); }
});

test("a wrong type or a file over 2 MB is refused before anything is sent", async () => {
  reset(null);
  const m = await mount();
  try {
    await pick(m.el, file("image/gif", 1000));
    await pick(m.el, file("image/png", 2 * 1024 * 1024 + 1));
    assert.equal(writes().length, 0);
    assert.deepEqual(notes, ["A banner is a PNG, JPEG or WebP picture.", "A banner is at most 2 MB."]);
  } finally { await m.done(); }
});

test("banner retry: a refused upload says why and the same picture can be sent again", async () => {
  reset(null);
  const m = await mount();
  try {
    answer = { status: 502, body: { error: "Upload failed" } };
    await pick(m.el, file("image/png", 1000));
    assert.ok(notes.includes("Not saved: Upload failed"), JSON.stringify(notes));
    answer = { status: 200, body: { ok: true, bannerMxc: MXC, requestedAt: null } };
    await pick(m.el, file("image/png", 1000));
    assert.equal(writes().length, 2, "the second try was sent");
  } finally { await m.done(); }
});

test("vacuity: the panel mounts the card", () => {
  const src = readFileSync(new URL("./CommunityPanel.tsx", import.meta.url), "utf8");
  assert.match(src, /<BannerCard /);
  assert.match(src, /\n\}\n$/, "read to the end of the file");
});
