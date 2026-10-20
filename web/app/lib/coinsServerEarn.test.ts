import { test } from "node:test";
import assert from "node:assert/strict";
import { createEarn } from "./coinsServer.ts";
import { DEFAULT_EARN_RULES, type EarnRules } from "./earnRules.ts";

// The product's default rules (the `currency.earn.*` settings) under short local names.
const EARN = DEFAULT_EARN_RULES;
const MESSAGE_COOLDOWN_MS = EARN.messageCooldownMs;
const WATCH_POINTS_CAP = EARN.watchCap;
const CLOCK_MULTIPLIER = EARN.clockMultiplier;
/** What every createEarn below reads through its `rules` dep — withRates swaps it. */
let RULES: EarnRules = DEFAULT_EARN_RULES;

const STREAM = 1_785_914_794;
const T0 = 1_700_000_000_000;

type Row = Record<string, unknown>;

/** Fake pool answering by SQL pattern rather than call order, so a test does
 *  not break when an unrelated statement is added — the shape storePricingServer.test.ts shares. */
function fakePool(
  handlers: Array<[RegExp, (p: unknown[]) => { rows: Row[]; rowCount: number }]>,
  onConnect?: () => void
) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    seen,
    pool: { connect: async () => { onConnect?.(); return client; }, query: client.query } as never,
  };
}

/** The locked per-stream state row, as `pg` would return it. */
function stateRow(over: Row = {}) {
  return {
    watch_points: 0, watch_seconds: 0, first_awarded: false,
    last_award_at: null, last_beat: null, votes_awarded: 0, is_bot: false,
    ...over,
  };
}

const LOCK = /FROM site\.coin_earn_stream[\s\S]*FOR UPDATE/;
const CREDIT = /INSERT INTO site\.coin_ledger/;
const WALLET = /INSERT INTO site\.coin_wallets/;

function earnWith(
  rows: Row[] | null,
  opts: { streamId?: number | null; nowMs?: number; clockActive?: (matrixId: string) => Promise<boolean> } = {}
) {
  const { pool, seen } = fakePool([
    [LOCK, () => ({ rows: rows ?? [], rowCount: rows ? rows.length : 0 })],
    [CREDIT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [WALLET, () => ({ rows: [{ balance: "100" }], rowCount: 1 })],
  ]);
  const earn = createEarn({ rules: () => RULES,
    pool,
    currentStreamId: async () => (opts.streamId === undefined ? STREAM : opts.streamId),
    nowMs: () => opts.nowMs ?? T0,
    clockActive: opts.clockActive ?? (async () => false),
  });
  return { earn, seen };
}

// ── The gate: no stream, no award ───────────────────────────────────────────

test("nothing is awarded when no stream is live, and nothing is written", async () => {
  // Earning is live-gated. Awarding off-stream would let anyone collect the
  // first-message bonus at 4am, forever.
  for (const call of ["earnMessage", "earnVoteCast"] as const) {
    const { earn, seen } = earnWith([stateRow()], { streamId: null });
    const result = call === "earnMessage"
      ? await earn.earnMessage("@a:x")
      : await earn.earnVoteCast("@a:x", "site", 99);
    assert.deepEqual(result, { awarded: 0 });
    assert.equal(seen.length, 0, `${call} must not open a transaction with no stream`);
  }
  const { earn, seen } = earnWith([stateRow()], { streamId: null });
  assert.deepEqual(await earn.earnUpvoteReceived("@a:x", "@b:x", "site", 99), { awarded: 0 });
  assert.equal(seen.length, 0);
});

test("a bot earns nothing on any path", async () => {
  // A helper bot's messages collect upvotes like anyone's; unguarded, every one would mint coins.
  const bot = [stateRow({ is_bot: true })];
  assert.deepEqual(await earnWith(bot).earn.earnMessage("@helperbot:site.test"), { awarded: 0 });
  assert.deepEqual(await earnWith(bot).earn.earnVoteCast("@helperbot:site.test", "site", 99), { awarded: 0 });
  assert.deepEqual(
    await earnWith(bot).earn.earnUpvoteReceived("@helperbot:site.test", "@b:x", "site", 99), { awarded: 0 });

  const { earn, seen } = earnWith(bot);
  await earn.earnMessage("@helperbot:site.test");
  assert.equal(seen.filter((q) => CREDIT.test(q.sql)).length, 0, "a bot must reach no ledger row");
});

test("a user with no state row (deleted mid-flight) is skipped, not crashed", async () => {
  const { earn } = earnWith([]);
  assert.deepEqual(await earn.earnMessage("@ghost:x"), { awarded: 0 });
});

// ── Messages ────────────────────────────────────────────────────────────────

test("the first message of a stream pays 6 and marks the stream", async () => {
  const { earn, seen } = earnWith([stateRow()]);
  assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: EARN.firstMessage + EARN.message });
  const upd = seen.find((q) => /UPDATE site\.coin_earn_stream/.test(q.sql));
  assert.ok(upd, "the state must be written back");
  assert.match(upd.sql, /first_awarded = TRUE/);
});

