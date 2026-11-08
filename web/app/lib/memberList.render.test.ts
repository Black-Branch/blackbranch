// The members list RENDERED with a fake room + a stubbed directory: the five
// headings in order, the counts line, online-first order, the folded Inactive
// group and the collapsed Discord group.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/memberList.render.test.ts

import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, serveJson, resetStorage } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";
import { readFileSync } from "node:fs";
import { stripCssComments } from "./testSource.ts";
import type { PresenceDirectory } from "./presenceState.ts";

installResizeObserverStub();
const { MemberList } = await import("@/app/features/community/MemberList");
const { createRoot } = await import("react-dom/client");

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type FakeMember = { userId: string; rawDisplayName: string; powerLevel: number };
function fakeMember(m: FakeMember) {
  return { ...m, name: m.rawDisplayName, getMxcAvatarUrl: () => null, events: { member: { getContent: () => ({}) } } };
}
function fakeRoom(members: FakeMember[], presences: Record<string, { presence: string; lastPresenceTs: number; lastActiveAgo: number }> = {}) {
  const joined = members.map(fakeMember);
  return {
    roomId: "!r:example.tv",
    getJoinedMembers: () => joined,
    loadMembersIfNeeded: () => Promise.resolve(),
    on: () => {}, off: () => {},
    client: { getUser: (id: string) => (presences[id] ? { ...presences[id] } : null) },
  };
}

const directory: PresenceDirectory = {
  counts: { onSite: 2, inCommunity: 1 },
  users: {
    "@cleo:example.tv":   { lastBeat: iso(10_000), lastVisible: iso(10_000), lastCommunity: iso(10_000), lastLogin: null, status: "online", statusText: "grinding", supporter: true },
    "@bo:example.tv":    { lastBeat: iso(10_000), lastVisible: iso(10_000), lastCommunity: null, lastLogin: null, status: "online", statusText: "", supporter: false },
    "@old:example.tv":   { lastBeat: null, lastVisible: null, lastCommunity: null, lastLogin: iso(20 * 86_400_000), status: "online", statusText: "", supporter: false },
    "@casey:example.tv": { lastBeat: null, lastVisible: null, lastCommunity: null, lastLogin: iso(60_000), status: "online", statusText: "", supporter: true },
  },
};

function mount(room: ReturnType<typeof fakeRoom>) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(MemberList, { room: room as never, myUserId: "@bo:example.tv" })));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const headings = (host: HTMLElement) => [...host.querySelectorAll("[data-group]")].map((el) => el.getAttribute("data-group"));
const names = (host: HTMLElement, group: string) =>
  [...host.querySelectorAll(`[data-group-rows="${group}"] [data-member]`)].map((el) => el.getAttribute("data-member"));

