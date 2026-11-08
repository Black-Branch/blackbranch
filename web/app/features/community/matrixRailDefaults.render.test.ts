// #238 — the rail's Home and space buttons in the Matrix view. Home opens the DM list and a space
// button opens that space's channel list, at every width; when the tap is what opened the list, a
// pick (a DM, a channel) closes it again and shows the room. A list the person opened with ≡ (or the
// wide view's default) stays open on a pick, as before.
// The REAL UnifiedLayout (MatrixView.tsx) is mounted; what it renders around it (rail, channel
// column, timeline, …) is replaced by small stand-ins that expose the props it hands them, so the
// test drives the same handlers a tap does and reads what the layout chooses to show.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/features/community/matrixRailDefaults.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import { installResizeObserverStub } from "../../lib/testTsx.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const href = (...p: string[]) => pathToFileURL(path.join(WEB, ...p)).href;
const REACT = JSON.stringify(href("node_modules", "react", "index.js"));
const G = "globalThis.__mx238";
const h = `const h = React.createElement;`;

// Stand-ins, keyed by the specifier MatrixView imports them with. Each renders the props a tap uses.
const STUBS: Record<string, string> = {
  "./SpacesRail": `import React from ${REACT}; ${h}
    export function SpacesRail(p) {
      return h("nav", { "data-stub": "rail" },
        h("button", { "data-rail": "home", onClick: p.onSelectHome }, "Home"),
        ...p.servers.map((s) => h("button", { key: s.id, "data-rail": s.id, onClick: () => p.onSelectServer(s.id) }, s.name)));
    }`,
  "./ChannelColumn": `import React from ${REACT}; ${h}
    export function ChannelColumn(p) {
      const rows = p.mode === "home"
        ? p.conversations.map((c) => h("button", { key: c.partner, "data-dm": c.partner, onClick: () => p.onOpenConversation(c) }, c.partner))
        : (p.server?.channels ?? []).map((r) => h("button", { key: r.roomId, "data-ch": r.roomId, onClick: () => p.onSelect(r) }, r.name));
      return h("div", { "data-stub": "list", "data-mode": p.mode, "data-server": p.server?.id ?? "" }, ...rows);
    }`,
  "./Timeline": `import React from ${REACT}; ${h}
    export function MatrixTimeline(p) {
      return h("div", { "data-stub": "timeline", "data-room": p.room.roomId },
        p.onBack ? h("button", { "data-act": "back", onClick: p.onBack }, "Back") : null,
        p.onToggleDirectory ? h("button", { "data-act": "dir", onClick: p.onToggleDirectory }, "Channels") : null);
    }`,
  "./ForumView": `export function ForumView() { return null; }`,
  "./MemberList": `export function MemberList() { return null; }`,
  "./ThreadPanel": `export function ThreadPanel() { return null; }`,
  "./ThreadsListPanel": `export function ThreadsListPanel() { return null; }`,
  "./AddSpaceModal": `export function AddSpaceModal() { return null; }`,
  "./DmDraftPane": `export function DmDraftPane() { return null; }`,
  "@/app/components/AccountCard": `export default function AccountCard() { return null; }`,
  "@/app/features/moderation": `export function ModWindow() { return null; } export const isModPlace = () => false;`,
  "@/app/features/instance": `export function AdminWindow() { return null; } export const searchAdminPlaces = () => [];`,
  "./useCommunityBootstrap": `import React from ${REACT};
    export function useCommunityBootstrap(o) {
      React.useEffect(() => { if (${G}.landing) o.onLandingRoom(${G}.landing); }, []);
      return { rooms: ${G}.rooms, invites: [] };
    }`,
  "./useDmConversations": `export function useDmConversations() { return { all: ${G}.conversations, list: ${G}.conversations }; }`,
  "@/app/lib/useModPowerSync": `export function useModPowerSync() {}`,
  "@/app/lib/siteBanSync": `export * from ${JSON.stringify(href("app", "lib", "siteBanSync.ts"))}; export function useSiteBanSync() {}`,
  "@/app/lib/useSiteMod": `export function useSiteMod() { return false; }`,
  // The panel's own width: 0 on the first render (as the real ResizeObserver hook), then whatever
  // the test sets — a resize the layout hears like any other.
  "@/app/lib/useContainerWidth": `import React from ${REACT};
    export function useContainerWidth() {
      const ref = React.useRef(null);
      const w = React.useSyncExternalStore((cb) => { ${G}.onWidth = cb; return () => {}; }, () => ${G}.width, () => 0);
      return [ref, w];
    }`,
  "@/app/lib/MatrixClientContext": `export * from ${JSON.stringify(href("app", "lib", "MatrixClientContext.tsx"))};
    export function useMatrixClient() { return ${G}.ctx; }
    export function useStartMatrixClient() {}`,
  "@/app/lib/matrixRooms": `export * from ${JSON.stringify(href("app", "lib", "matrixRooms.ts"))};
    export const getDmRoomIds = () => new Set();
    export const buildNav = () => ({});
    export const buildServers = () => ${G}.servers;
    export const serverChannels = (s) => s.channels;
    export const favouriteRooms = () => [];
    export const dmPartner = () => null;
    export const isForumRoom = () => false;
    export const findRoomByAlias = () => null;
    export const moderationSyncRooms = () => [];
    export const roomLabel = (r) => r.name;`,
};
const MATRIX_VIEW = href("app", "features", "community", "MatrixView.tsx");
type Hooks = { resolve(s: string, c: { parentURL?: string }, next: (s: string, c: unknown) => unknown): unknown };
(nodeModule as unknown as { registerHooks: (h: Hooks) => void }).registerHooks({
  resolve(specifier, context, next) {
    const src = STUBS[specifier];
    // "./X" only as MatrixView spells it (another module's ./Timeline is its own); "@/" ones everywhere.
    if (src && (specifier.startsWith("@/") || context.parentURL === MATRIX_VIEW)) {
      return { url: "data:text/javascript," + encodeURIComponent(src), shortCircuit: true };
    }
    return next(specifier, context);
  },
});