test("a second message inside the cooldown pays nothing and writes no ledger row", async () => {
  const recent = new Date(T0 - 1_000).toISOString();
  const { earn, seen } = earnWith([stateRow({ first_awarded: true, last_award_at: recent })]);
  assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: 0 });
  assert.equal(seen.filter((q) => CREDIT.test(q.sql)).length, 0);
});

test("a message after the cooldown pays 1", async () => {
  const old = new Date(T0 - MESSAGE_COOLDOWN_MS).toISOString();
  const { earn } = earnWith([stateRow({ first_awarded: true, last_award_at: old })]);
  assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: EARN.message });
});

test("last_award_at is a Date from a real pool and a string from this fake — both work", async () => {
  // `pg` returns timestamptz as a Date; the fake returns an ISO string. The
  // production path must accept both or the cooldown silently never applies.
  const old = new Date(T0 - MESSAGE_COOLDOWN_MS - 1);
  for (const value of [old, old.toISOString()]) {
    const { earn } = earnWith([stateRow({ first_awarded: true, last_award_at: value })]);
    assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: EARN.message });
  }
  const recent = new Date(T0 - 1);
  for (const value of [recent, recent.toISOString()]) {
    const { earn } = earnWith([stateRow({ first_awarded: true, last_award_at: value })]);
    assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: 0 });
  }
});

// ── Votes ───────────────────────────────────────────────────────────────────

test("a vote pays 1 until the per-stream cap, then nothing", async () => {
  assert.deepEqual(await earnWith([stateRow({ votes_awarded: 0 })]).earn.earnVoteCast("@a:x", "site", 99),
    { awarded: EARN.voteCast });
  assert.deepEqual(await earnWith([stateRow({ votes_awarded: 24 })]).earn.earnVoteCast("@a:x", "site", 99),
    { awarded: EARN.voteCast });
  assert.deepEqual(await earnWith([stateRow({ votes_awarded: 25 })]).earn.earnVoteCast("@a:x", "site", 99),
    { awarded: 0 });
});

// ── Upvotes received ────────────────────────────────────────────────────────

test("an upvote pays the recipient until that voter has paid 5 times this stream", async () => {
  function upvoteEarn(paid: number) {
    const { pool, seen } = fakePool([
      [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
      [/FROM site\.coin_earn_upvotes/, () => ({ rows: [{ paid: String(paid) }], rowCount: 1 })],
      [CREDIT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
      [WALLET, () => ({ rows: [{ balance: "100" }], rowCount: 1 })],
    ]);
    return {
      earn: createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => false }),
      seen,
    };
  }
  assert.deepEqual(await upvoteEarn(0).earn.earnUpvoteReceived("@a:x", "@b:x", "site", 99),
    { awarded: EARN.upvoteReceived });
  assert.deepEqual(await upvoteEarn(4).earn.earnUpvoteReceived("@a:x", "@b:x", "site", 99),
    { awarded: EARN.upvoteReceived });
  assert.deepEqual(await upvoteEarn(5).earn.earnUpvoteReceived("@a:x", "@b:x", "site", 99),
    { awarded: 0 });
});

test("upvoting yourself pays nothing", async () => {
  // seen.length === 0 only proves no POOL QUERY happened — it would still
  // pass if the guard ran AFTER a clockActive resolution. The guard must run
  // FIRST, before any clock resolution too.
  let asked = false;
  const { earn, seen } = earnWith([stateRow()], { clockActive: async () => { asked = true; return true; } });
  assert.deepEqual(await earn.earnUpvoteReceived("@a:x", "@a:x", "site", 99), { awarded: 0 });
  assert.equal(seen.length, 0, "a self-vote must not even open a transaction");
  assert.equal(asked, false, "a self-vote must not even resolve the clock");
});

