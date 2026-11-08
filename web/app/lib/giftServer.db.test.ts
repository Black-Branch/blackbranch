// A gift's grant, badge and announce against the real schema (A1-04, P06).
//
// The grant used to autocommit and the badge write ran after it, outside any transaction, and the
// announce — the only path that credits the bar and support_events with the gift's money — ran
// only when THIS delivery inserted the grant. So a badge write that failed once (or a restart
// between the grant and the announce) left the grant committed, and Stripe's redelivery hit
// ON CONFLICT, granted nothing, and announced nothing: the money never reached the bar. And a
// community pick whose query failed read as "nobody to pick" and parked every slot for strangers.
// Now the grant, its badge and any parked slots are one transaction, the announce is sent on
// every delivery with every recipient the session has granted (stream-api's ledger dedups on the
// session's spendId), and a failed pick throws.
//
// The webhook delivers a real-shaped checkout.session.completed object. Runs in CI (web job sets
// SQL_PARSE_DATABASE_URL); locally point it at a throwaway replayed database.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool, type PoolClient } from "pg";
import type Stripe from "stripe";

const { createGiftRecorder, giftAnnounced } = await import("./giftServer.ts");

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

const RUN = `giftdb${process.pid}x${Date.now().toString(36)}`;
let seq = 0;

type Announced = { recipients: string[]; sessionId: string; amountCents: number; giftKind: string };

/** A completed gift Checkout session, as Stripe delivers it. */
function session(id: string, meta: Record<string, string>): Stripe.Checkout.Session {
  return {
    id, object: "checkout.session", mode: "payment", payment_status: "paid", status: "complete",
    amount_total: 1000, currency: "usd", metadata: { kind: "gift", months: "1", anonymous: "0", ...meta },
  } as unknown as Stripe.Checkout.Session;
}