installResizeObserverStub();

type FakeRoom = { roomId: string; name: string; findEventById: () => null };
const room = (roomId: string, name: string): FakeRoom => ({ roomId, name, findEventById: () => null });
const general = room("!general", "general");
const random = room("!random", "random");
const news = room("!news", "news");
const dmRobin = room("!dm-robin", "Robin");
const dmSam = room("!dm-sam", "Sam");
const conv = (partner: string, r: FakeRoom) => ({ partner, active: r, earlier: [], lastTs: 0, preview: "", unread: { total: 0, highlight: 0 }, pinned: false, rooms: [r] });

type World = {
  ctx: unknown; width: number; onWidth?: () => void; landing: FakeRoom | null;
  rooms: FakeRoom[]; servers: unknown[]; conversations: unknown[];
};
const world: World = {
  ctx: { client: { getUserId: () => "@me:site.test", getRooms: () => [], getRoom: () => null }, status: "ready", retry: () => {} },
  width: 0,
  landing: general,
  rooms: [general, random, news, dmRobin, dmSam],
  servers: [
    { id: "!space-a", name: "Space A", room: null, channels: [general, random] },
    { id: "!space-b", name: "Space B", room: null, channels: [news] },
  ],
  conversations: [conv("@robin:site.test", dmRobin), conv("@sam:site.test", dmSam)],
};
(globalThis as unknown as { __mx238: World }).__mx238 = world;

const { default: MatrixView } = await import("./MatrixView.tsx");
const { createRoot } = await import("react-dom/client");

const doc = dom.window.document;
const flush = async () => { await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); }); };

/** Mount the real layout at a panel width. Returns an unmount. */
async function mount(width: number) {
  world.width = 0;
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(MatrixView, { layout: "sidebar" })); });
  await flush();
  await resize(width);
  return async () => { await act(async () => root.unmount()); host.remove(); };
}
async function resize(width: number) {
  world.width = width;
  await act(async () => { world.onWidth?.(); });
  await flush();
}

/** On screen: rendered, not in an inert pager pane, not inside a collapsed (0 px) side panel. */
function onScreen(el: Element | null): boolean {
  if (!el) return false;
  for (let e: Element | null = el; e; e = e.parentElement) {
    if (e.hasAttribute("inert")) return false;
    if ((e as HTMLElement).style?.width === "0px" || (e as HTMLElement).style?.width === "0") return false;
  }
  return true;
}
/** What a person sees: the list ("home" | a space id | null) and the room on screen (or null). */
function seen() {
  const list = doc.querySelector('[data-stub="list"]');
  const tl = doc.querySelector('[data-stub="timeline"]');
  return {
    list: onScreen(list) ? (list!.getAttribute("data-mode") === "home" ? "home" : list!.getAttribute("data-server")) : null,
    room: onScreen(tl) ? tl!.getAttribute("data-room") : null,
  };
}
async function tap(selector: string) {
  const el = [...doc.querySelectorAll(selector)].find(onScreen) as HTMLElement | undefined;
  assert.ok(el, `${selector} is on screen to tap (seen: ${JSON.stringify(seen())})`);
  await act(async () => { el.click(); });
  await flush();
}
const HOME = '[data-rail="home"]';
const SPACE_A = '[data-rail="!space-a"]';
const SPACE_B = '[data-rail="!space-b"]';
const DM = (who: string) => `[data-dm="@${who}:site.test"]`;
const CH = (id: string) => `[data-ch="${id}"]`;
const TOGGLE = '[data-act="dir"]';