test("the per-voter counter is keyed on the VOTER, not just the recipient", async () => {
  // Keying on the recipient alone would mean five upvotes from anybody
  // exhausted the whole stream's earning — the opposite of the intent.
  const { pool, seen } = fakePool([
    [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
    [/FROM site\.coin_earn_upvotes/, () => ({ rows: [{ paid: "0" }], rowCount: 1 })],
    [CREDIT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [WALLET, () => ({ rows: [{ balance: "1" }], rowCount: 1 })],
  ]);
  await createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => false })
    .earnUpvoteReceived("@a:x", "@b:x", "site", 99);
  const q = seen.find((s) => /SELECT paid FROM site\.coin_earn_upvotes/.test(s.sql));
  assert.ok(q, "expected the per-pair lookup");
  assert.deepEqual(q.params, ["@a:x", "@b:x", STREAM]);
  // The params alone do not prove this: dropping `voter = $2` from the WHERE
  // leaves the params identical and the query wrong. Assert the predicate.
  assert.match(q.sql, /voter = \$2/,
    "keyed on the recipient alone, five upvotes from anybody would exhaust the stream");
  assert.match(q.sql, /FOR UPDATE/,
    "two upvotes from one voter must not both read the same `paid`");
});

test("the upvote ref names BOTH sides, or two voters collide", async () => {
  // With the voter missing from the ref, @b and @c each landing their first
  // upvote on @a produce the SAME ref — the second is swallowed as a replay
  // and @a silently loses the award.
  function refFor(voter: string) {
    const { pool, seen } = fakePool([
      [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
      [/SELECT paid FROM site\.coin_earn_upvotes/, () => ({ rows: [{ paid: "0" }], rowCount: 1 })],
      [CREDIT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
      [WALLET, () => ({ rows: [{ balance: "1" }], rowCount: 1 })],
    ]);
    return createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => false })
      .earnUpvoteReceived("@a:x", voter, "site", 99)
      .then(() => String(seen.find((q) => CREDIT.test(q.sql))?.params[3]));
  }
  const [fromB, fromC] = await Promise.all([refFor("@b:x"), refFor("@c:x")]);
  assert.notEqual(fromB, fromC, "two different voters produced the same ledger ref");
  assert.match(fromB, /@b:x/);
  assert.match(fromB, new RegExp(String(STREAM)), "the upvote ref must also be stream-scoped");
});

// ── Watch ───────────────────────────────────────────────────────────────────

/** A beat `secondsAgo` after the previous one. */
function beatState(secondsAgo: number, over: Row = {}) {
  return stateRow({ last_beat: new Date(T0 - secondsAgo * 1_000).toISOString(), ...over });
}

test("watch accrues seconds and pays whole coins, capped per stream", async () => {
  // 500 banked + a 60s beat = 560, still short of a coin.
  const { earn } = earnWith([beatState(60, { watch_seconds: 500 })]);
  assert.equal((await earn.recordWatchHeartbeat("@a:x")).awarded, 0);

  const { earn: e2 } = earnWith([beatState(60, { watch_seconds: 550 })]);
  assert.equal((await e2.recordWatchHeartbeat("@a:x")).awarded, 1);

  const { earn: e3 } = earnWith([beatState(60, { watch_points: WATCH_POINTS_CAP, watch_seconds: 5_000 })]);
  assert.equal((await e3.recordWatchHeartbeat("@a:x")).awarded, 0);
});

test("the first beat of a stream banks nothing", async () => {
  // last_beat is null: there is no interval yet, and crediting from null would
  // pay for time before the viewer arrived.
  const { earn, seen } = earnWith([stateRow({ last_beat: null, watch_seconds: 0 })]);
  assert.equal((await earn.recordWatchHeartbeat("@a:x")).awarded, 0);
  const upd = seen.find((q) => /UPDATE site\.coin_earn_stream/.test(q.sql));
  assert.deepEqual(upd?.params, ["@a:x", STREAM, 0, 0]);
});

test("a long gap between beats is clamped — an idle tab cannot bank hours", async () => {
  // Two tabs, a replayed request, or a laptop lid closed for a day must all
  // collapse to real elapsed time.
  const { earn } = earnWith([beatState(86_400, { watch_seconds: 0 })]);
  const r = await earn.recordWatchHeartbeat("@a:x");
  assert.equal(r.awarded, 0, "a one-day gap must bank at most the clamp, not a day");

  const { earn: e2 } = earnWith([beatState(86_400, { watch_seconds: 599 })]);
  assert.equal((await e2.recordWatchHeartbeat("@a:x")).awarded, 1, "clamped to 90s, not 86,400");
});

test("the client cannot supply the elapsed time", async () => {
  // The whole reason last_beat is a column. If this function ever grows a
  // caller-supplied delta again, this fails.
  assert.equal(createEarn.length, 1, "createEarn takes deps only");
  const { earn } = earnWith([beatState(60, { watch_seconds: 0 })]);
  assert.equal(earn.recordWatchHeartbeat.length, 1,
    "recordWatchHeartbeat must take ONLY a matrixId — the server owns the clock");
});

