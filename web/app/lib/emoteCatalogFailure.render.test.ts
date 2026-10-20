// A THROWN catalog fetch reads as a DONE stage: the site works without emotes
// and a community boot's subject is the client, so an "error" here would put
// the whole pane in the failed phase behind a Try again that could never clear
// it — `retry()` restarts Matrix only, while `useEmotes.ts`'s `freshFetch` is
// memoised for the page's life.
//
// Its OWN file, not a second case in emoteReadiness.render.test.ts. Both
// fetch paths dedup at module level (`freshFetch` there, `fetched` in
// usePersonalEmotes.ts), so the FIRST fetch in a process is the only one that
// can be made to fail — a second scenario in that file would either never
// refetch or break the passing one. `node --test` runs each file in its own
// process, which is the isolation this needs.
import test from "node:test";
import assert from "node:assert/strict";
import { mountHook, resetStorage } from "./testDom.ts";
import "./testTsx.ts";
import { readReadiness } from "./readiness.ts";
import { EMOTES_READINESS_KEY } from "./emoteReadiness.ts";
const { useEmotes } = await import("./useEmotes.ts");

const statuses = () => readReadiness([EMOTES_READINESS_KEY]).map((s) => `${s.id}:${s.status}`);

test("a rejected catalog fetch leaves the stage DONE — a dead CDN must not fail the community boot", async () => {
  resetStorage();
  const realFetch = (globalThis as unknown as { fetch: unknown }).fetch;
  // serveJson's shape (testDom.ts), rejecting instead of resolving: this is the
  // offline / DNS / refused case, where getJson's promise rejects outright.
  (globalThis as unknown as { fetch: unknown }).fetch = () => Promise.reject(new Error("offline"));
  try {
    assert.deepEqual(statuses(), ["catalog:pending", "personal:pending"], "nothing fetched yet");
    const h = await mountHook(() => useEmotes());
    await h.act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(h.current, {}, "the hook still returns a map — no emotes, its own empty fallback");
    const view = readReadiness([EMOTES_READINESS_KEY]);
    const catalog = view.find((s) => s.id === "catalog")!;
    assert.equal(catalog.status, "done", "a thrown fetch is not a failed boot stage");
    assert.equal(catalog.error, null, "…and carries no error to render");
    assert.deepEqual(statuses(), ["catalog:done", "personal:pending"], "personal is untouched — its own hook never mounted");
    await h.unmount();
  } finally {
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  }
});
