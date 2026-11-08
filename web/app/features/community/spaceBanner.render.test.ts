// The community's banner over the channel list (Task 25), mounted: a space whose state carries
// app.blackbranch.banner { url } shows the picture with its name over it, like a Discord server
// banner; no banner (or a malformed one) keeps the plain header; a banner set while the list is open
// appears without a reload; Direct Messages never has one.
// Run: systemd-run --user --scope -p MemoryMax=8G env -u DATABASE_URL node --test app/features/community/spaceBanner.render.test.ts
import "../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { ChannelColumn } = await import("./ChannelColumn.tsx");
const { createRoot } = await import("react-dom/client");
const { RoomStateEvent } = await import("matrix-js-sdk");

const BANNER = "app.blackbranch.banner";
const MXC = "mxc://example.test/banner1";

/** A space room as the column reads it: state by (type, key), and the state-event stream. */
function space(state: Record<string, unknown> = {}) {
  const room = Object.assign(new EventEmitter(), {
    roomId: "!hub:example.test",
    name: "Example Community",
    currentState: {
      getStateEvents: (type: string, key: string) => (key === "" && type in state ? { getContent: () => state[type], getType: () => type } : null),
    },
  });
  /** Set a state event, and tell listeners as the SDK does. */
  const put = (type: string, content: unknown) => {
    state[type] = content;
    room.emit(RoomStateEvent.Events, { getType: () => type, getContent: () => content });
  };
  return { room, put };
}

async function mount(props: Record<string, unknown>) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  const base = {
    mode: "space", conversations: [], onOpenConversation: () => {}, pinned: [], invites: [], selected: null, myUserId: "@me:example.test",
    onSelect: () => {}, onAcceptInvite: async () => {}, onRejectInvite: async () => {}, serverRooms: [],
  };
  const render = async (p: Record<string, unknown>) => { await act(async () => { root.render(React.createElement(ChannelColumn as never, { ...base, ...p })); }); };
  await render(props);
  return { el, render, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}

const server = (room: unknown) => ({ id: "!hub:example.test", name: "Example Community", room, channels: [], subSpaces: [] });
const banner = (el: Element) => el.querySelector("[data-space-banner]");
const text = (n: Element | null | undefined) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();

test("a space with a banner shows it at the head of the channel list, with its name over it", async () => {
  const { room } = space({ [BANNER]: { url: MXC } });
  const m = await mount({ server: server(room) });
  try {
    const b = banner(m.el);
    assert.ok(b, "the banner block");
    const img = b!.querySelector("img")!;
    assert.ok(img, "the picture");
    assert.equal(img.getAttribute("src"), "/api/matrix/media/thumbnail/example.test/banner1?width=800&height=600&method=scale",
      "the scaled thumbnail through the site's media proxy, never the raw upload");
    assert.equal(img.getAttribute("alt"), "", "decorative: the name is the text");
    // The name sits over the picture: the header lives inside the banner block.
    const header = b!.querySelector('[data-bar="mx-header"]');
    assert.ok(header, "the header is inside the banner");
    assert.equal(text(header), "Example Community");
    assert.equal(header!.getAttribute("data-seam"), null, "no seam shade drawn across the picture");
    // The list follows the banner, not inside it.
    assert.equal(m.el.querySelectorAll('[data-bar="mx-header"]').length, 1, "one header");
  } finally { await m.done(); }
});

test("no banner, or a malformed one, keeps today's plain header", async () => {
  for (const state of [{}, { [BANNER]: {} }, { [BANNER]: { url: "https://example.test/x.png" } }, { [BANNER]: { url: "mxc://../..\\api\\x" } }]) {
    const { room } = space(state);
    const m = await mount({ server: server(room) });
    try {
      assert.equal(banner(m.el), null, JSON.stringify(state));
      assert.equal(m.el.querySelectorAll("img").length, 0);
      assert.equal(text(m.el.querySelector('[data-bar="mx-header"]')), "Example Community", "vacuity: the column rendered its header");
      assert.equal(m.el.querySelector('[data-bar="mx-header"]')!.getAttribute("data-seam"), "true", "the plain header keeps its seam");
    } finally { await m.done(); }
  }
});

test("a banner set while the list is open appears without a reload; removing it brings the plain header back", async () => {
  const { room, put } = space();
  const m = await mount({ server: server(room) });
  try {
    assert.equal(banner(m.el), null);
    await act(async () => { put(BANNER, { url: MXC }); });
    assert.ok(banner(m.el), "the banner arrived with the state event");
    await act(async () => { put(BANNER, {}); });
    assert.equal(banner(m.el), null, "an emptied banner event is no banner");
    // Another state event does not disturb it.
    await act(async () => { put(BANNER, { url: MXC }); put("m.room.topic", { topic: "hi" }); });
    assert.ok(banner(m.el));
  } finally { await m.done(); }
  assert.equal(room.listenerCount(RoomStateEvent.Events), 0, "the listener is removed on unmount");
});

test("restart: a list mounted fresh reads the banner from the room's state at once", async () => {
  const { room } = space({ [BANNER]: { url: MXC } });
  for (let i = 0; i < 2; i++) {
    const m = await mount({ server: server(room) });
    try { assert.ok(banner(m.el), `mount ${i + 1}`); } finally { await m.done(); }
  }
});

test("Direct Messages and the main list without a space never show a banner", async () => {
  const { room } = space({ [BANNER]: { url: MXC } });
  const dm = await mount({ mode: "home", server: server(room) });
  try {
    assert.equal(banner(dm.el), null);
    assert.equal(text(dm.el.querySelector('[data-bar="mx-header"]')), "Direct Messages");
  } finally { await dm.done(); }
  const orphan = await mount({ server: { ...server(null), room: null } });
  try { assert.equal(banner(orphan.el), null); } finally { await orphan.done(); }
});

test("the header's hairline is taken off over the picture (globals.css, unlayered, beats chrome's layer)", () => {
  const css = readFileSync(new URL("../../globals.css", import.meta.url), "utf8");
  assert.match(css, /\[data-space-banner\] \[data-bar="mx-header"\] \{ box-shadow: none; \}/);
});

test("vacuity: the column reads the banner through its one hook", () => {
  const src = readFileSync(new URL("./ChannelColumn.tsx", import.meta.url), "utf8");
  assert.match(src, /useSpaceBanner\(/);
  assert.match(src, /\n\}\n$/, "read to the end of the file");
});