test("every beat stamps last_beat, or the next delta is measured from the wrong point", async () => {
  const { earn, seen } = earnWith([beatState(60, { watch_seconds: 0 })]);
  await earn.recordWatchHeartbeat("@a:x");
  const upd = seen.find((q) => /UPDATE site\.coin_earn_stream/.test(q.sql));
  assert.match(upd?.sql ?? "", /last_beat = NOW\(\)/);
});

// ── Transactions and locking ────────────────────────────────────────────────

test("every earn path locks its state row FOR UPDATE inside a transaction", async () => {
  for (const run of [
    (e: ReturnType<typeof createEarn>) => e.earnMessage("@a:x"),
    (e: ReturnType<typeof createEarn>) => e.earnVoteCast("@a:x", "site", 99),
  ]) {
    const { earn, seen } = earnWith([stateRow()]);
    await run(earn);
    const sql = seen.map((q) => q.sql.trim());
    assert.equal(sql[0], "BEGIN");
    assert.equal(sql[sql.length - 1], "COMMIT");
    assert.ok(sql.some((s) => LOCK.test(s)),
      "without FOR UPDATE two concurrent awards both pass the cooldown");
  }
});

test("a failure rolls back and never commits", async () => {
  const { pool, seen } = fakePool([
    [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
    [CREDIT, () => { throw new Error("ledger down"); }],
  ]);
  const earn = createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => false });
  await assert.rejects(() => earn.earnMessage("@a:x"), /ledger down/);
  assert.ok(seen.some((q) => q.sql.trim() === "ROLLBACK"));
  assert.ok(!seen.some((q) => q.sql.trim() === "COMMIT"));
});

test("every ledger ref is scoped to the stream", async () => {
  // A ref that omitted the stream would collide across streams and silently
  // replay — the second stream's award would be swallowed as a duplicate.
  const { earn, seen } = earnWith([stateRow()]);
  await earn.earnMessage("@a:x");
  const refs = seen.filter((q) => CREDIT.test(q.sql)).map((q) => String(q.params[3]));
  assert.ok(refs.length > 0, "expected ledger inserts");
  for (const ref of refs) {
    assert.match(ref, new RegExp(String(STREAM)), `ref ${ref} is not stream-scoped`);
  }
});


// ── The printer test ────────────────────────────────────────────────────────

test("vote → un-vote → vote pays ONCE: the ref is keyed to the message", async () => {
  // Clearing a vote deletes the row, so the next vote is a FRESH insert — the
  // route cannot tell the difference. What stops the printer is the ledger ref
  // naming the message: the second credit collides and replays.
  //
  // Without this, a viewer reaches the whole 25-vote cap by toggling one
  // message, and votes stop meaning participation.
  let seenRef: string | null = null;
  function voteOnce(votesAwarded: number) {
    const { pool, seen } = fakePool([
      [LOCK, () => ({ rows: [stateRow({ votes_awarded: votesAwarded })], rowCount: 1 })],
      // Second time around the ledger reports a replay: 0 rows inserted.
      [CREDIT, (p) => {
        const ref = String(p[3]);
        const replay = ref === seenRef;
        seenRef = ref;
        return { rows: replay ? [] : [{ id: 1 }], rowCount: replay ? 0 : 1 };
      }],
      [/SELECT balance FROM site\.coin_wallets/, () => ({ rows: [{ balance: "5" }], rowCount: 1 })],
      [WALLET, () => ({ rows: [{ balance: "5" }], rowCount: 1 })],
    ]);
    return {
      earn: createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => false }),
      seen,
    };
  }

  const first = voteOnce(0);
  assert.deepEqual(await first.earn.earnVoteCast("@a:x", "site", 77), { awarded: 1 });

  // Un-vote writes nothing here — the route simply does not call earn.
  // Then the same message is voted again:
  const again = voteOnce(1);
  assert.deepEqual(await again.earn.earnVoteCast("@a:x", "site", 77), { awarded: 0 },
    "re-voting the same message must pay nothing");
  assert.equal(
    again.seen.filter((q) => /UPDATE site\.coin_earn_stream/.test(q.sql)).length, 0,
    "a replayed credit must not advance votes_awarded either"
  );
});

