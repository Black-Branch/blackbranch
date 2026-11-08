// The community's connection health: "reconnecting" only after a SUSTAINED
// loss (ADR 0110 scope: an infrastructure notice is quiet and late), and only
// once the client had synced — before that the boot checklist owns the screen.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/lib/syncHealth.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mountHook, type MountedHook } from "./testDom.ts";
import { setSyncState, useSyncHealth } from "./syncHealth.ts";

async function withClock(fn: (h: MountedHook<"ok" | "reconnecting">) => Promise<void>) {
  mock.timers.enable({ apis: ["setTimeout"] });
  setSyncState("SYNCING", true);
  const h = await mountHook(useSyncHealth);
  try {
    await fn(h);
  } finally {
    await h.act(() => setSyncState("SYNCING", true));
    await h.unmount();
    mock.timers.reset();
  }
}

test("ERROR after PREPARED → reconnecting at 10 000 ms, ok at 9 999", async () => {
  await withClock(async (h) => {
    await h.act(() => setSyncState("ERROR", true));
    await h.act(() => mock.timers.tick(9_999));
    assert.equal(h.current, "ok");
    await h.act(() => mock.timers.tick(1));
    assert.equal(h.current, "reconnecting");
  });
});

test("a repeated ERROR does not restart the clock", async () => {
  // The SDK emits ERROR again on every failed keep-alive (every 5-10 s).
  await withClock(async (h) => {
    await h.act(() => setSyncState("ERROR", true));
    await h.act(() => mock.timers.tick(6_000));
    await h.act(() => setSyncState("ERROR", true));
    await h.act(() => mock.timers.tick(4_000));
    assert.equal(h.current, "reconnecting");
  });
});

test("SYNCING clears", async () => {
  await withClock(async (h) => {
    await h.act(() => setSyncState("ERROR", true));
    await h.act(() => mock.timers.tick(10_000));
    assert.equal(h.current, "reconnecting");
    await h.act(() => setSyncState("SYNCING", true));
    assert.equal(h.current, "ok");
    // A blip that recovers before the clock runs out never shows at all.
    await h.act(() => setSyncState("ERROR", true));
    await h.act(() => mock.timers.tick(5_000));
    await h.act(() => setSyncState("PREPARED", true));
    await h.act(() => mock.timers.tick(10_000));
    assert.equal(h.current, "ok");
  });
});

test("the loss starts at the first failed sync: RECONNECTING arms the clock, the ERROR after it does not restart it", async () => {
  // Measured on the pair (offline): /sync fails → RECONNECTING at +4 s, first
  // keep-alive ERROR at +10 s. The pill is due 10 s after the FIRST.
  await withClock(async (h) => {
    await h.act(() => setSyncState("RECONNECTING", true));
    await h.act(() => mock.timers.tick(6_000));
    await h.act(() => setSyncState("ERROR", true));
    await h.act(() => mock.timers.tick(3_999));
    assert.equal(h.current, "ok");
    await h.act(() => mock.timers.tick(1));
    assert.equal(h.current, "reconnecting");
  });
});

test("a dropped long-poll that recovers within one keep-alive never shows", async () => {
  await withClock(async (h) => {
    await h.act(() => setSyncState("RECONNECTING", true));
    await h.act(() => mock.timers.tick(7_000));
    await h.act(() => setSyncState("SYNCING", true));
    await h.act(() => mock.timers.tick(30_000));
    assert.equal(h.current, "ok");
  });
});

test("CATCHUP neither starts nor clears the clock", async () => {
  await withClock(async (h) => {
    await h.act(() => setSyncState("CATCHUP", true));
    await h.act(() => mock.timers.tick(20_000));
    assert.equal(h.current, "ok");
    await h.act(() => setSyncState("ERROR", true));
    await h.act(() => mock.timers.tick(10_000));
    await h.act(() => setSyncState("CATCHUP", true));
    assert.equal(h.current, "reconnecting", "still reconnecting until a sync lands");
  });
});

test("ERROR before PREPARED stays ok", async () => {
  await withClock(async (h) => {
    await h.act(() => setSyncState("ERROR", false));
    await h.act(() => mock.timers.tick(60_000));
    assert.equal(h.current, "ok");
    await h.act(() => setSyncState("RECONNECTING", false));
    await h.act(() => mock.timers.tick(60_000));
    assert.equal(h.current, "ok", "nor RECONNECTING — the boot checklist owns that screen");
  });
});