function fresh() {
  resetStorage();
  world.landing = general;
}

// ── two panels (680–1139 px) ─────────────────────────────────────────────────

test("two panels: with the list closed, Home opens the DM list (it used to open nothing)", async () => {
  fresh();
  const unmount = await mount(800);
  try {
    assert.equal(seen().room, "!general");
    if (seen().list) await tap(TOGGLE); // close it with ≡, as the person had
    assert.deepEqual(seen(), { list: null, room: "!general" });
    await tap(HOME);
    assert.deepEqual(seen(), { list: "home", room: "!general" }, "Home must open the DM list beside the room");
  } finally { await unmount(); }
});

test("two panels: a DM picked from the list Home opened closes the list and shows the DM", async () => {
  fresh();
  const unmount = await mount(800);
  try {
    if (seen().list) await tap(TOGGLE);
    await tap(HOME);
    await tap(DM("robin"));
    assert.deepEqual(seen(), { list: null, room: "!dm-robin" });
  } finally { await unmount(); }
});

test("two panels: with the list closed, a space button opens that space's channel list; a channel pick closes it", async () => {
  fresh();
  const unmount = await mount(800);
  try {
    if (seen().list) await tap(TOGGLE);
    await tap(SPACE_B);
    assert.deepEqual(seen(), { list: "!space-b", room: "!news" }, "the space's channel list opens beside its last channel");
    await tap(SPACE_A);
    assert.equal(seen().list, "!space-a", "switching spaces keeps the list open");
    await tap(CH("!random"));
    assert.deepEqual(seen(), { list: null, room: "!random" });
  } finally { await unmount(); }
});

test("two panels: a list opened with ≡ stays open on a pick, as before (Home and space taps alike)", async () => {
  fresh();
  const unmount = await mount(800);
  try {
    if (seen().list) await tap(TOGGLE);
    await tap(TOGGLE); // the person opens it themselves
    assert.equal(seen().list, "!space-a");
    await tap(CH("!random"));
    assert.deepEqual(seen(), { list: "!space-a", room: "!random" });
    await tap(HOME); // already open: Home switches what it lists, it did not open it
    await tap(DM("sam"));
    assert.deepEqual(seen(), { list: "home", room: "!dm-sam" });
  } finally { await unmount(); }
});

test("two panels: ≡ after a rail-opened list hands control back — a later pick leaves the list open", async () => {
  fresh();
  const unmount = await mount(800);
  try {
    if (seen().list) await tap(TOGGLE);
    await tap(HOME);   // opened by the rail
    await tap(TOGGLE); // closed by the person
    await tap(TOGGLE); // opened by the person
    await tap(DM("robin"));
    assert.deepEqual(seen(), { list: "home", room: "!dm-robin" });
  } finally { await unmount(); }
});

// ── wide (≥ 1140 px) ─────────────────────────────────────────────────────────

test("wide: the default-open list stays on a pick; closed with ≡, Home reopens it and a pick closes it", async () => {
  fresh();
  const unmount = await mount(1300);
  try {
    assert.equal(seen().list, "!space-a", "wide opens the list by itself");
    await tap(CH("!random"));
    assert.deepEqual(seen(), { list: "!space-a", room: "!random" });
    await tap(TOGGLE);
    assert.equal(seen().list, null);
    await tap(HOME);
    assert.equal(seen().list, "home");
    await tap(DM("robin"));
    assert.deepEqual(seen(), { list: null, room: "!dm-robin" });
  } finally { await unmount(); }
});

test("two panels → wide: widening opens the list as the wide view's own default, so a pick then leaves it open", async () => {
  fresh();
  const unmount = await mount(800);
  try {
    if (seen().list) await tap(TOGGLE);
    await tap(HOME); // opened by the rail in two panels
    await resize(1300);
    assert.equal(seen().list, "home");
    await tap(DM("robin"));
    assert.deepEqual(seen(), { list: "home", room: "!dm-robin" });
  } finally { await unmount(); }
});