test("headings in order, the counts line, online-first inside a group, the fold, the collapsed Discord group", async () => {
  resetStorage();
  serveJson(directory);
  // A server with no ladder for this viewer: the list falls back to the default ladder.
  const g = globalThis as unknown as { fetch: (url: string) => Promise<Response> };
  const served = g.fetch;
  g.fetch = (url) => (String(url).includes("/api/community/mods") ? Promise.resolve(new Response("no", { status: 403 })) : served(url));
  const room = fakeRoom([
    { userId: "@casey:example.tv", rawDisplayName: "casey", powerLevel: 100 },
    { userId: "@cleo:example.tv", rawDisplayName: "cleo", powerLevel: 0 },
    { userId: "@bo:example.tv", rawDisplayName: "bo", powerLevel: 0 },
    { userId: "@al:example.tv", rawDisplayName: "al", powerLevel: 0 },
    { userId: "@old:example.tv", rawDisplayName: "old", powerLevel: 0 },
    { userId: "@discord_1:example.tv", rawDisplayName: "ghost (Discord)", powerLevel: 0 },
  ], { "@al:example.tv": { presence: "online", lastPresenceTs: NOW, lastActiveAgo: 0 } });
  const m = mount(room);
  // Before the directory's first answer, dir is null: no Inactive group (an
  // unknown last-active is not 14 days unseen) and no counts line.
  assert.equal(m.host.querySelector('[data-group="inactive"]'), null, "no Inactive group before the first poll answers");
  assert.equal(m.host.querySelector("[data-presence-counts]"), null, "no counts line yet");
  // The poller's first tick is deferred a microtask, then fetch → json → setState: a macrotask flush covers it.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(headings(m.host), ["streamer", "supporters", "members", "discord", "inactive"]);
  assert.equal(m.host.querySelector('[data-group="streamer"]')?.textContent, "Streamer — 1", "the streamer is shown as Streamer");
  assert.equal(m.host.querySelector("[data-presence-counts]")?.textContent, "2 on Example Stream · 1 in the community");
  assert.deepEqual(names(m.host, "members"), ["@bo:example.tv", "@al:example.tv"], "here (bo) before online-elsewhere (al)");
  assert.deepEqual(names(m.host, "supporters"), ["@cleo:example.tv"]);
  assert.equal(m.host.querySelector('[data-member="@cleo:example.tv"] [data-presence]')?.getAttribute("data-presence"), "community");
  assert.equal(m.host.querySelector('[data-member="@bo:example.tv"] [data-presence]')?.getAttribute("data-presence"), "site");
  assert.equal(m.host.querySelector('[data-member="@cleo:example.tv"] [data-status-text]')?.textContent, "grinding");
  // Folded: old (20 days) is in Inactive, its rows collapsed until tapped.
  assert.equal(m.host.querySelector('[data-group="inactive"]')?.textContent, "Inactive — 1");
  assert.deepEqual(names(m.host, "inactive"), [], "collapsed by default");
  act(() => { (m.host.querySelector('[data-group="inactive"]') as HTMLElement).click(); });
  assert.deepEqual(names(m.host, "inactive"), ["@old:example.tv"]);
  // Discord: collapsed by default, never folded.
  assert.equal(m.host.querySelector('[data-group="discord"]')?.textContent, "Discord — 1");
  assert.deepEqual(names(m.host, "discord"), []);
  m.unmount();
});

// ── The server's ladder ─────────────────────────────────────────────────────────────────────────
const LADDER = {
  hubRoomId: "!hub:example.tv",
  hiddenIds: ["@blackbranch:example.tv", "@forum-reader:example.tv"],
  roles: [
    { key: "admin", label: "Admin", level: 100, colour: null, hoist: true, orderKey: "a0", builtin: true },
    { key: "staff", label: "Staff", level: 75, colour: "#22aa66", hoist: true, orderKey: "a1", builtin: true },
    { key: "mod", label: "Mod", level: 50, colour: null, hoist: true, orderKey: "a2", builtin: true },
    { key: "bot", label: "Bot", level: 50, colour: null, hoist: true, orderKey: "a3", builtin: true },
  ],
  staffIds: ["@sam:example.tv"],
  botIds: ["@helper:example.tv", "@bigbot:example.tv"],
};
// Everyone here and on the site now, so nobody folds into Inactive.
const HERE = { lastBeat: iso(10_000), lastVisible: iso(10_000), lastCommunity: iso(10_000), lastLogin: null, status: "online" as const, statusText: "", supporter: false };
const LADDER_IDS = ["blackbranch", "forum-reader", "casey", "sam", "mo", "helper", "bigbot", "bo"].map((n) => `@${n}:example.tv`);
const EVERYONE: PresenceDirectory = { counts: { onSite: 8, inCommunity: 8 }, users: Object.fromEntries(LADDER_IDS.map((id) => [id, HERE])) };
const ladderRoom = () => fakeRoom([
  { userId: "@blackbranch:example.tv", rawDisplayName: "blackbranch", powerLevel: 100 },
  { userId: "@forum-reader:example.tv", rawDisplayName: "forum-reader", powerLevel: 0 },
  { userId: "@casey:example.tv", rawDisplayName: "casey", powerLevel: 100 },
  { userId: "@sam:example.tv", rawDisplayName: "sam", powerLevel: 75 },
  { userId: "@mo:example.tv", rawDisplayName: "mo", powerLevel: 50 },
  { userId: "@helper:example.tv", rawDisplayName: "helper", powerLevel: 50 },
  { userId: "@bigbot:example.tv", rawDisplayName: "bigbot", powerLevel: 100 },
  { userId: "@bo:example.tv", rawDisplayName: "bo", powerLevel: 0 },
]);
/** Each URL its own answer; the ladder answers `failLadder` times with a 503 first. */
function serveLadder(failLadder = 0) {
  let ladderCalls = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string) => {
    if (!String(url).includes("/api/community/mods")) return Promise.resolve(Response.json(EVERYONE));
    ladderCalls++;
    return Promise.resolve(ladderCalls <= failLadder ? new Response("no", { status: 503 }) : Response.json(LADDER));
  };
  return () => ladderCalls;
}
const flush = async (n = 3) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const listed = (host: HTMLElement, id: string) => host.querySelector(`[data-member='${id}']`) !== null;