test("a DIFFERENT message still pays — the cap bounds distinct messages", async () => {
  const refs: string[] = [];
  function voteOn(messageId: number) {
    const { pool } = fakePool([
      [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
      [CREDIT, (p) => { refs.push(String(p[3])); return { rows: [{ id: 1 }], rowCount: 1 }; }],
      [WALLET, () => ({ rows: [{ balance: "5" }], rowCount: 1 })],
    ]);
    return createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => false })
      .earnVoteCast("@a:x", "site", messageId);
  }
  assert.deepEqual(await voteOn(1), { awarded: 1 });
  assert.deepEqual(await voteOn(2), { awarded: 1 });
  assert.notEqual(refs[0], refs[1], "two messages must not share a vote ref");
});

test("re-upvoting one message never pays the author twice", async () => {
  let seenRef: string | null = null;
  function upvote(paid: number) {
    const { pool } = fakePool([
      [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
      [/SELECT paid FROM site\.coin_earn_upvotes/, () => ({ rows: [{ paid: String(paid) }], rowCount: 1 })],
      [CREDIT, (p) => {
        const ref = String(p[3]);
        const replay = ref === seenRef;
        seenRef = ref;
        return { rows: replay ? [] : [{ id: 1 }], rowCount: replay ? 0 : 1 };
      }],
      [/SELECT balance FROM site\.coin_wallets/, () => ({ rows: [{ balance: "5" }], rowCount: 1 })],
      [WALLET, () => ({ rows: [{ balance: "5" }], rowCount: 1 })],
    ]);
    return createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => false })
      .earnUpvoteReceived("@a:x", "@b:x", "site", 55);
  }
  assert.deepEqual(await upvote(0), { awarded: EARN.upvoteReceived });
  assert.deepEqual(await upvote(1), { awarded: 0 }, "the same message must not pay twice");
});

// ── Earn chips ──────────────────────────────────────────────────────────────
//
// The heartbeat reports what was credited since the previous beat, so the "+2q"
// chip has a channel. See earnChipsSince in coinsServer.ts for why the chat
// routes cannot carry this themselves.

const CHIPS = /SUM\(delta\)[\s\S]*FROM site\.coin_ledger/;

/** An earn with the chip SELECT answered. `chips` are rows as `pg` returns
 *  them — SUM() comes back as a STRING. */
function earnWithChips(state: Row[], chips: Array<{ kind: string; points: string }>) {
  const { pool, seen } = fakePool([
    [LOCK, () => ({ rows: state, rowCount: state.length })],
    [CHIPS, () => ({ rows: chips, rowCount: chips.length })],
    [CREDIT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [WALLET, () => ({ rows: [{ balance: "100" }], rowCount: 1 })],
  ]);
  const earn = createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => false });
  return { earn, seen };
}

