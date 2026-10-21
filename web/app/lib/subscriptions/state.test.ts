// The ONE transition function on the REAL schema (subscription sources, spec §4, §13.1).
//
// The recency gate, the ownership rule, the locks and the entitlement fragment are all SQL, so a
// mock pool could test none of them: every case here runs through the runtime driver against a
// replayed Postgres (SQL_PARSE_DATABASE_URL, the subscriptionSync.test.ts setup). Named for what
// each proves, including the two the engineering standard asks of every fix: a transition replayed
// after a RESTART (a new process: a new pool and a new instance) is idempotent, and the same event
// delivered TWICE (a RETRY) writes once and still re-runs.
// Locally: SQL_PARSE_DATABASE_URL=… node --test app/lib/subscriptions/state.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { createConcurrencyGate } from "../concurrencyGate.ts";
import { highestTier } from "../tiers.ts";
import { createSubscriptionState, writeTransition, withClaimRetry, OwnerChangedError } from "./state.ts";
import { VIEWER_TIERS_SQL } from "./entitlement.ts";
import type { Observation, Provider } from "./types.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway on this machine (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

const RUN = `substate${process.pid}x${Date.now().toString(36)}`;
const SOURCES: Provider[] = ["stripe", "paypal"];
const T = new Date("2026-10-20T12:00:00Z");
const at = (secs: number) => new Date(T.getTime() + secs * 1000);
const roomy = () => createConcurrencyGate({ maxConcurrent: 4, maxQueued: 10, maxWaitMs: 5000 });
let seq = 0;

function obs(externalId: string, over: Partial<Observation> = {}): Observation {
  return {
    provider: "stripe", externalId, tier: "supporter", status: "active", providerStatus: "active",
    renews: true, periodEnd: null, accessUntil: null, accountRef: null, observedAt: T, ...over,
  };
}

