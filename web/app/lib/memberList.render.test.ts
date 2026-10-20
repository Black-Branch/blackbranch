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
  assert.deepEqual(headings(m.host), ["admin", "supporters", "members", "discord", "inactive"]);
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
