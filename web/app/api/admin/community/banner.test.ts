// Admin Panel › Site › Community › Banner: the upload lands on the community's own row (the hub
// space), then the host is asked to put it on the space. Mocked pool + a fake upload; the column
// itself is read from a real Postgres in desired.db.test.ts.
// Run: env -u DATABASE_URL node --test app/api/admin/community/banner.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../lib/sourceText.mjs";
import { clearBannerResponse, putBannerResponse, type CommunityDeps } from "../../../lib/community/communityAdmin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MXC = "mxc://example.test/banner1";
const ASKED_AT = "2026-10-30T12:00:00Z";

/** A pool that logs every statement; `hub` says whether the community's row exists. */
function harness({ hub = true, ask = true }: { hub?: boolean; ask?: boolean } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const asked: number[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    if (/UPDATE site\.community_spaces SET banner_mxc/.test(sql)) return { rows: hub ? [{ id: 1 }] : [] };
    return { rows: [] };
  };
  const deps: CommunityDeps = {
    pool: { query: query as never, connect: async () => ({ query: query as never, release: () => {} }) },
    ask: async () => {
      asked.push(calls.length);
      return ask ? { ok: true as const, requestedAt: ASKED_AT } : { ok: false as const, error: "the reconciler is off on this install" };
    },
    retentionCapDays: () => 365,
    log: { log: () => {}, error: () => {} },
  };
  const writes = () => calls.filter((c) => /UPDATE site\.community_spaces/.test(c.sql));
  return { deps, calls, asked, writes };
}

const uploaded = (contentUri = MXC) => async () => ({ ok: true as const, contentUri });
const read = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null });

test("an uploaded banner is saved on the community's row, then the host is asked to apply it", async () => {
  const h = harness();
  const r = await read(await putBannerResponse(uploaded(), h.deps));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, bannerMxc: MXC, requestedAt: ASKED_AT });
  const w = h.writes();
  assert.equal(w.length, 1);
  assert.match(w[0]!.sql, /SET banner_mxc = \$1, updated_at = now\(\) WHERE kind = 'hub'/, "the community's own row, never a category");
  assert.deepEqual(w[0]!.params, [MXC]);
  assert.ok(h.calls.some((c) => c.sql === "BEGIN") && h.calls.some((c) => c.sql === "COMMIT"), "in one transaction");
  assert.equal(h.asked.length, 1, "the host is asked after the save");
  assert.ok(h.asked[0]! > h.calls.findIndex((c) => c.sql === "COMMIT"), "asked after the commit");
});

test("a refused upload writes nothing and asks nobody; its answer is passed on", async () => {
  const h = harness();
  const res = await putBannerResponse(async () => ({ ok: false as const, response: new Response("Max 2 MB", { status: 400 }) }), h.deps);
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Max 2 MB");
  assert.equal(h.calls.length, 0);
  assert.equal(h.asked.length, 0);
});

test("with no community yet the banner is refused in plain words", async () => {
  const h = harness({ hub: false });
  const r = await read(await putBannerResponse(uploaded(), h.deps));
  assert.equal(r.status, 409);
  assert.equal(r.body?.error, "There is no community yet. Finish the community setup first.");
  assert.ok(h.calls.some((c) => c.sql === "ROLLBACK"));
  assert.equal(h.asked.length, 0);
});

test("with the reconciler off the banner is still saved, and the answer says the host was not asked", async () => {
  const h = harness({ ask: false });
  const r = await read(await putBannerResponse(uploaded(), h.deps));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, bannerMxc: MXC, requestedAt: null });
  assert.equal(h.writes().length, 1);
});

test("Remove clears the banner (NULL) and asks the host", async () => {
  const h = harness();
  const r = await read(await clearBannerResponse(h.deps));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, bannerMxc: null, requestedAt: ASKED_AT });
  assert.deepEqual(h.writes()[0]!.params, [null]);
});

test("banner retry: sending the same banner again saves the same value and asks again; nothing piles up", async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) assert.equal((await putBannerResponse(uploaded(), h.deps)).status, 200);
  assert.deepEqual(h.writes().map((w) => w.params), [[MXC], [MXC]], "one column, overwritten: a retry is the same state");
  assert.equal(h.asked.length, 2);
});

test("the route uploads through the admin's own session with the banner's limits", () => {
  const src = stripComments(readFileSync(join(here, "banner/route.ts"), "utf8"));
  assert.match(src, /uploadImageToMatrixMedia\(req, \{[^}]*field: "banner"/);
  assert.match(src, /maxBytes: 2 \* 1024 \* 1024/);
  assert.match(src, /mimes: \["image\/png", "image\/jpeg", "image\/webp"\]/);
  assert.match(src, /export async function DELETE\(req: Request\)/, "vacuity: the scan read to the route's last handler");
});
