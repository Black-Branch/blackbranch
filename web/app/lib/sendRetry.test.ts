// The send hook when /api/chat/send does not answer in time, RUN against a stubbed fetch. Every
// attempt at a line carries one `client_msg_id`, and the route answers a key it already stored
// with the first row instead of posting again (api/chat/send/replay.test.ts). That makes a retry
// safe, so a timeout is retried ONCE with the same id before the sender is told anything, and what
// they are told after a second timeout is the truth: resending will not post the line twice.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/lib/sendRetry.test.ts
import test from "node:test";
import assert from "node:assert/strict";

await import("./testTsx.ts");
const { useSendChatMessage } = await import("./useSendChatMessage.ts");
const { siteName } = await import("./siteName.ts");

// Not a React hook despite the name: it builds a plain async sender, built inside each call.
function useSend() { return useSendChatMessage(() => {}); }
const useSendNow = (...args: Parameters<ReturnType<typeof useSend>>) => useSend()(...args);
const realFetch = globalThis.fetch;
type Body = { message?: string; client_msg_id?: string; spend?: unknown };
let bodies: Body[] = [];
/** Each attempt in turn: "timeout", "offline", or a JSON answer. */
function attempts(...plan: ("timeout" | "offline" | { status: number; body: unknown })[]) {
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    const step = plan[bodies.length - 1] ?? "timeout";
    if (step === "timeout") throw new DOMException("signal timed out", "TimeoutError");
    if (step === "offline") throw new TypeError("fetch failed");
    return Response.json(step.body, { status: step.status });
  }) as typeof fetch;
}
test.beforeEach(() => { bodies = []; });
test.afterEach(() => { globalThis.fetch = realFetch; });

async function thrown(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error("expected the send to throw");
}
const LINE = "0d7c2b1a-9e8f-4a3b-8c2d-1e0f9a8b7c6d";
const HONEST = () => `${siteName()} didn't answer. Resending is safe — the site never posts the same line twice.`;

test("retry: a timeout is retried once with the same client_msg_id; the retry's answer is the send's", async () => {
  attempts("timeout", { status: 200, body: { ok: true, replayed: true, id: 9 } });
  await useSendNow("hey", null, null, null, false, LINE);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.map((b) => b.client_msg_id), [LINE, LINE], "the retry must carry the same id");
  assert.equal(bodies[1]?.message, "hey");
});

test("retry: a second timeout throws the honest sentence, after exactly two attempts", async () => {
  attempts("timeout", "timeout");
  const err = await thrown(useSendNow("hey", null, null, null, false, LINE));
  assert.equal(err.message, HONEST());
  assert.equal(bodies.length, 2, "one automatic retry, not more");
});

test("a retry that finds the network gone says offline", async () => {
  attempts("timeout", "offline");
  const err = await thrown(useSendNow("hey", null, null, null, false, LINE));
  assert.match(err.message, /offline/);
});

test("offline at once is not retried: the request never left", async () => {
  attempts("offline");
  const err = await thrown(useSendNow("hey", null, null, null, false, LINE));
  assert.match(err.message, /You're offline — message not sent/);
  assert.equal(bodies.length, 1);
});

test("a spend is not retried automatically, and is told it will not be charged twice", async () => {
  attempts("timeout", { status: 200, body: { ok: true } });
  const err = await thrown(useSendNow("look", null, null, { mode: "highlight", spendId: "spend-abcdef12", expectedPrice: 50 }, false, LINE));
  assert.equal(bodies.length, 1);
  assert.equal(err.message, `${siteName()} didn't answer. Resending is safe — you're never charged twice for one message.`);
});

test("a caller with no id still gets one, the same on both attempts; two sends get two ids", async () => {
  attempts("timeout", { status: 200, body: { ok: true, id: 1 } }, { status: 200, body: { ok: true, id: 2 } });
  await useSendNow("a", null);
  await useSendNow("a", null);
  const [first, retry, second] = bodies.map((b) => b.client_msg_id);
  assert.match(first ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(retry, first);
  assert.notEqual(second, first, "a new send must not reuse the last one's id");
});