// Runs before any good answer is kept for the page (the next test's answer is the one kept).
test("retry: a ladder that failed at load is asked again, and the hidden accounts go once it answers", async () => {
  resetStorage();
  const calls = serveLadder(1);
  const m = mount(ladderRoom());
  try {
    await flush();
    assert.equal(calls(), 1);
    assert.ok(listed(m.host, "@blackbranch:example.tv"), "with no answer yet, nothing is known to hide");
    // The first retry waits one second.
    await act(async () => { await new Promise((r) => setTimeout(r, 1_100)); });
    await flush();
    assert.equal(calls(), 2, "asked again without a remount");
    assert.ok(!listed(m.host, "@blackbranch:example.tv"), "the service account is gone");
    assert.ok(!listed(m.host, "@forum-reader:example.tv"), "the forum reader is gone");
  } finally { m.unmount(); }
});

test("the server's ladder: the service account and the forum reader are not listed; Staff and Bots get their groups", async () => {
  resetStorage();
  serveLadder();
  const m = mount(ladderRoom());
  await flush();
  // Unmounted whatever happens: a failed assertion must not leave the presence poller holding the run open.
  try { ladderAsserts(m.host); } finally { m.unmount(); }
});

function ladderAsserts(host: HTMLElement) {
  assert.deepEqual(headings(host), ["streamer", "staff", "mods", "bots", "members"]);
  // `=== null`, never assert.equal on an element: a failure would inspect the whole DOM.
  assert.ok(!listed(host, "@blackbranch:example.tv"), "the service account is not listed");
  assert.ok(!listed(host, "@forum-reader:example.tv"), "the forum reader is not listed");
  assert.deepEqual(names(host, "staff"), ["@sam:example.tv"]);
  assert.deepEqual(names(host, "bots"), ["@bigbot:example.tv", "@helper:example.tv"]);
  assert.equal(host.querySelector('[data-group="staff"]')?.textContent, "Staff — 1");
  assert.equal((host.querySelector('[data-group="staff"]') as HTMLElement).style.color, "rgb(34, 170, 102)", "the role's colour");
  assert.ok(!host.textContent?.includes("Creator"), "no Creator label anywhere");
  // Each row's badge says the member's rung, never the raw power level's guess.
  const badge = (id: string) => host.querySelector(`[data-member='${id}'] [data-badge]`)?.getAttribute("title") ?? null;
  assert.equal(badge("@casey:example.tv"), "Streamer");
  assert.equal(badge("@sam:example.tv"), "Staff", "Staff at 75 is not a Moderator");
  assert.equal(badge("@mo:example.tv"), "Mod");
  assert.equal(badge("@helper:example.tv"), "Bot", "a bot at 50 is not a Moderator");
  assert.equal(badge("@bigbot:example.tv"), "Bot", "a bot at 100 is not the Streamer");
  assert.equal(badge("@bo:example.tv"), null, "a member has no badge");
}

