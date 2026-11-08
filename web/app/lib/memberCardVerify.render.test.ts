// The member card's "Verify <name>" and verified shield (person-to-person verification): who sees
// it, the question before a direct conversation is opened for it, and the request that follows.
// The real two-person run is matrixCryptoRepairs.hs.test.ts.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/memberCardVerify.render.test.ts
import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";

installResizeObserverStub();
const { MemberCard } = await import("@/app/components/MemberCard");
const { createRoot } = await import("react-dom/client");

const ME = "@mod:example.tv";
const CLEO = "@cleo:example.tv";

(globalThis as unknown as { fetch: unknown }).fetch = (url: string) => Promise.resolve(new Response(JSON.stringify(
  String(url).startsWith("/api/presence") ? { counts: { onSite: 0, inCommunity: 0 }, users: {} } : String(url).startsWith("/api/me/ban") ? { banned: false } : { signedIn: true, isMod: false },
), { status: 200, headers: { "content-type": "application/json" } }));

function member(userId: string) {
  const name = userId.slice(1).split(":")[0];
  return { userId, powerLevel: 0, membership: "join", name, rawDisplayName: name, getMxcAvatarUrl: () => null, events: { member: { getContent: () => ({}) } } };
}

/** A room as the DM gate reads it (matrixDm.ts privateWith): us joined, them invited, invite-only —
 *  or, with `crowded`, someone else joined since. */
function dmRoom(roomId: string, crowded = false) {
  const mk = (userId: string, membership: string) => ({ userId, membership, events: { member: { getContent: () => ({ is_direct: true }) } } });
  const members = [mk(ME, "join"), mk(CLEO, "invite"), ...(crowded ? [mk("@zed:example.tv", "join")] : [])];
  return {
    roomId,
    getMembers: () => members,
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getJoinedMemberCount: () => members.filter((m) => m.membership === "join").length,
    getInvitedMemberCount: () => members.filter((m) => m.membership === "invite").length,
    getJoinRule: () => "invite",
    getHistoryVisibility: () => "shared",
    loadMembersIfNeeded: async () => true,
  };
}

function fakeClient(opts: { verified: boolean; hasIdentity?: boolean; crowded?: boolean }) {
  const requests: Array<[string, string]> = [];
  const made: string[] = [];
  const rooms = new Map<string, unknown>();
  let direct: Record<string, string[]> = {};
  const client = {
    getUserId: () => ME,
    getUser: () => null,
    getRooms: () => [],
    getRoom: (id: string) => rooms.get(id) ?? null,
    getAccountData: () => ({ getContent: () => direct }),
    setAccountData: async (_t: string, content: Record<string, string[]>) => { direct = content; return {}; },
    createRoom: async () => { made.push("!dm:example.tv"); rooms.set("!dm:example.tv", dmRoom("!dm:example.tv", opts.crowded)); return { room_id: "!dm:example.tv" }; },
    on: () => {}, off: () => {},
    getCrypto: () => ({
      userHasCrossSigningKeys: async () => opts.hasIdentity ?? true,
      getUserVerificationStatus: async () => ({ isCrossSigningVerified: () => opts.verified }),
      requestVerificationDM: async (userId: string, roomId: string) => { requests.push([userId, roomId]); return { phase: 1 }; },
    }),
  };
  return { client, requests, made };
}

async function renderCard(target: ReturnType<typeof member>, client: unknown) {
  resetStorage();
  const room = {
    roomId: "!general:example.tv", name: "general", client,
    getDMInviter: () => undefined,
    currentState: { hasSufficientPowerLevelFor: () => false },
    getMember: (id: string) => member(id),
  };
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(MemberCard, {
      member: target, room, x: 10, y: 10, side: "left", color: "#fff",
      canMessage: false, onMessage: () => {}, onClose: () => {}, scopeRooms: [room], myUserId: ME,
    } as never));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const body = () => dom.window.document.body;
  const button = (re: RegExp) => [...body().querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
  return {
    button, text: () => body().textContent ?? "",
    click: async (re: RegExp) => { const b = button(re); assert.ok(b, `no ${re} in: ${body().textContent}`); await act(async () => { b.click(); await new Promise((r) => setTimeout(r, 20)); }); },
    cleanup: () => act(async () => root.unmount()),
  };
}

test("an unverified member shows 'Verify <name>'; with no DM it asks before opening one; then requestVerificationDM(userId, roomId)", async () => {
  const f = fakeClient({ verified: false });
  const c = await renderCard(member(CLEO), f.client);
  assert.ok(c.button(/^Verify cleo$/));
  await c.click(/^Verify cleo$/);
  assert.match(c.text(), /Verifying opens a direct conversation with cleo\. Continue\?/);
  assert.deepEqual(f.made, [], "nothing is made before the answer");
  assert.deepEqual(f.requests, []);
  await c.click(/^Continue$/);
  assert.deepEqual(f.made, ["!dm:example.tv"]);
  assert.deepEqual(f.requests, [[CLEO, "!dm:example.tv"]]);
  await c.cleanup();
});

test("the request goes only into a private conversation: one that is not private is refused, with the reason, and nothing is requested", async () => {
  const f = fakeClient({ verified: false, crowded: true });
  const c = await renderCard(member(CLEO), f.client);
  await c.click(/^Verify cleo$/);
  await c.click(/^Continue$/);
  assert.deepEqual(f.made, ["!dm:example.tv"], "vacuity: the conversation was made");
  assert.deepEqual(f.requests, []);
  assert.match(c.text(), /isn't private any more/);
  await c.cleanup();
});

test("a verified member shows a shield and no Verify", async () => {
  const f = fakeClient({ verified: true });
  const c = await renderCard(member(CLEO), f.client);
  assert.equal(c.button(/Verify/), undefined);
  const shield = dom.window.document.querySelector('[aria-label="Verified"]');
  assert.ok(shield, "the shield beside the name");
  // A long name ends in an ellipsis (`truncate`): a shield inside that box is cut off with it, as
  // seen on a 390 px phone. It must sit beside the truncated name, never in it.
  assert.equal(shield.closest(".truncate"), null, "the shield is outside the truncated name");
  await c.cleanup();
});

test("no Verify for yourself or for someone without encryption set up", async () => {
  const self = await renderCard(member(ME), fakeClient({ verified: false }).client);
  assert.equal(self.button(/Verify/), undefined);
  await self.cleanup();
  const none = await renderCard(member(CLEO), fakeClient({ verified: false, hasIdentity: false }).client);
  assert.equal(none.button(/Verify/), undefined);
  await none.cleanup();
});
