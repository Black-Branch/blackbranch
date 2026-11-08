// The member card's Timeout is a site mod's: a viewer the site does not call a mod never sees it,
// whatever power they hold in the channel. Its own file because useSiteMod keeps its first answer
// for the page (memberCardTimeout.render.test.ts covers a mod).
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/memberCardTimeoutNonMod.render.test.ts

import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";

installResizeObserverStub();
const { MemberCard } = await import("@/app/components/MemberCard");
const { createRoot } = await import("react-dom/client");

test("a viewer who is no site mod sees no Timeout, even with power 50 in the channel", async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string) => {
    const body = String(url).startsWith("/api/me") ? { signedIn: true, isMod: false } : { counts: { onSite: 0, inCommunity: 0 }, users: {} };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  };
  const member = (userId: string, powerLevel: number) => ({
    userId, powerLevel, membership: "join", name: "x", rawDisplayName: "x", getMxcAvatarUrl: () => null,
    events: { member: { getContent: () => ({}) } },
  });
  const room = {
    roomId: "!general:example.tv", name: "general",
    client: { getUser: () => null, getAccountData: () => undefined, kick: async () => ({}), ban: async () => ({}), unban: async () => ({}) },
    getDMInviter: () => undefined,
    currentState: { hasSufficientPowerLevelFor: (_a: string, pl: number) => pl >= 50 },
    getMember: (id: string) => member(id, id === "@viewer:example.tv" ? 50 : 0),
  };
  const root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
  try {
    await act(async () => {
      root.render(React.createElement(MemberCard, {
        member: member("@cleo:example.tv", 0), room, x: 10, y: 10, side: "left", color: "#fff",
        canMessage: false, onMessage: () => {}, onClose: () => {}, scopeRooms: [room], myUserId: "@viewer:example.tv",
      } as never));
    });
    const labels = [...dom.window.document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    assert.ok(labels.includes("Ban"), `vacuity: the card's moderation row rendered (${labels.join(", ")})`);
    assert.ok(!labels.includes("Timeout"), labels.join(", "));
  } finally {
    await act(async () => root.unmount());
  }
});