test("a gift's grant, badge and announce", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  const clean = async () => {
    await pool.query(`DELETE FROM site.gift_subscriptions WHERE stripe_session_id LIKE $1`, [`cs_${RUN}%`]);
    await pool.query(`DELETE FROM site.gift_pending WHERE stripe_session_id LIKE $1`, [`cs_${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  const fresh = async () => {
    const n = ++seq;
    const gifter = `@${RUN}-g${n}:site.test`, recipient = `@${RUN}-r${n}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1), ($2)`, [gifter, recipient]);
    return { gifter, recipient, sessionId: `cs_${RUN}_${n}` };
  };
  const grants = async (sessionId: string) =>
    (await pool.query<{ recipient_matrix_id: string; expires_at: Date }>(
      `SELECT recipient_matrix_id, expires_at FROM site.gift_subscriptions WHERE stripe_session_id = $1`, [sessionId])).rows;

  /** A recorder whose badge write fails `badgeFailures` times, then succeeds on the same
   *  transaction; announces are recorded, and the first `announceCrashes` throw (a process that
   *  died mid-handler). */
  const recorder = (o: { badgeFailures?: number; announceCrashes?: number; pool?: Pool; priceCurrency?: string; holdMs?: number } = {}) => {
    let badgeFailures = o.badgeFailures ?? 0, announceCrashes = o.announceCrashes ?? 0;
    const announced: Announced[] = [];
    const badges: string[] = [];
    const currencies: string[] = [];
    const slots: number[] = [];
    const r = createGiftRecorder({
      pool: o.pool ?? pool,
      priceCurrency: async () => o.priceCurrency ?? null,
      grantBadge: async (db, id) => {
        await db.query("SELECT 1");
        if (o.holdMs) await new Promise((res) => setTimeout(res, o.holdMs)); // keep the transaction open: a real interleave
        if (badgeFailures-- > 0) throw new Error("connection terminated unexpectedly");
        badges.push(id);
      },
      announce: async (a) => {
        if (announceCrashes-- > 0) throw new Error("process died before the announce");
        announced.push({ recipients: a.recipients, sessionId: a.sessionId, amountCents: a.amountCents, giftKind: a.giftKind });
        currencies.push(a.currency);
        slots.push(a.slots);
      },
      granted: () => {},
    });
    return { ...r, announced, badges, currencies, slots };
  };

  await t.test("a direct gift whose badge write fails once is announced exactly once on redelivery", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    const cs = session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient });
    const r = recorder({ badgeFailures: 1 });
    await assert.rejects(r.recordGift(cs), /connection terminated/, "the webhook answers 500 and Stripe redelivers");
    assert.equal((await grants(sessionId)).length, 0, "the grant rolled back with its badge");
    assert.equal(r.announced.length, 0);
    await r.recordGift(cs); // Stripe's redelivery
    assert.equal((await grants(sessionId)).length, 1);
    assert.deepEqual(r.badges, [recipient]);
    assert.deepEqual(r.announced, [{ recipients: [recipient], sessionId, amountCents: 1000, giftKind: "direct" }]);
  });

  await t.test("restart: the grant committed but the process died before the announce — the redelivery announces", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    const cs = session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient });
    const before = recorder({ announceCrashes: 1 });
    await assert.rejects(before.recordGift(cs));
    assert.equal((await grants(sessionId)).length, 1, "the grant is committed");
    const after = recorder(); // a new process
    await after.recordGift(cs);
    assert.deepEqual(after.announced.map((a) => a.recipients), [[recipient]], "the money reaches the bar after all");
    assert.deepEqual(after.badges, [], "nothing granted twice");
  });

  await t.test("retry: a redelivery after a good delivery grants nothing more and re-sends the same announce", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    const cs = session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient });
    const r = recorder();
    await r.recordGift(cs);
    const first = await grants(sessionId);
    await r.recordGift(cs);
    assert.deepEqual(await grants(sessionId), first, "the gift's end date did not move");
    assert.equal(r.badges.length, 1);
    // The same session id both times: stream-api's ledger dedups the second (no card, no credit).
    assert.deepEqual(r.announced.map((a) => a.sessionId), [sessionId, sessionId]);
    assert.deepEqual(r.announced[1], r.announced[0], "the redelivery never announces less (it never takes money back)");
  });

  await t.test("a community pick that errors throws instead of parking every slot", async () => {
    const { gifter, sessionId } = await fresh();
    const cs = session(sessionId, { gift_type: "community", gifter_matrix_id: gifter, count: "3" });
    // A pool whose clients fail the community pick, as a DB blip would.
    const blip = {
      connect: async () => {
        const c = await pool.connect();
        const query = c.query.bind(c) as PoolClient["query"];
        return Object.assign(c, {
          query: ((sql: unknown, ...rest: unknown[]) => {
            if (typeof sql === "string" && sql.includes("SELECT u.matrix_id FROM site.users u")) {
              return Promise.reject(new Error("canceling statement due to statement timeout"));
            }
            return (query as (...a: unknown[]) => unknown)(sql, ...rest);
          }) as PoolClient["query"],
        });
      },
      query: pool.query.bind(pool),
    } as unknown as Pool;
    const r = recorder({ pool: blip });
    await assert.rejects(r.recordGift(cs), /statement timeout/);
    const parked = (await pool.query(`SELECT count(*)::int AS n FROM site.gift_pending WHERE stripe_session_id = $1`, [sessionId])).rows[0].n;
    assert.equal(parked, 0, "no slot parked for strangers on an error");
    assert.equal(r.announced.length, 0);
  });

  // A1-05: the gift payload carried no currency, and stream-api reads an absent one as US dollars,
  // so a €50 gift moved the bar and the ledger by $50. The gift charges the Supporter price's
  // currency; the announce now says which, and stream-api refuses (and pages) a non-USD credit
  // like every other native money event.
  await t.test("a gift is announced in the currency it was charged in, never a literal dollar", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    const cs = { ...session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient }), currency: "eur" } as Stripe.Checkout.Session;
    const r = recorder();
    await r.recordGift(cs);
    assert.equal(r.currencies[0], "eur");
  });

  await t.test("a session without a currency falls back to the Supporter price's, the one source", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    const cs = { ...session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient }), currency: null } as unknown as Stripe.Checkout.Session;
    const r = recorder({ priceCurrency: "gbp" });
    await r.recordGift(cs);
    assert.equal(r.currencies[0], "gbp");
  });

  // W4 R1: a community gift with NO eligible user at purchase parks every slot. It used to announce
  // nothing (no recipients), so its money never reached the bar or the ledger. It is announced at
  // purchase with the slots it bought; stream-api credits it once (chat-event-parked-gift.db.test.js).
  await t.test("zero eligible users: every slot parked, one announce with the slots bought, the money credited", async () => {
    const { gifter, sessionId } = await fresh();
    const cs = session(sessionId, { gift_type: "community", gifter_matrix_id: gifter, count: "3" });
    // A pool whose community pick finds nobody eligible, as on a small new install.
    const nobody = {
      connect: async () => {
        const c = await pool.connect();
        const query = c.query.bind(c) as PoolClient["query"];
        return Object.assign(c, {
          query: ((sql: unknown, ...rest: unknown[]) => typeof sql === "string" && sql.includes("SELECT u.matrix_id FROM site.users u")
            ? Promise.resolve({ rows: [], rowCount: 0 })
            : (query as (...a: unknown[]) => unknown)(sql, ...rest)) as PoolClient["query"],
        });
      },
      query: pool.query.bind(pool),
    } as unknown as Pool;
    const r = recorder({ pool: nobody });
    await r.recordGift(cs);
    const parked = async () => (await pool.query(`SELECT count(*)::int AS n FROM site.gift_pending WHERE stripe_session_id = $1`, [sessionId])).rows[0].n;
    assert.equal(await parked(), 3, "every slot waits for the next sign-ups");
    assert.deepEqual(r.announced, [{ recipients: [], sessionId, amountCents: 1000, giftKind: "community" }]);
    assert.deepEqual(r.slots, [3], "announced by the subs bought");
    assert.equal(giftAnnounced({ giftKind: "community", recipients: [] }), true, "announceGift sends it");
    assert.equal(giftAnnounced({ giftKind: "direct", recipients: [] }), false);
    await r.recordGift(cs); // a redelivery: nothing parked twice, the same announce (deduped downstream)
    assert.equal(await parked(), 3);
    assert.deepEqual(r.announced[1], r.announced[0]);
    // The claim test below takes the OLDEST open slot in the table: leave none of these behind.
    await pool.query(`DELETE FROM site.gift_pending WHERE stripe_session_id = $1`, [sessionId]);
  });

  // A1-09 / P10 (k 2026-10-25): a refunded or disputed gift ends its entitlement at once.
  const activeOf = async (sessionId: string) => (await pool.query(
    `SELECT count(*)::int AS n FROM site.gift_subscriptions WHERE stripe_session_id = $1 AND expires_at > now()`, [sessionId])).rows[0].n;
  // The purchase's own price and slot count come from its Checkout session (the reversal path reads it).
  const reversal = (sessionId: string, ref: string, amount: number | null, gross = 1000, slots = gross === 1500 ? 3 : 1, reason: "refund" | "dispute" = "refund") =>
    ({ sessionId, ref, reason, amount, gross, slots });

  await t.test("a refunded direct gift stops entitling at once; retry and restart change nothing more", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    const cs = session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient });
    const r = recorder();
    await r.recordGift(cs);
    assert.equal(await activeOf(sessionId), 1);
    assert.deepEqual(await r.endGift(reversal(sessionId, `ref_${sessionId}_1`, 300)), [recipient], "a direct gift ends on any refund, partial included");
    assert.equal(await activeOf(sessionId), 0, "the gift no longer entitles");
    assert.deepEqual(await r.endGift(reversal(sessionId, `ref_${sessionId}_1`, 300)), [], "retry: a redelivered refund ends nothing more");
    assert.deepEqual(await recorder().endGift(reversal(sessionId, `ref_${sessionId}_1`, 300)), [], "restart: a new process neither");
    // A redelivered checkout.session.completed never grants it back.
    await r.recordGift(cs);
    assert.equal(await activeOf(sessionId), 0, "a redelivery of the purchase does not revive a refunded gift");
  });

  // Review R4: a PARTIAL refund of a community gift ended every recipient's gift. It now ends what the
  // amount covers: unclaimed slots first, then granted gifts (the newest first) only as far as the
  // refund pays for them; money that covers no whole slot is recorded for the operator (the Doctor).
  // A full refund ends everything. (A direct gift ends on any refund — the test above.)
  const claimableOf = async (sessionId: string) => (await pool.query(
    `SELECT count(*)::int AS n FROM site.gift_pending WHERE stripe_session_id = $1 AND claimed_by IS NULL AND reversed_by IS NULL`, [sessionId])).rows[0].n;
  /** A community gift of 3 slots at 500 each (1500): one already granted, two still unclaimed. */
  const community3 = async () => {
    const { gifter, recipient, sessionId } = await fresh();
    await pool.query(
      `INSERT INTO site.gift_subscriptions (stripe_session_id, gifter_matrix_id, recipient_matrix_id, tier, months, kind, anonymous, starts_at, expires_at)
       VALUES ($1, $2, $3, 'supporter', 1, 'community', false, now(), now() + interval '1 month')`, [sessionId, gifter, recipient]);
    await pool.query(
      `INSERT INTO site.gift_pending (stripe_session_id, gifter_matrix_id, months, anonymous, claim_expires_at)
       SELECT $1, $2, 1, false, now() + interval '90 days' FROM generate_series(1, 2)`, [sessionId, gifter]);
    return { recipient, sessionId };
  };
  // The claim test below takes the OLDEST open slot in the table: these leave none behind.
  const dropPending = (...sessions: string[]) => pool.query(`DELETE FROM site.gift_pending WHERE stripe_session_id = ANY($1::text[])`, [sessions]);
  const remainderOf = async (ref: string) => (await pool.query(`SELECT remainder_cents FROM site.gift_reversals WHERE ref = $1`, [ref])).rows[0]?.remainder_cents;

  await t.test("a partial refund of a community gift withdraws unclaimed slots first, and leaves the granted gift", async () => {
    const { sessionId } = await community3();
    const r = recorder();
    assert.deepEqual(await r.endGift(reversal(sessionId, `ref_${sessionId}_a`, 500, 1500)), [], "one slot's worth: no granted gift ends");
    assert.equal(await claimableOf(sessionId), 1, "one unclaimed slot withdrawn");
    assert.equal(await activeOf(sessionId), 1, "the recipient keeps their gift");
    assert.equal(await remainderOf(`ref_${sessionId}_a`), 0);
    await dropPending(sessionId);
  });

  await t.test("money that covers no whole slot is recorded for the operator", async () => {
    const { sessionId } = await community3();
    await recorder().endGift(reversal(sessionId, `ref_${sessionId}_b`, 700, 1500));
    assert.equal(await claimableOf(sessionId), 1);
    assert.equal(await activeOf(sessionId), 1);
    assert.equal(await remainderOf(`ref_${sessionId}_b`), 200, "the 200 that paid for part of a slot");
    await dropPending(sessionId);
  });

  await t.test("granted gifts end only when the refund covers them; two partial refunds add up; a full refund ends all", async () => {
    const a = await community3();
    const r = recorder();
    await r.endGift(reversal(a.sessionId, `ref_${a.sessionId}_1`, 500, 1500));
    assert.deepEqual(await r.endGift(reversal(a.sessionId, `ref_${a.sessionId}_2`, 1000, 1500)), [a.recipient],
      "the second refund pays for the last unclaimed slot and the granted gift");
    assert.equal(await claimableOf(a.sessionId), 0);
    assert.equal(await activeOf(a.sessionId), 0);
    const b = await community3();
    assert.deepEqual(await r.endGift(reversal(b.sessionId, `ref_${b.sessionId}_full`, null, 1500)), [b.recipient], "the whole payment: everything ends");
    assert.equal(await claimableOf(b.sessionId), 0);
    // And restoring the partial refund gives back exactly what it withdrew.
    const c = await community3();
    await r.endGift(reversal(c.sessionId, `ref_${c.sessionId}_p`, 500, 1500));
    await r.restoreGift(`ref_${c.sessionId}_p`);
    assert.equal(await claimableOf(c.sessionId), 2, "the withdrawn slot is claimable again");
    await dropPending(a.sessionId, b.sessionId, c.sessionId);
  });

  // Push review (round 3): reversal accounting is CUMULATIVE per session, against the purchase's own
  // price and slot count; only live unclaimed slots can be withdrawn; a restore re-derives the session
  // from the reversals that remain (no fail-open across overlapping reversals).
  await t.test("two partial refunds that together exceed the purchase end everything", async () => {
    const { recipient, sessionId } = await community3();
    const r = recorder();
    assert.deepEqual(await r.endGift(reversal(sessionId, `ref_${sessionId}_x1`, 1000, 1500)), [], "two slots' worth: both unclaimed slots go first");
    assert.equal(await claimableOf(sessionId), 0);
    assert.equal(await activeOf(sessionId), 1);
    assert.deepEqual(await r.endGift(reversal(sessionId, `ref_${sessionId}_x2`, 700, 1500)), [recipient], "1000 + 700 ≥ 1500: the whole purchase");
    assert.equal(await activeOf(sessionId), 0);
    const left = (await pool.query(`SELECT coalesce(sum(remainder_cents), 0)::int AS n FROM site.gift_reversals WHERE stripe_session_id = $1`, [sessionId])).rows[0].n;
    assert.equal(left, 0, "a whole purchase leaves no remainder for the operator");
    await dropPending(sessionId);
  });

  await t.test("restoring one of two overlapping reversals restores nothing; restoring both restores all", async () => {
    const { recipient, sessionId } = await community3();
    const r = recorder();
    await r.endGift(reversal(sessionId, `ref_${sessionId}_full`, null, 1500));
    await r.endGift(reversal(sessionId, `ref_${sessionId}_dp`, 1500, 1500, 3, "dispute"));
    assert.deepEqual(await r.restoreGift(`ref_${sessionId}_dp`), [], "the refund still covers the whole purchase");
    assert.equal(await activeOf(sessionId), 0);
    assert.equal(await claimableOf(sessionId), 0);
    assert.deepEqual(await r.restoreGift(`ref_${sessionId}_full`), [recipient], "nothing covers it any more");
    assert.equal(await activeOf(sessionId), 1);
    assert.equal(await claimableOf(sessionId), 2);
    await dropPending(sessionId);
  });

  // Push review (round 3, MEDIUM): a gift still ended after its reversal was restored moves to an
  // OLDER standing reversal; its later restore credited it from that older reversal's date, so it
  // came back with days it never lost. Each row now carries when IT was ended.
  await t.test("a gift moved to an older reversal comes back with only the time it was actually ended", async () => {
    const { gifter, sessionId } = await fresh();
    const g1 = `@${RUN}-q1-${sessionId}:site.test`, g2 = `@${RUN}-q2-${sessionId}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1), ($2)`, [g1, g2]);
    await pool.query(
      `INSERT INTO site.gift_subscriptions (stripe_session_id, gifter_matrix_id, recipient_matrix_id, tier, months, kind, anonymous, starts_at, expires_at)
       VALUES ($1, $2, $3, 'supporter', 1, 'community', false, now(), now() + interval '1 month'),
              ($1, $2, $4, 'supporter', 1, 'community', false, now(), now() + interval '1 month')`, [sessionId, gifter, g1, g2]);
    await pool.query(
      `INSERT INTO site.gift_pending (stripe_session_id, gifter_matrix_id, months, anonymous, claim_expires_at)
       VALUES ($1, $2, 1, false, now() + interval '90 days')`, [sessionId, gifter]);
    const r = recorder();
    const A = `ref_${sessionId}_old`, B = `ref_${sessionId}_new`;
    await r.endGift(reversal(sessionId, A, 1000, 1500));               // the slot and g2
    await pool.query(`UPDATE site.gift_reversals SET created_at = now() - interval '10 days' WHERE ref = $1`, [A]);
    const before = (await pool.query<{ expires_at: Date }>(`SELECT expires_at FROM site.gift_subscriptions WHERE recipient_matrix_id = $1`, [g1])).rows[0]!.expires_at;
    await r.endGift(reversal(sessionId, B, 1000, 1500));               // 2000 ≥ 1500: g1 too, today
    await r.restoreGift(B);                                            // A stands: two items stay ended; g1 moves to A
    await r.restoreGift(A);                                            // nothing stands: g1 comes back
    const after = (await pool.query<{ expires_at: Date }>(`SELECT expires_at FROM site.gift_subscriptions WHERE recipient_matrix_id = $1`, [g1])).rows[0]!.expires_at;
    const shift = new Date(after).getTime() - new Date(before).getTime();
    assert.ok(Math.abs(shift) < 120_000, `g1 was ended moments ago, so it comes back as it was (shifted ${Math.round(shift / 86_400_000)} days)`);
    await dropPending(sessionId);
  });

  await t.test("an expired unclaimed slot is never counted as covered", async () => {
    const { recipient, sessionId } = await community3();
    await pool.query(`UPDATE site.gift_pending SET claim_expires_at = now() - interval '1 day' WHERE id = (SELECT min(id) FROM site.gift_pending WHERE stripe_session_id = $1)`, [sessionId]);
    assert.deepEqual(await recorder().endGift(reversal(sessionId, `ref_${sessionId}_e`, 1000, 1500)), [recipient],
      "two slots' worth: the one live slot, then the granted gift — not the expired slot");
    const expired = (await pool.query(`SELECT reversed_by FROM site.gift_pending WHERE stripe_session_id = $1 AND claim_expires_at <= now()`, [sessionId])).rows[0];
    assert.equal(expired.reversed_by, null);
    await dropPending(sessionId);
  });

  // Review R3: a failed refund, a won dispute or a harmlessly closed inquiry gives the money back,
  // and now the gift with it — the time it had left when it was ended.
  await t.test("a restored reversal gives the gift back, with the time it had left; restore is idempotent", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    const r = recorder();
    await r.recordGift(session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient }));
    const before = (await pool.query<{ expires_at: Date }>(`SELECT expires_at FROM site.gift_subscriptions WHERE stripe_session_id = $1`, [sessionId])).rows[0]!.expires_at;
    const ref = `ref_${sessionId}_dispute`;
    await r.endGift({ sessionId, ref, reason: "dispute", amount: 1000, gross: 1000, slots: 1 });
    assert.equal(await activeOf(sessionId), 0);
    // The dispute sits open for two days, then is won.
    await pool.query(`UPDATE site.gift_reversals SET created_at = now() - interval '2 days' WHERE ref = $1`, [ref]);
    // It had begun before the dispute (a gift running for a day when it was disputed).
    const began = (await pool.query<{ starts_at: Date }>(
      `UPDATE site.gift_subscriptions SET reversed_at = now() - interval '2 days', starts_at = now() - interval '3 days' WHERE reversed_by = $1 RETURNING starts_at`, [ref])).rows[0]!.starts_at;
    assert.deepEqual(await r.restoreGift(ref), [recipient]);
    assert.equal(await activeOf(sessionId), 1, "the gift entitles again");
    const after = (await pool.query<{ expires_at: Date; starts_at: Date; reversed_by: string | null }>(`SELECT expires_at, starts_at, reversed_by FROM site.gift_subscriptions WHERE stripe_session_id = $1`, [sessionId])).rows[0]!;
    assert.equal(new Date(after.starts_at).getTime(), new Date(began).getTime(), "a gift that had begun keeps the day it began");
    const shift = new Date(after.expires_at).getTime() - new Date(before).getTime();
    assert.ok(Math.abs(shift - 2 * 86_400_000) < 120_000, `it keeps the time it had left: moved by the two days it was ended (${shift} ms)`);
    assert.equal(after.reversed_by, null);
    assert.deepEqual(await r.restoreGift(ref), [], "retry: restoring twice gives nothing twice");
    assert.deepEqual(await recorder().restoreGift(ref), [], "restart: neither does a new process");
  });

  // migrate-v172: the start is stored. A gift ended before it began (it sat behind another gift) comes
  // back as it was, just later: its start moves with its end, so it still runs its whole months.
  await t.test("a restored gift that had not begun yet comes back with its start moved by the time it was ended", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    const r = recorder();
    await r.recordGift(session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient }));
    const second = `${sessionId}_2`;
    await r.recordGift(session(second, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient }));
    const row = async () => (await pool.query<{ starts_at: Date; expires_at: Date }>(
      `SELECT starts_at, expires_at FROM site.gift_subscriptions WHERE stripe_session_id = $1`, [second])).rows[0]!;
    const first = (await pool.query<{ expires_at: Date }>(`SELECT expires_at FROM site.gift_subscriptions WHERE stripe_session_id = $1`, [sessionId])).rows[0]!;
    const before = await row();
    assert.equal(new Date(before.starts_at).getTime(), new Date(first.expires_at).getTime(), "stacked: it starts when the first gift ends");
    const ref = `ref_${second}_dispute`;
    await r.endGift({ sessionId: second, ref, reason: "dispute", amount: 1000, gross: 1000, slots: 1 });
    await pool.query(`UPDATE site.gift_subscriptions SET reversed_at = now() - interval '2 days' WHERE reversed_by = $1`, [ref]);
    assert.deepEqual(await r.restoreGift(ref), [recipient]);
    const after = await row();
    const moved = new Date(after.starts_at).getTime() - new Date(before.starts_at).getTime();
    const stretched = new Date(after.expires_at).getTime() - new Date(before.expires_at).getTime();
    assert.ok(Math.abs(moved - 2 * 86_400_000) < 120_000, `the start moved by the two days it was ended (${moved} ms)`);
    assert.equal(moved, stretched, "start and end moved together: it still runs its whole month");
    assert.deepEqual(await r.restoreGift(ref), [], "retry: restoring twice moves nothing twice");
    assert.deepEqual(await row(), after);
  });

  // Reviewer gate (round 4, blocker): a refund or dispute that lands BEFORE the grant (the purchase's
  // first delivery failed and Stripe redelivers it days later) recorded a reversal that ended nothing,
  // and the redelivered grant then gave the recipient Supporter in full for a refunded payment, with
  // fresh claimable slots. A reversal that arrives before its grant is HELD and applied in the same
  // transaction that writes the grant (money.md).
  const pickReturns = (rows: { matrix_id: string }[] | Error) => ({
    connect: async () => {
      const c = await pool.connect();
      const query = c.query.bind(c) as PoolClient["query"];
      return Object.assign(c, {
        query: ((sql: unknown, ...rest: unknown[]) => typeof sql === "string" && sql.includes("SELECT u.matrix_id FROM site.users u")
          ? (rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows, rowCount: rows.length }))
          : (query as (...a: unknown[]) => unknown)(sql, ...rest)) as PoolClient["query"],
      });
    },
    query: pool.query.bind(pool),
  }) as unknown as Pool;

  await t.test("reversal, then first grant: a direct gift refunded before it was granted never entitles", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    const r = recorder();
    await r.endGift(reversal(sessionId, `ref_${sessionId}_early`, 1000, 1000)); // nothing granted yet: held
    await r.recordGift(session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient }));
    assert.equal(await activeOf(sessionId), 0, "the held refund ends the gift in the transaction that writes it");
    assert.deepEqual(r.badges, [], "no Supporter badge for a refunded gift");
    // retry/restart: the purchase redelivered again changes nothing.
    await recorder().recordGift(session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient }));
    assert.equal(await activeOf(sessionId), 0);
  });

  await t.test("reversal, then redelivered grant: a community gift's slots made after its refund are never claimable", async () => {
    const { gifter, sessionId } = await fresh();
    const cs = session(sessionId, { gift_type: "community", gifter_matrix_id: gifter, count: "3" });
    await assert.rejects(recorder({ pool: pickReturns(new Error("canceling statement due to statement timeout")) }).recordGift(cs)); // first delivery fails
    const r = recorder({ pool: pickReturns([]) });
    await r.endGift({ ...reversal(sessionId, `ref_${sessionId}_early`, null, 1500), slots: 3 });
    await r.recordGift(cs); // Stripe's redelivery: nobody eligible, so every slot is parked…
    assert.equal(await claimableOf(sessionId), 0, "…and every parked slot is withdrawn by the held refund");
    await dropPending(sessionId);
  });

  await t.test("a direct gift's grant and its refund arriving together end it, whichever runs first", async () => {
    for (let i = 0; i < 3; i++) {
      const { gifter, recipient, sessionId } = await fresh();
      const r = recorder();
      await Promise.all([
        r.recordGift(session(sessionId, { gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: recipient })),
        r.endGift(reversal(sessionId, `ref_${sessionId}_race`, 1000, 1000)),
      ]);
      assert.equal(await activeOf(sessionId), 0, `run ${i}: the refunded gift entitles nobody`);
    }
  });

  // Round 5: claimPendingGift took only the new member's lock, so a refund of the same purchase could
  // interleave with the claim and leave a claimed slot the refund covered. The claim now takes the
  // purchase's lock first (the order recordGift and lockSession use) and claims only a slot still
  // unwithdrawn under it.
  await t.test("a refund racing a new member's claim on the same purchase never leaves a claimed slot the refund covered", async () => {
    // Two slots at 500 (1000). Whole and one-slot refunds, each started before and after the claim, with
    // the claim's transaction held open so the two really overlap.
    for (const [i, amount, refundFirst] of [[0, null, false], [1, null, true], [2, 500, false], [3, 500, true], [4, null, false], [5, 500, true]] as const) {
      const { gifter, recipient: member, sessionId } = await fresh();
      await pool.query(
        `INSERT INTO site.gift_pending (stripe_session_id, gifter_matrix_id, months, anonymous, claim_expires_at)
         SELECT $1, $2, 1, false, now() + interval '90 days' FROM generate_series(1, 2)`, [sessionId, gifter]);
      const claimer = recorder({ holdMs: 150 });
      const refund = () => recorder().endGift({ ...reversal(sessionId, `ref_${sessionId}_claimrace`, amount, 1000), slots: 2 });
      const claim = () => claimer.claimPendingGift(member);
      await Promise.all(refundFirst ? [refund(), new Promise((res) => setTimeout(res, 20)).then(claim)] : [claim(), new Promise((res) => setTimeout(res, 20)).then(refund)]);
      const covered = amount === null ? 2 : 1;
      const live = (await activeOf(sessionId)) + (await claimableOf(sessionId));
      assert.ok(live <= 2 - covered, `run ${i}: ${live} live slot(s) or gifts for a purchase the refund covered ${covered} of 2`);
      await dropPending(sessionId);
    }
  });

  // Round 6 (re-gate should-fix, a round-5 regression): every simultaneous sign-up read the same
  // "oldest free slot", one won, the rest retried at most five times — with six or more at once (a
  // raid) the later ones got nothing, and the sign-up claims only once, at account creation.
  await t.test("eight concurrent first sign-ups against a ten-slot community gift all get a slot, each a different one", async () => {
    const { gifter, sessionId } = await fresh();
    await pool.query(
      `INSERT INTO site.gift_pending (stripe_session_id, gifter_matrix_id, months, anonymous, claim_expires_at)
       SELECT $1, $2, 1, false, now() + interval '90 days' FROM generate_series(1, 10)`, [sessionId, gifter]);
    const members = Array.from({ length: 8 }, (_, k) => `@${RUN}-raid${k}-${sessionId}:site.test`);
    await pool.query(`INSERT INTO site.users (matrix_id) SELECT unnest($1::text[])`, [members]);
    const r = recorder();
    await Promise.all(members.map((m) => r.claimPendingGift(m)));
    const claimed = (await pool.query<{ claimed_by: string }>(
      `SELECT claimed_by FROM site.gift_pending WHERE stripe_session_id = $1 AND claimed_by IS NOT NULL`, [sessionId])).rows.map((x) => x.claimed_by);
    assert.equal(claimed.length, 8, "every one of the eight got a slot");
    assert.deepEqual([...new Set(claimed)].sort(), [...members].sort(), "each a different one");
    assert.equal(await activeOf(sessionId), 8);
    assert.equal(await claimableOf(sessionId), 2);
    await dropPending(sessionId);
  });

  await t.test("a pending slot claimed at sign-up lands with its badge, or not at all", async () => {
    const { gifter, recipient, sessionId } = await fresh();
    await pool.query(
      `INSERT INTO site.gift_pending (stripe_session_id, gifter_matrix_id, months, anonymous, claim_expires_at)
       VALUES ($1, $2, 1, false, now() + interval '90 days')`, [sessionId, gifter]);
    const failing = recorder({ badgeFailures: 1 });
    await assert.rejects(failing.claimPendingGift(recipient));
    assert.equal((await grants(sessionId)).length, 0);
    const claimed = (await pool.query(`SELECT claimed_by FROM site.gift_pending WHERE stripe_session_id = $1`, [sessionId])).rows[0];
    assert.equal(claimed.claimed_by, null, "the slot stays claimable");
    const ok = recorder();
    await ok.claimPendingGift(recipient);
    assert.deepEqual((await grants(sessionId)).map((g) => g.recipient_matrix_id), [recipient]);
    assert.deepEqual(ok.badges, [recipient]);
  });
});