test("two panels → one panel → two panels: narrowing keeps the room (#240) and a rail-opened list does not come back closed-on-pick by surprise", async () => {
  fresh();
  const unmount = await mount(800);
  try {
    if (seen().list) await tap(TOGGLE);
    await tap(HOME);
    await resize(500);
    assert.deepEqual(seen(), { list: null, room: "!general" }, "narrowing into one panel keeps the room on screen");
    await resize(800);
    assert.deepEqual(seen(), { list: null, room: "!general" }, "widening back leaves the list closed until ≡ (#240)");
    await tap(TOGGLE);
    await tap(DM("robin"));
    assert.deepEqual(seen(), { list: "home", room: "!dm-robin" }, "a list the person opened stays open");
  } finally { await unmount(); }
});

// ── one panel (< 680 px) — already right; pinned so the fix cannot move it ──

test("one panel: Home opens the DM list over the room, a DM pick shows the room; a space tap opens its channels, a pick shows the room", async () => {
  fresh();
  const unmount = await mount(390);
  try {
    assert.deepEqual(seen(), { list: "!space-a", room: null }, "a phone opens on the channel list");
    await tap(CH("!general"));
    assert.deepEqual(seen(), { list: null, room: "!general" });
    await tap('[data-act="back"]');
    await tap(HOME);
    assert.deepEqual(seen(), { list: "home", room: null });
    await tap(DM("robin"));
    assert.deepEqual(seen(), { list: null, room: "!dm-robin" });
    await tap('[data-act="back"]');
    await tap(SPACE_B);
    assert.deepEqual(seen(), { list: "!space-b", room: null });
    await tap(CH("!news"));
    assert.deepEqual(seen(), { list: null, room: "!news" });
  } finally { await unmount(); }
});

test("one panel on a touch screen (the swipe row): the same taps, the same screens", async () => {
  fresh();
  const mm = dom.window.matchMedia;
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: /coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = dom.window.matchMedia;
  const unmount = await mount(390);
  try {
    await tap(CH("!general"));
    assert.deepEqual(seen(), { list: null, room: "!general" });
    assert.ok(doc.querySelector("[inert]"), "the swipe row is on (its off-screen panes are inert)");
    await tap('[data-act="back"]');
    await tap(HOME);
    assert.equal(seen().list, "home");
    await tap(DM("robin"));
    assert.deepEqual(seen(), { list: null, room: "!dm-robin" });
  } finally {
    await unmount();
    (dom.window as unknown as { matchMedia: unknown }).matchMedia = mm;
    (globalThis as unknown as { matchMedia: unknown }).matchMedia = mm;
  }
});

// ── restart and retry ────────────────────────────────────────────────────────

test("restart: after a reload on Home, Home still opens the closed list and a pick still closes it — and nothing carried over", async () => {
  fresh();
  let unmount = await mount(800);
  if (seen().list) await tap(TOGGLE);
  await tap(HOME); // the rail opened it: this must not survive a reload
  await unmount();

  world.landing = null; // the reload restores Home (mx-lastspace), with no room landed
  unmount = await mount(800);
  try {
    assert.equal(seen().list, "home", "the reload restores the Home view with its list open");
    await tap(DM("robin"));
    assert.deepEqual(seen(), { list: "home", room: "!dm-robin" }, "a fresh page's own open list stays open on a pick");
    await tap(TOGGLE);
    await tap(HOME);
    assert.equal(seen().list, "home");
    await tap(DM("sam"));
    assert.deepEqual(seen(), { list: null, room: "!dm-sam" });
  } finally { await unmount(); }
});

test("retry: Home tapped twice, then the open-and-pick cycle again and again, closes the list every time", async () => {
  fresh();
  const unmount = await mount(800);
  try {
    if (seen().list) await tap(TOGGLE);
    await tap(HOME);
    await tap(HOME); // a second tap on the open list
    await tap(DM("robin"));
    assert.deepEqual(seen(), { list: null, room: "!dm-robin" });
    for (const [btn, pick, want] of [[SPACE_A, CH("!general"), "!general"], [HOME, DM("sam"), "!dm-sam"], [SPACE_B, CH("!news"), "!news"]] as const) {
      await tap(btn);
      assert.notEqual(seen().list, null, `${btn} opens the list`);
      await tap(pick);
      assert.deepEqual(seen(), { list: null, room: want });
    }
  } finally { await unmount(); }
});
