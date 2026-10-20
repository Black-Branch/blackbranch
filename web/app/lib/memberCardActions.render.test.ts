// The card's moderation row: who sees it, the two-step confirm, the Discord
// warning, and an honest summary after a partial failure.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/memberCardActions.render.test.ts

import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";

installResizeObserverStub();
const { MemberCard } = await import("@/app/components/MemberCard");
const { createRoot } = await import("react-dom/client");

// The card makes THREE different fetches on mount/action — /api/me (through
// useSiteMod), /api/presence (through usePresence), and /api/mod/ban (the
// site-ban path) — each needing a different body shape. testDom.ts's
// serveJson serves one blanket body to every URL, which is wrong here: fed a
// single body, /api/presence's consumer reads `dir.users[id]` off a body
// shaped for a different route and throws inside a hook's swallowed .catch,
// so the suite would silently run against a directory that never loaded.
// Route on the URL instead.
//
// Node's global Response, never dom.window.Response — jsdom implements no
// fetch/Response, so `new undefined(...)` throws INSIDE the promise chain,
// where a hook's `.catch(() => {})` swallows it (same trap testDom.ts's own
// header documents for serveJson).
function serveRoutes(routes: Record<string, unknown>, onCall?: (url: string, init?: RequestInit) => void) {
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit) => {
    onCall?.(String(url), init);
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    return Promise.resolve(
      new Response(JSON.stringify(key ? routes[key] : {}), {
        status: 200, headers: { "content-type": "application/json" },
      })
    );
  };
}

function fakeMember(userId: string, powerLevel: number, membership = "join") {
  return {
    userId, powerLevel, membership,
    name: userId.slice(1).split(":")[0],
    rawDisplayName: userId.slice(1).split(":")[0],
    getMxcAvatarUrl: () => null,
    events: { member: { getContent: () => ({}) } },
  };
}

type Behaviour = Record<string, () => Promise<unknown>>;

function fakeRoom(members: Record<string, { pl: number; membership?: string }>, behaviour: Behaviour = {}) {
  const calls: string[] = [];
  const act_ = (roomId: string) => { calls.push(roomId); return (behaviour[roomId] ?? (async () => ({})))(); };
  const room = {
    roomId: "!general:example.tv",
    name: "general",
    client: {
      getUser: () => null,
      kick: (r: string) => act_(r), ban: (r: string) => act_(r), unban: (r: string) => act_(r),
    },
    currentState: { hasSufficientPowerLevelFor: (_a: string, pl: number) => pl >= 50 },
    getMember: (id: string) =>
      members[id] === undefined ? null : fakeMember(id, members[id]!.pl, members[id]!.membership),
  };
  return { room, calls };
}

function buttonByText(re: RegExp): HTMLButtonElement | null {
  const all = [...dom.window.document.querySelectorAll("button")] as HTMLButtonElement[];
  return all.find((b) => re.test(b.textContent ?? "")) ?? null;
}

async function renderCard(opts: {
  target: ReturnType<typeof fakeMember>;
  room: unknown;
  scope: unknown[];
  isMod?: boolean;
  onFetch?: (url: string, init?: RequestInit) => void;
}) {
  resetStorage();
  serveRoutes(
    {
      "/api/me": { signedIn: true, isMod: opts.isMod ?? true },
      "/api/presence": { counts: { onSite: 0, inCommunity: 0 }, users: {} },
      "/api/mod/ban": { ok: true },
    },
    opts.onFetch
  );
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(MemberCard, {
        member: opts.target, room: opts.room, x: 10, y: 10, side: "left", color: "#fff",
        canMessage: false, onMessage: () => {}, onClose: () => {},
        scopeRooms: opts.scope, myUserId: "@mod:example.tv",
      } as never)
    );
  });
  return { root, cleanup: () => act(async () => root.unmount()) };
}

test("a viewer without power sees no Kick and no Ban", async () => {
  const { room } = fakeRoom({ "@mod:example.tv": { pl: 0 }, "@cleo:example.tv": { pl: 0 } });
  const { cleanup } = await renderCard({ target: fakeMember("@cleo:example.tv", 0), room, scope: [room] });
  assert.equal(buttonByText(/Kick/), null);
  assert.equal(buttonByText(/Ban/), null);
  await cleanup();
});

test("a moderator sees Kick and Ban", async () => {
  const { room } = fakeRoom({ "@mod:example.tv": { pl: 50 }, "@cleo:example.tv": { pl: 0 } });
  const { cleanup } = await renderCard({ target: fakeMember("@cleo:example.tv", 0), room, scope: [room] });
  assert.ok(buttonByText(/^Kick$/));
  assert.ok(buttonByText(/^Ban$/));
  await cleanup();
});