test("the transition function, on a real database", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 6 });
  const clean = async () => {
    await pool.query(`DELETE FROM site.subscription_events WHERE event_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM site.subscription_records WHERE external_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  const { applyTransition } = createSubscriptionState({ pool });
  const viewer = async () => {
    const who = `@${RUN}-${++seq}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    return who;
  };
  const sub = () => `${RUN}_sub_${++seq}`;
  const apply = (who: string | null, observations: Observation[], extra: Partial<Parameters<typeof applyTransition>[0]> = {}) =>
    applyTransition({ via: "webhook", viewer: who, observations, sources: SOURCES, budget: roomy(), ...extra });
  const record = async (externalId: string) =>
    (await pool.query(`SELECT matrix_id, status, tier, source_event_at FROM site.subscription_records WHERE provider = 'stripe' AND external_id = $1`, [externalId])).rows[0];

  await t.test("an observation strictly older than the record is dropped, and the record keeps its state", async () => {
    const who = await viewer(); const id = sub();
    await apply(who, [obs(id, { status: "ended", providerStatus: "canceled", observedAt: at(10) })]);
    const r = await apply(who, [obs(id, { status: "active", observedAt: at(5) })]);
    assert.equal(r.dropped.length, 1);
    assert.equal(r.wrote.length, 0);
    assert.equal((await record(id)).status, "ended");
    assert.equal(r.after.supporter, false);
  });

  await t.test("an EQUAL stamp passes: the state was read from the provider under the lock", async () => {
    const who = await viewer(); const id = sub();
    await apply(who, [obs(id, { status: "active", observedAt: at(10) })]);
    const r = await apply(who, [obs(id, { status: "ended", providerStatus: "canceled", observedAt: at(10) })]);
    assert.equal(r.wrote.length, 1);
    assert.equal((await record(id)).status, "ended");
    assert.deepEqual([r.before.supporter, r.after.supporter], [true, false]);
  });

  await t.test("two records for one viewer: ending one leaves them a Supporter", async () => {
    const who = await viewer(); const a = sub(); const b = sub();
    await apply(who, [obs(a), obs(b, { provider: "paypal" })]);
    const r = await apply(who, [obs(a, { status: "ended", providerStatus: "canceled", observedAt: at(1) })]);
    assert.deepEqual(r.after, { supporter: true, tier: "supporter" });
    assert.equal((await record(a)).status, "ended");
  });

  await t.test("the tier is the highest rank among the entitling records (a test-only second tier)", async () => {
    const who = await viewer(); const a = sub(); const b = sub();
    // A tier slug the product does not sell is stored as written; ranked with a test order.
    await apply(who, [obs(a), obs(b, { provider: "paypal", tier: "patron" as never })]);
    const tiers = (await pool.query<{ tier: string }>(VIEWER_TIERS_SQL, [who, SOURCES])).rows.map((x) => x.tier);
    assert.equal(highestTier(tiers, ["supporter", "patron"]), "patron");
    assert.equal(highestTier(tiers, ["patron", "supporter"]), "supporter", "the order decides, not the row order");
    assert.equal(highestTier(tiers), "supporter", "with the product's order an unknown slug ranks nowhere");
  });

  await t.test("access_until in the past does not entitle; in the future it does", async () => {
    const who = await viewer(); const id = sub();
    const past = await apply(who, [obs(id, { provider: "paypal", accessUntil: new Date(Date.now() - 60_000) })]);
    assert.equal(past.after.supporter, false);
    const future = await apply(who, [obs(id, { provider: "paypal", accessUntil: new Date(Date.now() + 60_000), observedAt: at(1) })]);
    assert.equal(future.after.supporter, true);
  });

  await t.test("past_due entitles, paused and pending do not, and a record with no tier never does", async () => {
    for (const [over, want] of [
      [{ status: "past_due" }, true], [{ status: "paused" }, false], [{ status: "pending" }, false], [{ tier: null }, false],
    ] as const) {
      const who = await viewer();
      assert.equal((await apply(who, [obs(sub(), over as Partial<Observation>)])).after.supporter, want, JSON.stringify(over));
    }
  });

  await t.test("an unclaimed record entitles nobody, and is claimed by a later transition for a viewer", async () => {
    const id = sub();
    const r = await apply(null, [obs(id)]);
    assert.equal(r.wrote.length, 1);
    assert.equal((await record(id)).matrix_id, null);
    const n = (await pool.query(`SELECT count(*)::int AS n FROM site.subscription_records r WHERE r.external_id = $1
      AND r.matrix_id IS NOT NULL`, [id])).rows[0].n;
    assert.equal(n, 0, "no viewer holds it");
    await assert.rejects(apply(null, [obs(sub()), obs(sub())]), /exactly one record/);
    const who = await viewer();
    const claimed = await apply(who, [obs(id, { observedAt: at(1) })], { via: "link" });
    assert.equal(claimed.after.supporter, true);
    assert.equal((await record(id)).matrix_id, who);
  });

  await t.test("a record owned by viewer A refuses an observation for viewer B, loudly, and writes nothing", async () => {
    const a = await viewer(); const b = await viewer(); const id = sub();
    await apply(a, [obs(id)]);
    const r = await apply(b, [obs(id, { status: "ended", providerStatus: "canceled", observedAt: at(5) })]);
    assert.equal(r.refused.length, 1);
    assert.equal(r.wrote.length, 0);
    assert.deepEqual(await record(id).then((x) => [x.matrix_id, x.status]), [a, "active"]);
    assert.equal(r.after.supporter, false, "B gains nothing");
    // …and an unclaimed observation cannot detach it either.
    const detach = await apply(null, [obs(id, { observedAt: at(6) })]);
    assert.equal(detach.refused.length, 1);
    assert.equal((await record(id)).matrix_id, a);
  });

  await t.test("two concurrent calls for one viewer serialise: the second waits on the lock and sees the first's write", async () => {
    const who = await viewer(); const a = sub(); const b = sub();
    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      await writeTransition(held, { via: "webhook", viewer: who, observations: [obs(a)], sources: SOURCES });
      let settled = false;
      const second = apply(who, [obs(b, { provider: "paypal", status: "ended", providerStatus: "CANCELLED" })])
        .finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(settled, false, "the second call must wait while the first holds the viewer's lock");
      await held.query("COMMIT");
      const r = await second;
      assert.equal(r.before.supporter, true, "the second ran after the first committed and read its record");
    } finally {
      held.release();
    }
  });

  await t.test("a full budget throws holding no connection", async () => {
    // A pool that only counts: the property is whether a connection is ASKED for, and a fake one
    // cannot leak a real connection when a mutant takes it before the budget.
    let connects = 0;
    const counting = { connect: async () => { connects++; return { query: async () => ({ rows: [] }), release: () => {} }; } };
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 0, maxWaitMs: 10 });
    const release = await gate.acquire();
    assert.ok(release);
    const { applyTransition: limited } = createSubscriptionState({ pool: counting as unknown as Pool });
    await assert.rejects(limited({ via: "webhook", viewer: null, observations: [obs(sub())], sources: SOURCES, budget: gate }), /budget full/);
    assert.equal(connects, 0, "refused before the pool was asked");
    release!();
  });

  await t.test("the claim race retries once, then throws", async () => {
    const who = await viewer(); const other = await viewer(); const id = sub();
    await apply(null, [obs(id)]);
    let attempts = 0;
    // Every attempt reads the owner unlocked, then another claim moves it before the locks.
    const racing = () => withClaimRetry(async () => {
      attempts++;
      const owner = (await record(id)).matrix_id as string | null;
      await pool.query(`UPDATE site.subscription_records SET matrix_id = $2 WHERE external_id = $1`, [id, owner ? null : other]);
      return apply(who, [obs(id, { expectOwner: owner, observedAt: at(attempts) })], { via: "link" });
    });
    await assert.rejects(racing(), OwnerChangedError);
    assert.equal(attempts, 2, "exactly one retry");
    // A race that does not repeat: the retry claims it.
    await pool.query(`UPDATE site.subscription_records SET matrix_id = NULL WHERE external_id = $1`, [id]);
    let tries = 0;
    const r = await withClaimRetry(async () => {
      tries++;
      const owner = (await record(id)).matrix_id as string | null;
      if (tries === 1) await pool.query(`UPDATE site.subscription_records SET matrix_id = $2 WHERE external_id = $1`, [id, other]);
      if (tries === 2) await pool.query(`UPDATE site.subscription_records SET matrix_id = NULL WHERE external_id = $1`, [id]);
      return apply(who, [obs(id, { expectOwner: tries === 2 ? null : owner, observedAt: at(10 + tries) })], { via: "link" });
    });
    assert.equal(tries, 2);
    assert.equal(r.after.supporter, true);
    assert.equal((await record(id)).matrix_id, who);
  });

  await t.test("retry: the same event delivered twice writes one event row, the same record, and still re-runs", async () => {
    const who = await viewer(); const id = sub();
    const event = { provider: "stripe" as const, id: `${RUN}_evt_${++seq}`, type: "customer.subscription.created", occurredAt: T };
    const first = await apply(who, [obs(id)], { event });
    const second = await apply(who, [obs(id)], { event });
    assert.equal(first.firstActive.length, 1, "the first delivery made it active for the first time");
    assert.equal(second.wrote.length, 1, "the event row is audit only, never a gate: the redelivery re-ran");
    assert.equal(second.firstActive.length, 0, "…and is not 'first' a second time");
    const events = (await pool.query(`SELECT outcome FROM site.subscription_events WHERE provider = 'stripe' AND event_id = $1`, [event.id])).rows;
    assert.deepEqual(events, [{ outcome: "applied" }]);
    const n = (await pool.query(`SELECT count(*)::int AS n FROM site.subscription_records WHERE external_id = $1`, [id])).rows[0].n;
    assert.equal(n, 1);
  });

  await t.test("restart: a transition replayed by a NEW process (new pool, new instance) is idempotent", async () => {
    const who = await viewer(); const a = sub(); const b = sub();
    const input = [obs(a), obs(b, { status: "ended", providerStatus: "canceled", tier: null })];
    const before = await apply(who, input);
    const snap = async () => (await pool.query(
      `SELECT provider, external_id, matrix_id, tier, status, provider_status, renews, period_end, access_until, source_event_at
         FROM site.subscription_records WHERE external_id = ANY($1) ORDER BY external_id`, [[a, b]])).rows;
    const rows = await snap();
    const pool2 = new Pool({ connectionString: DB_URL, max: 2 });
    try {
      const fresh = createSubscriptionState({ pool: pool2 });
      const again = await fresh.applyTransition({ via: "webhook", viewer: who, observations: input, sources: SOURCES, budget: roomy() });
      assert.deepEqual(await snap(), rows, "the replay changed no record");
      assert.deepEqual(again.after, before.after);
      assert.equal(again.firstActive.length, 0);
    } finally {
      await pool2.end();
    }
  });

  await t.test("turning a source off removes exactly its members; turning it back on restores them", async () => {
    const who = await viewer(); const id = sub();
    await apply(who, [obs(id, { provider: "paypal" })]);
    const on = await apply(who, [obs(id, { provider: "paypal", observedAt: at(1) })]);
    const off = await apply(who, [obs(id, { provider: "paypal", observedAt: at(2) })], { sources: ["stripe"] });
    const kept = (await pool.query(`SELECT status FROM site.subscription_records WHERE provider = 'paypal' AND external_id = $1`, [id])).rows;
    assert.deepEqual(kept, [{ status: "active" }], "switching a source off keeps its records");
    const back = await apply(who, [obs(id, { provider: "paypal", observedAt: at(3) })]);
    assert.deepEqual([on.after.supporter, off.after.supporter, back.after.supporter], [true, false, true]);
  });
});
