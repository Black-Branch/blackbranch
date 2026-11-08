// POST /api/chat/send and the client message id (v173), RUN: the real route, with the database,
// stream-api, the sign-in check, the coin ledger and the platform senders stubbed at their module
// seams. A second attempt at a composed line (same `client_msg_id`) is answered with the FIRST
// row's id and does nothing again: no second /chat/native call (which is the insert), no platform
// copy, no debit. The stored key itself, and two attempts racing to store it, are proven on the real
// schema by stream-api/chat-native-replay.db.test.js.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/api/chat/send/replay.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../../../lib/testTsx.ts";
import { stripComments } from "../../../lib/testSource.ts";

const ME = "@casey:site.test";
type Native = { clientMsgId?: string; message?: string };
type State = {
  stored: Map<string, number>;   // key → row id: what stream-api's INSERT holds
  lookupBlind: boolean;          // the route's own lookup misses (a first attempt still in flight)
  banned: boolean;
  slowSeconds: number;
  nativeCalls: Native[];
  platformSends: string[];
  debits: string[];
  deliveries: number;
  nextId: number;
};
const S: State = {
  stored: new Map(), lookupBlind: false, banned: false, slowSeconds: 0,
  nativeCalls: [], platformSends: [], debits: [], deliveries: 0, nextId: 100,
};
(globalThis as unknown as { __replayTest: State }).__replayTest = S;
const G = "globalThis.__replayTest";

// Each stub is the seam the route reaches the outside world through; everything else it imports is real.
const STUBS: Record<string, string> = {
  "@/lib/db": `export default { query: async (sql, params = []) => {
      const s = ${G};
      if (/client_msg_id/.test(sql)) {
        const id = s.lookupBlind ? undefined : s.stored.get(params[1]);
        return { rows: id != null && params[0] === "${ME}" ? [{ id, dest_platform: null, dest_platforms: null }] : [] };
      }
      if (/FROM site\\.bans/.test(sql)) return { rows: s.banned ? [{ expires_at: null }] : [] };
      if (/FROM site\\.chat_settings/.test(sql)) return { rows: [{ slow_mode_seconds: s.slowSeconds }] };
      if (/FROM site\\.accounts/.test(sql)) return { rows: [{ provider: "twitch", provider_account_id: "t1" }] };
      if (/FROM site\\.users/.test(sql)) return { rows: [{ display_name: "Casey", is_mod: false, is_admin: false }] };
      return { rows: [] };
    }, connect: async () => { throw new Error("no transactions in this test"); } };`,
  "@/app/lib/authGuard": `export async function requireUser() { return "${ME}"; }`,
  "@/app/lib/streamApi": `export async function streamApiFetch(path, init) {
      const s = ${G};
      if (path !== "/chat/native") return new Response("{}", { status: 404 });
      const b = JSON.parse(init.body);
      s.nativeCalls.push(b);
      const prior = b.clientMsgId ? s.stored.get(b.clientMsgId) : undefined;
      if (prior != null) return Response.json({ ok: true, id: prior, replay: true });
      const id = ++s.nextId;
      if (b.clientMsgId) s.stored.set(b.clientMsgId, id);
      return Response.json({ ok: true, id });
    }
    export function notifyBadgesChanged() { return Promise.resolve(); }`,
  "@/app/lib/streamStatus": `export const getStreamStatus = async () => ({ live: true });`,
  "@/app/lib/platformChat": `
    export { isRoutablePlatform } from "@/app/lib/platforms";
    export const platformOutgoingText = (m, u) => (u ? "@" + u + " " + m : m);
    export const stripLongEmoteNames = async (t) => t;
    export async function sendToPlatform(_m, p) { ${G}.platformSends.push(p); return { ok: true, platformMsgId: "pm1" }; }`,
  "@/app/lib/coinsServer": `
    const seen = new Set();
    export async function debitCoins({ ref }) { ${G}.debits.push(ref); const replay = seen.has(ref); seen.add(ref); return { ok: true, replay, balance: 500 }; }
    export async function refundCoins() { return { balance: 500, replay: false }; }
    export const earn = { earnMessage: async () => {} };`,
  "@/app/lib/chatEventDelivery": `export async function deliverChatEvent() { ${G}.deliveries++; return { outcome: "delivered", body: {} }; }`,
  // A generous limit: every test here is one sender, inside one five-second window.
  "@/app/lib/entitlements": `export const getActiveTier = async () => null;
    export const chatRateLimitFor = () => 1000;
    export function invalidateTier() {}`,
  "@/app/lib/storePricingServer": `export const storePricing = { getPrice: async () => 50 };`,
  "@/app/lib/platformCopies": `export async function recordPlatformCopies() {} export async function registerEchoCopy() {}`,
};
type Hooks = {
  resolve(s: string, c: unknown, next: (s: string, c: unknown) => { url: string }): { url: string; shortCircuit?: boolean };
  load(u: string, c: unknown, next: (u: string, c: unknown) => unknown): unknown;
};
(nodeModule as unknown as { registerHooks: (h: Hooks) => void }).registerHooks({
  resolve(specifier, context, next) {
    return specifier in STUBS ? { url: `stub:${specifier}`, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url.startsWith("stub:") ? { format: "module", source: STUBS[url.slice(5)], shortCircuit: true } : next(url, context);
  },
});

const route = await import("./route.ts");
/** The route as a new server process would load it: its own module state (caches, limiters). */
const freshRoute = async (tag: string): Promise<typeof route> => (await import(`./route.ts?${tag}`)) as typeof route;
const LINE = "5f0c8e2a-1b3d-4c5e-8f9a-0b1c2d3e4f5a";
const LINE2 = "6a1d9f3b-2c4e-4d6f-9a0b-1c2d3e4f5a6b";

async function send(body: Record<string, unknown>, POST = route.POST) {
  const req = new Request("http://site.test/api/chat/send", { method: "POST", body: JSON.stringify(body) });
  const res = await POST(req as never);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* "OK" */ }
  return { status: res.status, json, text };
}
test.beforeEach(() => {
  S.stored.clear(); S.lookupBlind = false; S.banned = false; S.slowSeconds = 0;
  S.nativeCalls = []; S.platformSends = []; S.debits = []; S.deliveries = 0;
});