// ── The picture: the scale's list step (client polish Task 23; #236) ────────────────────────────
// The list drew its own picture (Avatar size 26 off the row basis: ~40px), larger than the channel
// view's on a phone; Task 23 moved it onto the channel row's gutter token. #236 ("universalize pfp
// sizes") then gave every picture ONE scale (globals.css `--avatar-xs … --avatar-xl`) and kept the
// Chat rows › Avatar-size slider for chat rows only: a member row is a list row, like the DM list,
// so it takes the md step — Discord's 32px member list — whatever the slider, in a Discord compact
// row at least 44px tall. jsdom has no layout: this pins the markup and the token terms.
const cssText = stripCssComments(readFileSync(new URL("../globals.css", import.meta.url), "utf8"));
const listSrc = readFileSync(new URL("../features/community/MemberList.tsx", import.meta.url), "utf8");

function pictureAsserts(host: HTMLElement) {
  const root = host.firstElementChild as HTMLElement;
  assert.equal(root.getAttribute("data-mx-pane"), "narrow", "the list is a narrow pane: the 32px picture");
  const rows = [...host.querySelectorAll<HTMLElement>("[data-member]")];
  assert.ok(rows.length > 0, "rows rendered");
  for (const row of rows) {
    const id = row.getAttribute("data-member");
    assert.ok(row.classList.contains("mx-member"), `${id}: a member row`);
    assert.ok(row.classList.contains("min-h-11"), `${id}: a 44px row`);
    const pic = row.querySelector<HTMLElement>("[data-letter-circle], img");
    assert.ok(pic !== null, `${id}: a picture`);
    assert.ok(pic.classList.contains("avatar"), `${id}: the picture is sized by the one scale`);
    assert.equal(pic.style.getPropertyValue("--avatar-size"), "var(--avatar-md)", `${id}: the list step`);
    assert.doesNotMatch(pic.getAttribute("style") ?? "", /chat-pfp-scale/, `${id}: a list ignores the chat rows' Avatar-size slider`);
  }
}

test("member pictures: every row is the channel row's picture, in a narrow pane, 44px tall", async () => {
  resetStorage();
  serveLadder();
  const m = mount(ladderRoom());
  try { await flush(); pictureAsserts(m.host); } finally { m.unmount(); }
});

test("restart: a remounted list draws the same picture", async () => {
  resetStorage();
  serveLadder();
  const first = mount(ladderRoom());
  try { await flush(); } finally { first.unmount(); }
  const again = mount(ladderRoom());
  try { await flush(); pictureAsserts(again.host); } finally { again.unmount(); }
});

test("retry: a membership refresh redraws the rows with the same picture", async () => {
  resetStorage();
  serveLadder();
  const room = ladderRoom();
  const joined = room.getJoinedMembers();
  let list = joined.slice(0, -1);
  let refresh: () => void = () => { throw new Error("no listener"); };
  Object.assign(room, {
    getJoinedMembers: () => list,
    on: (_e: string, fn: () => void) => { refresh = fn; },
  });
  const m = mount(room);
  try {
    await flush();
    assert.ok(!listed(m.host, "@bo:example.tv"), "bo has not joined yet");
    list = joined;
    act(() => { refresh(); });
    await flush();
    assert.ok(listed(m.host, "@bo:example.tv"), "bo joined");
    pictureAsserts(m.host);
  } finally { m.unmount(); }
});

test("the member picture has no size of its own: the md step; the gutter token is the timeline's alone", () => {
  assert.match(listSrc, /<Avatar mxcUrl=\{memberAvatar\(m\)\} name=\{v\.label\} size="md" \/>/);
  // No second number and no private box for the member picture.
  assert.doesNotMatch(listSrc, /size=\{26\}|box="--mx-avatar-box"/);
  assert.doesNotMatch(cssText, /\.mx-member[^{]*\{[^}]*--mx-(gutter-avatar|avatar-box)/, "the member row reads no gutter token");
  // The Community "Avatars" switch hides the TIMELINE's pictures; the member list keeps its own.
  assert.doesNotMatch(cssText, /\.mx-avatars-off [^{]*\.mx-member/);
});

test("vacuity anchor: the scans read the whole files", () => {
  assert.match(listSrc, /\{card && \(\s*<MemberCard[\s\S]*\n {2}\);\n\}\s*$/, "MemberList.tsx read to its end");
  assert.match(cssText, /\.mx-avatars-off \.mx-avatar \{ display: none !important; \}/, "globals.css read past the Community block");
});