test("the first press only asks; nothing is sent until the second, and the site ban actually fires", async () => {
  const { room, calls } = fakeRoom({ "@mod:example.tv": { pl: 50 }, "@cleo:example.tv": { pl: 0 } });
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  const { cleanup } = await renderCard({
    target: fakeMember("@cleo:example.tv", 0), room, scope: [room],
    onFetch: (url, init) => fetchCalls.push({ url, init }),
  });
  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  assert.deepEqual(calls, []);
  // The confirm must disclose the reach — a non-ghost target's ban, pressed by
  // a site mod, also hits site.bans and fans out to Twitch/Kick/YouTube
  // (defect #1). Not "all platforms" — stream.place has no ban call, so
  // claiming every platform would itself overstate the reach.
  assert.ok(buttonByText(/Confirm ban from 1 channel, the site and platforms\?/));
  await act(async () => { buttonByText(/Confirm ban/)!.click(); });
  assert.deepEqual(calls, ["!general:example.tv"]);

  // Extra assertion (not in the brief): a site ban that silently never fires
  // is the failure most worth catching here — the Matrix side reads banned
  // while the person can still sign in and post from the website. Confirm
  // /api/mod/ban was actually called, with the target's Matrix id, and that
  // the card's own summary says so.
  const banCall = fetchCalls.find((c) => c.url.startsWith("/api/mod/ban"));
  assert.ok(banCall, "/api/mod/ban was called");
  assert.equal(banCall!.init?.method, "POST");
  assert.equal(JSON.parse(String(banCall!.init?.body)).targetId, "@cleo:example.tv");
  const text = dom.window.document.body.textContent ?? "";
  // Not "Site ban applied." (undersold the reach) and not "Site and platform
  // ban applied." either (claims a platform result fanOutBan's fire-and-forget
  // call never lets the card observe) — re-review defect #1.
  assert.match(text, /Site ban applied; platform bans sent\./);
  await cleanup();
});

test("a banned member is offered Unban instead of Ban", async () => {
  const { room } = fakeRoom({ "@mod:example.tv": { pl: 50 }, "@bad:example.tv": { pl: 0, membership: "ban" } });
  const { cleanup } = await renderCard({ target: fakeMember("@bad:example.tv", 0, "ban"), room, scope: [room] });
  assert.ok(buttonByText(/^Unban$/));
  assert.equal(buttonByText(/^Ban$/), null);
  await cleanup();
});

test("a Discord member is warned that this does nothing on Discord", async () => {
  const { room } = fakeRoom({ "@mod:example.tv": { pl: 50 }, "@discord_1:example.tv": { pl: 0 } });
  const { cleanup } = await renderCard({
    target: fakeMember("@discord_1:example.tv", 0), room, scope: [room],
  });
  assert.match(dom.window.document.body.textContent ?? "", /not on Discord/i);
  await cleanup();
});

test("a Discord member's ban confirm does NOT claim a site/platform reach it never has", async () => {
  // siteBan() short-circuits for a ghost before it ever reaches the network
  // (defect #6), so the confirm disclosing "the site and platforms" would
  // be false for exactly this member.
  const { room } = fakeRoom({ "@mod:example.tv": { pl: 50 }, "@discord_1:example.tv": { pl: 0 } });
  const { cleanup } = await renderCard({
    target: fakeMember("@discord_1:example.tv", 0), room, scope: [room],
  });
  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  const confirm = buttonByText(/Confirm ban from 1 channel/);
  assert.ok(confirm);
  assert.doesNotMatch(confirm!.textContent ?? "", /site and platforms/);
  await cleanup();
});

test("a partial failure leaves the card open and names the channel that failed", async () => {
  const other = { roomId: "!politics:example.tv", name: "politics" };
  const { room } = fakeRoom(
    { "@mod:example.tv": { pl: 50 }, "@cleo:example.tv": { pl: 0 } },
    { "!politics:example.tv": () => Promise.reject(Object.assign(new Error("no"), { errcode: "M_FORBIDDEN" })) }
  );
  const { cleanup } = await renderCard({
    target: fakeMember("@cleo:example.tv", 0), room, scope: [room, other],
  });
  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  await act(async () => { buttonByText(/Confirm ban/)!.click(); });
  const text = dom.window.document.body.textContent ?? "";
  assert.match(text, /Banned from 1 of 2 channels/);
  assert.match(text, /Failed: politics/);
  await cleanup();
});

test("a press elsewhere on the card resets an armed confirm (defect #9)", async () => {
  const { room, calls } = fakeRoom({ "@mod:example.tv": { pl: 50 }, "@cleo:example.tv": { pl: 0 } });
  const { cleanup } = await renderCard({ target: fakeMember("@cleo:example.tv", 0), room, scope: [room] });
  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  assert.ok(buttonByText(/Confirm ban/), "Ban must be armed after the first press");
  await act(async () => { buttonByText(/^Copy user ID$/)!.click(); });
  assert.equal(buttonByText(/Confirm ban/), null, "pressing Copy user ID elsewhere must disarm it");
  assert.ok(buttonByText(/^Ban$/), "Ban must be back to its unarmed label");
  // And the disarmed button really is inert — nothing was sent by that press.
  assert.deepEqual(calls, []);
  await cleanup();
});