test("retry: the same client_msg_id again answers 200 with the FIRST row's id and posts nothing", async () => {
  const first = await send({ message: "hey", client_msg_id: LINE });
  assert.equal(first.status, 200);
  assert.equal(S.nativeCalls.length, 1);
  assert.equal(S.nativeCalls[0]?.clientMsgId, LINE, "the key must reach the insert");
  const firstId = S.stored.get(LINE);
  const again = await send({ message: "hey", client_msg_id: LINE });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, { ok: true, replayed: true, id: firstId });
  assert.equal(S.nativeCalls.length, 1, "the retry called /chat/native again: a second insert");
});

test("retry: a cross-posted line is not sent to the platform again", async () => {
  await send({ message: "hey", client_msg_id: LINE, forced_destination: "twitch" });
  assert.deepEqual(S.platformSends, ["twitch"]);
  const again = await send({ message: "hey", client_msg_id: LINE, forced_destination: "twitch" });
  assert.equal(again.status, 200);
  assert.deepEqual(S.platformSends, ["twitch"], "the retry posted a second platform copy");
  assert.equal(S.nativeCalls.length, 1);
});

test("retry racing the first attempt: stream-api's replay stops the platform copy", async () => {
  // The first attempt stored its row after this attempt's lookup ran.
  S.stored.set(LINE, 7);
  S.lookupBlind = true;
  for (const dest of ["twitch", "all", undefined]) {
    S.platformSends = [];
    const r = await send({ message: "hey", client_msg_id: LINE, ...(dest ? { forced_destination: dest } : {}) });
    assert.equal(r.status, 200, `dest ${dest}`);
    assert.deepEqual(r.json, { ok: true, replayed: true, id: 7 }, `dest ${dest}`);
    assert.deepEqual(S.platformSends, [], `dest ${dest}: a replayed line was sent to a platform`);
  }
});

test("restart: a fresh server process answers a stored key the same way", async () => {
  await send({ message: "hey", client_msg_id: LINE });
  const fresh = await freshRoute("restart");
  const again = await send({ message: "hey", client_msg_id: LINE }, fresh.POST);
  assert.deepEqual(again.json, { ok: true, replayed: true, id: S.stored.get(LINE) });
  assert.equal(S.nativeCalls.length, 1);
});

test("a banned sender's replay still answers 403", async () => {
  await send({ message: "hey", client_msg_id: LINE });
  S.banned = true;
  const again = await send({ message: "hey", client_msg_id: LINE });
  assert.equal(again.status, 403);
});

test("a replay is not a new line: slow mode does not refuse it", async () => {
  S.slowSeconds = 60;
  // A fresh module: the slow-mode setting is cached per process for five seconds.
  const { POST } = await freshRoute("slow");
  await send({ message: "hey", client_msg_id: LINE }, POST);
  const again = await send({ message: "hey", client_msg_id: LINE }, POST);
  assert.equal(again.status, 200, "the retry of a posted line was refused for slow mode");
  const next = await send({ message: "something new", client_msg_id: LINE2 }, POST);
  assert.equal(next.status, 429, "a NEW line inside the window must still wait");
});

test("a spend keeps its own key: one debit replay, one card, whatever the client id", async () => {
  const spend = { mode: "highlight", spendId: "spend-abcdef12", expectedPrice: 50 };
  const a = await send({ message: "look", client_msg_id: LINE, spend });
  const b = await send({ message: "look", client_msg_id: LINE, spend });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(S.debits, ["spend-abcdef12", "spend-abcdef12"], "both attempts must reach the ledger, which replays the second");
  assert.equal(S.deliveries, 1, "the replayed spend posted a second card");
});

test("no key, or a key that is not a UUID: two sends are two lines (the old behaviour)", async () => {
  await send({ message: "lol" });
  await send({ message: "lol" });
  await send({ message: "lol", client_msg_id: "not-a-uuid" });
  await send({ message: "lol", client_msg_id: "not-a-uuid" });
  assert.equal(S.nativeCalls.length, 4);
  assert.equal(S.nativeCalls[2]?.clientMsgId, undefined, "a malformed key must not be forwarded");
});

test("the replay lookup runs after the ban check and before slow mode, spend and every write", () => {
  const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
  const src = stripComments(raw);
  const at = (re: RegExp) => { const m = re.exec(src); assert.ok(m, `missing ${re}`); return m.index; };
  const ban = at(/return Response\.json\(\{ error: "banned"/);
  const replay = at(/if \(priorLine\) return replayAnswer\(priorLine\)/);
  const slow = at(/await Promise\.all\(\[currentSlowMode\(\)/);
  const spend = at(/const spendReq = body\.spend/);
  const firstWrite = at(/streamApiFetch\(`\/chat\/native`/);
  assert.ok(ban < replay && replay < slow && replay < spend && replay < firstWrite);
  assert.match(raw.slice(-200), /return new Response\("OK"\);\s*\}\s*$/, "vacuity: the route was read to its end");
});
