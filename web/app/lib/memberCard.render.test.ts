// The member card RENDERED: the tier chip's wording and the power number.
// A room-version-12 creator has no entry in the users map and the SDK answers
// Infinity — the card must not print "power Infinity" — and a single person's
// card must not say the plural "Members".
//
// .ts, not .tsx: this Node build's extension-format map (internal/modules/
// esm/get_format) has no entry for .tsx under any flag, so a .tsx test file
// cannot load at all here. This file has no JSX syntax (React.createElement
// only), so the extension costs nothing.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/memberCard.render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, serveJson, resetStorage } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";

installResizeObserverStub();
const { MemberCard } = await import("@/app/components/MemberCard");
const { createRoot } = await import("react-dom/client");

function fakeMember(userId: string, powerLevel: number) {
  return {
    userId,
    name: userId.slice(1).split(":")[0],
    rawDisplayName: userId.slice(1).split(":")[0],
    powerLevel,
    membership: "join",
    getMxcAvatarUrl: () => null,
    events: { member: { getContent: () => ({}) } },
  };
}

function fakeRoom(members: Record<string, number>) {
  return {
    roomId: "!general:site.test",
    name: "general",
    client: { getUser: () => null, kick: async () => ({}), ban: async () => ({}), unban: async () => ({}) },
    currentState: { hasSufficientPowerLevelFor: (_a: string, pl: number) => pl >= 50 },
    getMember: (id: string) => (members[id] === undefined ? null : fakeMember(id, members[id]!)),
  };
}

async function renderCard(member: unknown, room: unknown) {
  resetStorage();
  // The card mounts usePresence(), which polls GET /api/presence — serveJson
  // is a single blanket fetch stub (any URL), so the body must satisfy
  // PresenceDirectory ({counts, users}) or presenceOf's `dir.users[id]` reads
  // a property off a body shaped for a different route and throws.
  serveJson({ counts: { onSite: 0, inCommunity: 0 }, users: {} });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(MemberCard, {
        member, room, x: 100, y: 100, side: "left", color: "#fff",
        canMessage: false, onMessage: () => {}, onClose: () => {},
        scopeRooms: [room],
        myUserId: "@viewer:site.test",
      } as never)
    );
  });
  const text = dom.window.document.body.textContent ?? "";
  return { text, cleanup: () => act(async () => root.unmount()) };
}

test("a room creator reads as Owner and shows no power number", async () => {
  const room = fakeRoom({ "@casey:site.test": Infinity });
  const { text, cleanup } = await renderCard(fakeMember("@casey:site.test", Infinity), room);
  assert.match(text, /Owner/);
  assert.doesNotMatch(text, /Infinity/);
  assert.doesNotMatch(text, /power /);
  await cleanup();
});

test("an ordinary member reads as Member, singular, with their number", async () => {
  const room = fakeRoom({ "@cleo:site.test": 0 });
  const { text, cleanup } = await renderCard(fakeMember("@cleo:site.test", 0), room);
  assert.match(text, /Member/);
  assert.doesNotMatch(text, /Members/);
  assert.match(text, /power 0/);
  await cleanup();
});
