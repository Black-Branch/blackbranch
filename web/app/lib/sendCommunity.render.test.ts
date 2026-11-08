// A send carries the community entry the viewer watches (liveness Task 9, Review Focus 4): the real
// useSendChatMessage, mounted, with fetch captured — what leaves the browser, not what the source says.
// Run: node --test app/lib/sendCommunity.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountHook } from "./testDom.ts";
import "./testTsx.ts";

const { useSendChatMessage } = await import("@/app/lib/useSendChatMessage");

function captureSends(): unknown[] {
  const bodies: unknown[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "null"));
    return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
  };
  return bodies;
}

test("a viewer watching another community streamer sends with that entry's key", async () => {
  const bodies = captureSends();
  const h = await mountHook(() => useSendChatMessage(() => {}, "tw:otherlogin"));
  await h.act(async () => { await h.current("hello", null, "twitch"); });
  assert.equal(bodies.length, 1);
  assert.deepEqual({ community: (bodies[0] as Record<string, unknown>).community, to: (bodies[0] as Record<string, unknown>).forced_destination },
    { community: "tw:otherlogin", to: "twitch" });
  await h.unmount();
});

test("no community entry on screen (a popout, the streamer live): no `community` at all", async () => {
  const bodies = captureSends();
  const h = await mountHook(() => useSendChatMessage(() => {}));
  await h.act(async () => { await h.current("hello", null, null); });
  assert.equal(bodies.length, 1);
  assert.equal("community" in (bodies[0] as Record<string, unknown>), false);
  await h.unmount();
});
