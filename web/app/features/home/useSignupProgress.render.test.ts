import { test } from "node:test";
import assert from "node:assert/strict";
import { mountHook, serveJson, React } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { useSignupProgress } = await import("./useSignupProgress.ts");

const tick = async () => { await new Promise((r) => setTimeout(r, 0)); };

test("signed out or inactive: asks nothing; signed out is null, not-yet-asked is undefined", async () => {
  let fetched = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = () => { fetched++; throw new Error("must not fetch"); };
  const out = await mountHook(() => useSignupProgress(true, false));
  await out.act(tick);
  assert.equal(out.current.step, null, "signed out: no steps, ever");
  await out.unmount();
  const idle = await mountHook(() => useSignupProgress(false, true));
  await idle.act(tick);
  assert.equal(idle.current.step, undefined, "inactive: not asked yet (the card, never the steps)");
  await idle.unmount();
  assert.equal(fetched, 0, "no fetch happened");
});

test("signed in and active: undefined while the answer is pending (the card), then the step", async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = () => new Promise(() => {});
  const pending = await mountHook(() => useSignupProgress(true, true));
  await pending.act(tick);
  assert.equal(pending.current.step, undefined, "no answer yet → the card, never a flash of steps");
  await pending.unmount();
  serveJson({ step: 5 });
  const h = await mountHook(() => useSignupProgress(true, true));
  await h.act(tick);
  assert.equal(h.current.step, 5);
  await h.unmount();
});

test("setStep shows the new step at once and PUTs it", async () => {
  const puts: unknown[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ok: true, step: "done" })); }
    return new Response(JSON.stringify({ step: null }));
  };
  const h = await mountHook(() => useSignupProgress(true, true));
  await h.act(tick);
  assert.equal(h.current.step, null);
  await h.act(async () => { h.current.setStep("done"); await tick(); });
  assert.equal(h.current.step, "done");
  assert.deepEqual(puts, [{ step: "done" }]);
  await h.unmount();
});

// Review Important 2: the identity provider starts with matrixId = null, so the
// column's first render is signedIn=false (→ null) and the flip to true must
// read as "not asked yet" (undefined), not "no row" (null) — otherwise every
// signed-in visit flashed "Step 1 of 3" until /api/home/me answered.
test("signedIn flipping false → true reads undefined while the answer is pending, never null", async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = () => new Promise(() => {});
  let setSignedIn: (v: boolean) => void = () => {};
  const h = await mountHook(() => {
    const [signedIn, set] = React.useState(false);
    setSignedIn = set;
    return useSignupProgress(true, signedIn);
  });
  await h.act(tick);
  assert.equal(h.current.step, null);
  await h.act(async () => { setSignedIn(true); await tick(); });
  assert.equal(h.current.step, undefined, "pending after the flip → the card, not step 2");
  await h.unmount();
});
