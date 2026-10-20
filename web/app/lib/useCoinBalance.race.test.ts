// The balance a spend RETURNS must never be overwritten by a refresh that was
// already in flight when the spend landed.
//
// The symptom: tap Buy → the chip drops to the post-spend number → then
// visibly jumps BACK UP, because a mount/focus refresh had read the pre-spend
// balance and its .then landed after the spend response wrote the fresh one.
// The stale read wins purely by arriving last.
//
// `.ts` extensions are REQUIRED on these imports — `node --test` cannot
// resolve extensionless TypeScript specifiers.
//
// Run: node --test app/lib/useCoinBalance.race.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mountHook } from "./testDom.ts";
import { useCoinBalance, setCoinBalance, refreshCoinBalance } from "./useCoinBalance.ts";

type FetchLike = typeof globalThis.fetch;
function stubFetch(impl: (...args: Parameters<FetchLike>) => ReturnType<FetchLike>) {
  (globalThis as unknown as { fetch: unknown }).fetch = impl;
}
const balanceResponse = (balance: number) =>
  new Response(JSON.stringify({ balance, earned: balance }), {
    status: 200, headers: { "content-type": "application/json" },
  });

test("a spend response landing mid-refresh WINS — the stale read must not overwrite it", async () => {
  let resolveFetch!: (r: Response) => void;
  stubFetch(() => new Promise<Response>((r) => { resolveFetch = r; }));

  const h = await mountHook(() => useCoinBalance(false)); // enabled=false: we drive refreshes by hand
  await h.act(() => setCoinBalance(9_000));               // known starting point

  refreshCoinBalance();                                    // reads the PRE-spend balance…
  await h.act(() => setCoinBalance(8_400));                // …the spend response lands first
  assert.equal(h.current, 8_400);

  await h.act(async () => {
    resolveFetch(balanceResponse(9_000));                  // …now the stale read arrives
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.equal(h.current, 8_400,
    "the in-flight refresh overwrote a fresher spend response — the chip visibly jumps back up");
  await h.unmount();
});

test("an undisturbed refresh still applies its result", async () => {
  stubFetch(() => Promise.resolve(balanceResponse(7_777)));
  const h = await mountHook(() => useCoinBalance(false));
  await h.act(async () => {
    refreshCoinBalance();
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.equal(h.current, 7_777, "the guard must only drop STALE reads, not all of them");
  await h.unmount();
});