test("the chip query is bounded by BOTH the cursor and the earn kinds", async () => {
  // A fake pool sees no query text unless you make it: dropping either
  // predicate leaves every param identical and every other test in this file
  // green, so the rule that lives in the SQL is asserted as SQL.
  //
  // Without the cursor, the first beat of every stream would replay the
  // viewer's ENTIRE earning history as chips. Without the kind filter, every
  // top-up and market payout would animate as "earned".
  const { earn, seen } = earnWithChips([beatState(60)], []);
  await earn.recordWatchHeartbeat("@a:x");
  const q = seen.find((s) => CHIPS.test(s.sql));
  assert.ok(q, "the heartbeat must ask for the chips");
  assert.match(q.sql, /created_at > \$2/, "must be bounded by the last-beat cursor");
  assert.match(q.sql, /kind = ANY\(\$3/, "must be bounded to the earn kinds");
  assert.equal(q.params[1], beatState(60).last_beat, "the cursor is the PREVIOUS last_beat");
});

test("the chips are read BEFORE the cursor advances", async () => {
  // The watch credit written by this very beat carries created_at = this
  // transaction's NOW(), which is > the previous last_beat but NOT > the new
  // one. Reported here or never — so the read must precede the UPDATE.
  const { earn, seen } = earnWithChips([beatState(60, { watch_seconds: 550 })], []);
  await earn.recordWatchHeartbeat("@a:x");
  const chipAt = seen.findIndex((s) => CHIPS.test(s.sql));
  const cursorAt = seen.findIndex((s) => /SET watch_points[\s\S]*last_beat = NOW\(\)/.test(s.sql));
  assert.ok(chipAt >= 0 && cursorAt >= 0, "premise: both statements run");
  assert.ok(chipAt < cursorAt, "the chip read must come before the cursor moves");
});

test("chips come back as NUMBERS, ordered, with empties dropped", async () => {
  // `pg` hands SUM() back as a string. "+" + "11" renders "+11q" only by luck
  // of template coercion; `points > 0` on a string is a different comparison
  // entirely, and a 0-sum row would slip through as a chip announcing nothing.
  const { earn } = earnWithChips([beatState(60)], [
    { kind: "earn_upvote", points: "4" },
    { kind: "earn_first", points: "5" },
    { kind: "earn_chat", points: "0" },
  ]);
  const { chips } = await earn.recordWatchHeartbeat("@a:x");
  assert.deepEqual(chips, [
    { kind: "earn_first", points: 5 },
    { kind: "earn_upvote", points: 4 },
  ], "numeric, EARN_KINDS order (first before upvote), and the 0 dropped");
});

test("the first beat of a stream reports NO chips", async () => {
  // last_beat is null, so there is no window. Reporting a lifetime of earning
  // as one burst is worse than reporting none — and it would fire on every
  // viewer at the top of every stream.
  const { earn, seen } = earnWithChips([stateRow({ last_beat: null })], [
    { kind: "earn_chat", points: "99" },
  ]);
  const { chips } = await earn.recordWatchHeartbeat("@a:x");
  assert.deepEqual(chips, []);
  assert.equal(seen.filter((s) => CHIPS.test(s.sql)).length, 0,
    "and it must not even ask — a null cursor has nothing to bound the scan");
});

test("an off-stream beat reports no chips rather than crashing the caller", async () => {
  const { earn } = earnWithChips([], []);
  const r = await earn.recordWatchHeartbeat("@a:x");
  assert.deepEqual(r.chips, [], "the no-stream fallback must carry the same shape");
});

// ── The clock perk ──────────────────────────────────────────────────────────

/** Every ledger INSERT this run made, as the wallet will see it. */
function ledgerRows(seen: Array<{ sql: string; params: unknown[] }>) {
  return seen.filter((q) => CREDIT.test(q.sql))
    .map((q) => ({ kind: q.params[2], delta: q.params[1], ref: q.params[3], meta: q.params[4] }));
}
const BONUS_META = (base: string) => JSON.stringify({ base, multiplier: CLOCK_MULTIPLIER });

test("a lit clock pays the first message AND the message point again — each as its OWN ref-keyed row", async () => {
  const { earn, seen } = earnWith([stateRow()], { clockActive: async () => true });
  assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: CLOCK_MULTIPLIER * (EARN.firstMessage + EARN.message) });
  const bucket = Math.floor(T0 / 600_000);
  assert.deepEqual(ledgerRows(seen), [
    { kind: "earn_first", delta: 5, ref: `first:@a:x:${STREAM}`, meta: null },
    { kind: "earn_bonus", delta: 5, ref: `bonus:first:@a:x:${STREAM}`, meta: BONUS_META("earn_first") },
    { kind: "earn_chat",  delta: 1, ref: `msg:@a:x:${STREAM}:${bucket}`, meta: null },
    { kind: "earn_bonus", delta: 1, ref: `bonus:msg:@a:x:${STREAM}:${bucket}`, meta: BONUS_META("earn_chat") },
  ]);
});

test("an unlit clock writes no bonus row and pays the base (every earlier test in this file runs unlit)", async () => {
  const { earn, seen } = earnWith([stateRow()], { clockActive: async () => false });
  assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: EARN.firstMessage + EARN.message });
  assert.deepEqual(ledgerRows(seen).map((r) => r.kind), ["earn_first", "earn_chat"]);
});

test("a vote pays the bonus on the VOTER's clock; an upvote on the RECIPIENT's — the one who earns", async () => {
  const asked: string[] = [];
  const { earn, seen } = earnWith([stateRow()], {
    clockActive: async (id) => { asked.push(id); return id === "@author:x"; },
  });
  assert.deepEqual(await earn.earnVoteCast("@voter:x", "native", 7), { awarded: EARN.voteCast });
  assert.deepEqual(await earn.earnUpvoteReceived("@author:x", "@voter:x", "native", 7),
    { awarded: CLOCK_MULTIPLIER * EARN.upvoteReceived });
  assert.deepEqual(asked, ["@voter:x", "@author:x"]);
  const rows = ledgerRows(seen);
  assert.deepEqual(rows.map((r) => r.kind), ["earn_vote", "earn_upvote", "earn_bonus"]);
  assert.deepEqual(rows[2], {
    kind: "earn_bonus", delta: 2,
    ref: `bonus:up:@author:x:@voter:x:${STREAM}:native:7`, meta: BONUS_META("earn_upvote"),
  });
});

