// The Ban confirm's reach disclosure ("…, the site and platforms?") must only
// promise what the VIEWER can actually deliver — re-review defect #1, second
// half. This lives in its own file (not memberCardActions.render.test.ts)
// because useSiteMod.ts caches its /api/me fetch in a MODULE-level variable
// ("one in-flight promise per page load, shared"): the first render in a test
// FILE locks that value in for every later render in the SAME process, so a
// second render in that file asking for isMod:false would still read
// whatever the first render's fetch resolved to. node --test runs each file
// as its own process, which is what gives this file a virgin cache.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/memberCardBanReachGate.render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";

installResizeObserverStub();
const { MemberCard } = await import("@/app/components/MemberCard");
const { createRoot } = await import("react-dom/client");

// Mirrors memberCardActions.render.test.ts's own harness — see that file's
// header for why each route needs its own shaped body.
function serveRoutes(routes: Record<string, unknown>) {
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    return Promise.resolve(
      new Response(JSON.stringify(key ? routes[key] : {}), {
        status: 200, headers: { "content-type": "application/json" },
      })
    );
  };
}

function fakeMember(userId: string, powerLevel: number) {
  return {
    userId, powerLevel, membership: "join",
    name: userId.slice(1).split(":")[0],
    rawDisplayName: userId.slice(1).split(":")[0],
    getMxcAvatarUrl: () => null,
    events: { member: { getContent: () => ({}) } },
  };
}

function fakeRoom(members: Record<string, { pl: number }>) {
  const room = {
    roomId: "!general:site.test",
    name: "general",
    client: { getUser: () => null, kick: async () => ({}), ban: async () => ({}), unban: async () => ({}) },
    currentState: { hasSufficientPowerLevelFor: (_a: string, pl: number) => pl >= 50 },
    getMember: (id: string) => (members[id] === undefined ? null : fakeMember(id, members[id]!.pl)),
  };
  return room;
}

function buttonByText(re: RegExp): HTMLButtonElement | null {
  const all = [...dom.window.document.querySelectorAll("button")] as HTMLButtonElement[];
  return all.find((b) => re.test(b.textContent ?? "")) ?? null;
}

test("a mod WITHOUT site-mod rights gets a ban confirm that does not promise a reach they can't deliver", async () => {
  // isSiteMod false -> siteBan() refuses before ever POSTing, the same way it
  // already short-circuits for a ghost. Before this fix the confirm still
  // promised "…, the site and all platforms?" and the result then read
  // "No site ban — your account can't apply a site ban." right underneath it.
  resetStorage();
  serveRoutes({
    "/api/me": { signedIn: true, isMod: false },
    "/api/presence": { counts: { onSite: 0, inCommunity: 0 }, users: {} },
    "/api/mod/ban": { ok: true },
  });
  const room = fakeRoom({ "@mod:site.test": { pl: 50 }, "@cleo:site.test": { pl: 0 } });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(MemberCard, {
        member: fakeMember("@cleo:site.test", 0), room, x: 10, y: 10, side: "left", color: "#fff",
        canMessage: false, onMessage: () => {}, onClose: () => {},
        scopeRooms: [room], myUserId: "@mod:site.test",
      } as never)
    );
  });

  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  const confirm = buttonByText(/Confirm ban from 1 channel/);
  assert.ok(confirm);
  assert.doesNotMatch(confirm!.textContent ?? "", /site and platforms/);

  await act(async () => { buttonByText(/Confirm ban/)!.click(); });
  assert.match(
    dom.window.document.body.textContent ?? "",
    /No site ban — your account can't apply a site ban\./
  );
  await act(async () => root.unmount());
});
