// A Supporter perk (the redacted-message option) must appear without a page
// reload after a subscription. BadgesProvider's `refresh` — the thing the
// webhook's badges_changed push, focus, visibility and the 60 s poll all call —
// re-reads /api/me (supporter, tier, admin, mod) as well as /api/badges;
// re-reading only the badges would let a new subscription reach the badge map
// live while the perk gate never moves.
//
// These tests MOUNT the provider and drive `refresh`, so they measure what the
// context actually hands its readers, not the shape of the source.
//
// Run: node --test app/lib/badgesMeRefresh.render.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "./testDom.ts";
// Static, and BEFORE the component import: registers the resolver that lets a
// .tsx specifier load at all (iconRail.render.test.ts's header explains why).
import "./testTsx.ts";
const { BadgesProvider, useBadges } = await import("./BadgesContext.tsx");
const { createRoot } = await import("react-dom/client");

type Me = { isAdmin?: boolean; isMod?: boolean; matrixId?: string | null; tier?: string | null; supporter?: boolean };

/** Route /api/me to a mutable box (or a 500 while `meFails`); /api/badges is empty. */
function serve(me: Me) {
  const box = { me, meFails: false, meReads: 0 };
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string) => {
    if (url === "/api/me") {
      box.meReads++;
      if (box.meFails) return Promise.resolve(new Response(JSON.stringify({ error: "down" }), { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(box.me), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ catalog: [], perUser: {} }), { status: 200 }));
  };
  return box;
}

type Ctx = ReturnType<typeof useBadges>;

/** Mount, run `body`, and ALWAYS unmount — the provider owns a 60 s interval,
 *  so an assertion that skips the unmount leaves the test process hanging. */
async function withMounted(body: (m: { readonly ctx: Ctx }) => Promise<void>) {
  const m = await mount();
  try {
    await body(m);
  } finally {
    await m.unmount();
  }
}

async function mount() {
  const ref: { current: Ctx | null } = { current: null };
  function Probe() {
    ref.current = useBadges();
    return null;
  }
  const root = createRoot(dom.window.document.createElement("div"));
  await settle(() => root.render(React.createElement(BadgesProvider, null, React.createElement(Probe))));
  return {
    get ctx() { return ref.current!; },
    unmount: () => act(async () => { root.unmount(); }),
  };
}

/** Run `fn`, then let the fetch → json → setState chain land. */
async function settle(fn: () => void) {
  await act(async () => {
    fn();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

test("refresh re-reads /api/me: a new subscription reaches `supporter` and `tier` without a reload", async () => {
  const box = serve({ matrixId: "@v:site.test", tier: null, supporter: false });
  await withMounted(async (m) => {
    assert.equal(m.ctx.supporter, false, "precondition: the mount read landed");
    assert.equal(m.ctx.tier, null);

    box.me = { matrixId: "@v:site.test", tier: "supporter", supporter: true, isMod: true, isAdmin: true };
    await settle(() => m.ctx.refresh());
    assert.equal(m.ctx.supporter, true, "the perk gate stayed stale after refresh — the redacted option waits for a reload");
    assert.equal(m.ctx.tier, "supporter");
    assert.equal(m.ctx.isMod, true, "mod status did not follow the refresh");
    assert.equal(m.ctx.isAdmin, true, "admin status did not follow the refresh");
  });
});

test("a FAILED /api/me read during refresh leaves the previous answer alone", async () => {
  const box = serve({ matrixId: "@v:site.test", tier: "supporter", supporter: true, isMod: true });
  await withMounted(async (m) => {
    assert.equal(m.ctx.supporter, true, "precondition");

    box.meFails = true;
    const before = box.meReads;
    await settle(() => m.ctx.refresh());
    assert.ok(box.meReads > before, "precondition: the refresh actually tried /api/me");
    assert.equal(m.ctx.supporter, true, "a blip revoked a Supporter's perks");
    assert.equal(m.ctx.tier, "supporter", "a blip cleared the tier");
    assert.equal(m.ctx.isMod, true, "a blip demoted a mod");
  });
});

test("a failed FIRST read stays `undefined` (unknown), never false", async () => {
  const box = serve({});
  box.meFails = true;
  await withMounted(async (m) => {
    assert.equal(m.ctx.supporter, undefined, "unknown was reported as 'no subscription'");
    assert.equal(m.ctx.tier, undefined);
  });
});