test("a REPLAYED base award mints no bonus — a retry must not pay the perk twice", async () => {
  const { pool, seen } = fakePool([
    [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
    [CREDIT, () => ({ rows: [], rowCount: 0 })],                     // (kind, ref) already exists
    [/SELECT balance FROM site\.coin_wallets/, () => ({ rows: [{ balance: "100" }], rowCount: 1 })],
  ]);
  const earn = createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => true });
  await earn.earnMessage("@a:x");
  assert.deepEqual(ledgerRows(seen).map((r) => r.kind), ["earn_first", "earn_chat"],
    "a bonus row was attempted for a replayed base");
});

test("a REPLAYED vote mints no bonus, even lit — the guard must gate the bonus too", async () => {
  // The mutation this guards against: moving the bonus write ABOVE
  // `if (r.replay) return { awarded: 0 };` in earnVoteCast. A base ref can be
  // credited unlit (no bonus row), then retried later once the clock is lit —
  // the base insert replays, but a guard-less bonus insert would be genuinely
  // FRESH and would mint — the vote -> un-vote -> vote path earnVoteCast's
  // docblock describes.
  const { pool, seen } = fakePool([
    [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
    [CREDIT, () => ({ rows: [], rowCount: 0 })],                     // (kind, ref) already exists
    [/SELECT balance FROM site\.coin_wallets/, () => ({ rows: [{ balance: "100" }], rowCount: 1 })],
  ]);
  const earn = createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => true });
  assert.deepEqual(await earn.earnVoteCast("@a:x", "site", 99), { awarded: 0 });
  assert.deepEqual(ledgerRows(seen).map((r) => r.kind), ["earn_vote"],
    "a bonus row was attempted for a replayed vote");
});

test("a REPLAYED upvote mints no bonus, even lit — the guard must gate the bonus too", async () => {
  // Same mutation, on earnUpvoteReceived's replay guard.
  const { pool, seen } = fakePool([
    [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
    [/FROM site\.coin_earn_upvotes/, () => ({ rows: [{ paid: "0" }], rowCount: 1 })],
    [CREDIT, () => ({ rows: [], rowCount: 0 })],                     // (kind, ref) already exists
    [/SELECT balance FROM site\.coin_wallets/, () => ({ rows: [{ balance: "100" }], rowCount: 1 })],
  ]);
  const earn = createEarn({ rules: () => RULES, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => true });
  assert.deepEqual(await earn.earnUpvoteReceived("@a:x", "@b:x", "site", 99), { awarded: 0 });
  assert.deepEqual(ledgerRows(seen).map((r) => r.kind), ["earn_upvote"],
    "a bonus row was attempted for a replayed upvote");
});

test("watch never pays the bonus, and never even asks", async () => {
  let asked = false;
  const { earn, seen } = earnWith(
    [stateRow({ last_beat: new Date(T0 - 90_000).toISOString(), watch_seconds: 540 })],
    { clockActive: async () => { asked = true; return true; } },
  );
  const r = await earn.recordWatchHeartbeat("@a:x");
  assert.equal(r.awarded, 1, "premise: this beat pays a watch coin (540 + 90 s = 630 s)");
  assert.deepEqual(ledgerRows(seen).map((x) => x.kind), ["earn_watch"]);
  assert.equal(asked, false, "watch is excluded from the perk — it must not resolve the clock");
});

test("the clock is resolved BEFORE the transaction opens — never while the state row is locked", async () => {
  // Asserts 'connect' too, not just 'begin': a clock resolution slid between
  // pool.connect() and BEGIN would hold a pool connection for the length of
  // a 2s network call — the next-worst version of the failure this guards.
  const order: string[] = [];
  const { pool } = fakePool([
    [/^BEGIN$/, () => { order.push("begin"); return { rows: [], rowCount: 0 }; }],
    [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
    [CREDIT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [WALLET, () => ({ rows: [{ balance: "1" }], rowCount: 1 })],
  ], () => order.push("connect"));
  const earn = createEarn({ rules: () => RULES,
    pool, currentStreamId: async () => STREAM, nowMs: () => T0,
    clockActive: async () => { order.push("clock"); return true; },
  });
  await earn.earnMessage("@a:x");
  await earn.earnVoteCast("@a:x", "native", 1);
  await earn.earnUpvoteReceived("@b:x", "@a:x", "native", 1);
  assert.deepEqual(order, [
    "clock", "connect", "begin",
    "clock", "connect", "begin",
    "clock", "connect", "begin",
  ]);
});

test("a clockActive that THROWS still pays the base at 1x — the perk can never cost an earn", async () => {
  const origWarn = console.warn; console.warn = () => {};
  try {
    const { earn, seen } = earnWith([stateRow()], { clockActive: async () => { throw new Error("stream-api down"); } });
    assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: EARN.firstMessage + EARN.message });
    assert.deepEqual(ledgerRows(seen).map((r) => r.kind), ["earn_first", "earn_chat"]);
  } finally { console.warn = origWarn; }
});

// ── One source for the message rates ────────────────────────────────────────

/** Run `fn` with the message rates changed — through the `rules` dep, the same path the
 *  settings take in production. */
async function withRates(first: number, message: number, fn: () => Promise<void>) {
  RULES = { ...DEFAULT_EARN_RULES, firstMessage: first, message };
  try { await fn(); } finally { RULES = DEFAULT_EARN_RULES; }
}

test("the ledger credits what earnRules computes — change the rules and the rows follow", async () => {
  // The credited amounts and messageAward() must read the same rules; a
  // literal amount would let a rate change move the "+6q" chip and not the
  // wallet. 7 and 3 are values the default rates cannot produce.
  await withRates(7, 3, async () => {
    const { earn, seen } = earnWith([stateRow()], { clockActive: async () => true });
    assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: CLOCK_MULTIPLIER * (7 + 3) });
    const bucket = Math.floor(T0 / 600_000);
    // Refs and bonus rows match the default-rate case; only the amounts move.
    assert.deepEqual(ledgerRows(seen), [
      { kind: "earn_first", delta: 7, ref: `first:@a:x:${STREAM}`, meta: null },
      { kind: "earn_bonus", delta: 7 * (CLOCK_MULTIPLIER - 1), ref: `bonus:first:@a:x:${STREAM}`, meta: BONUS_META("earn_first") },
      { kind: "earn_chat",  delta: 3, ref: `msg:@a:x:${STREAM}:${bucket}`, meta: null },
      { kind: "earn_bonus", delta: 3 * (CLOCK_MULTIPLIER - 1), ref: `bonus:msg:@a:x:${STREAM}:${bucket}`, meta: BONUS_META("earn_chat") },
    ]);
  });
});

test("a later message credits the rules' message rate, not a literal", async () => {
  await withRates(7, 3, async () => {
    const old = new Date(T0 - MESSAGE_COOLDOWN_MS).toISOString();
    const { earn, seen } = earnWith([stateRow({ first_awarded: true, last_award_at: old })]);
    assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: 3 });
    assert.deepEqual(ledgerRows(seen).map((r) => [r.kind, r.delta]), [["earn_chat", 3]]);
  });
});

// ── The rules come from settings, read per award ────────────────────────────

test("an edit to the rules applies to the NEXT award — createEarn reads them every time", async () => {
  let reads = 0;
  let live: EarnRules = DEFAULT_EARN_RULES;
  const { pool } = fakePool([
    [LOCK, () => ({ rows: [stateRow()], rowCount: 1 })],
    [CREDIT, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [WALLET, () => ({ rows: [{ balance: "100" }], rowCount: 1 })],
  ]);
  const earn = createEarn({ rules: () => { reads++; return live; }, pool, currentStreamId: async () => STREAM, nowMs: () => T0, clockActive: async () => false });
  assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: 6 });
  live = { ...DEFAULT_EARN_RULES, firstMessage: 20 };
  assert.deepEqual(await earn.earnMessage("@a:x"), { awarded: 21 });
  assert.equal(reads, 2);
});

test("the message ref's bucket is one cooldown wide — at the 10-minute default it is the old floor(now / 600000)", async () => {
  const { earn, seen } = earnWith([stateRow()]);
  await earn.earnMessage("@a:x");
  assert.equal(ledgerRows(seen).find((r) => r.kind === "earn_chat")?.ref, `msg:@a:x:${STREAM}:${Math.floor(T0 / 600_000)}`,
    "every existing earn_chat ref was written with this exact bucket");
  await withRates(5, 1, async () => {
    RULES = { ...RULES, messageCooldownMs: 300_000 };
    const { earn: e2, seen: s2 } = earnWith([stateRow()]);
    await e2.earnMessage("@a:x");
    assert.equal(ledgerRows(s2).find((r) => r.kind === "earn_chat")?.ref, `msg:@a:x:${STREAM}:${Math.floor(T0 / 300_000)}`,
      "a 5-minute cooldown buckets by 5 minutes, so two paid messages can never share a ref");
  });
});

test("the watch cap and the capped flag follow the rules", async () => {
  await withRates(5, 1, async () => {
    RULES = { ...RULES, watchCap: 3 };
    const { earn } = earnWith([beatState(60, { watch_points: 2, watch_seconds: 5_000 })]);
    const r = await earn.recordWatchHeartbeat("@a:x");
    assert.equal(r.awarded, 1);
    assert.equal(r.watchPoints, 3);
    assert.equal(r.capped, true);
  });
});
