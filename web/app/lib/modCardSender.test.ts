// A tip card that wears no account (ADR 0145) carries no id a moderator's tools could act on. A
// moderator still reaches the tipper: the chat asks /api/mod/identity/resolve for `card:<row id>`
// (moderators only — the route's requireMod), and this resolves it from the card's own row.
//
// Run: node --test app/lib/modCardSender.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { resolveCardSenders, type CardSenderQuery } from "./modCardSender.ts";
import { cardSenderKey, parseCardSenderKey } from "./modCardKey.ts";
import { modLookupKey } from "./modIdentity.ts";

const answering = (rows: { id: string; matrix_id: string; canonical: string | null }[], seen: { sql: string; params: unknown[] }[] = []): CardSenderQuery =>
  async (sql, params) => { seen.push({ sql, params }); return { rows }; };

test("the key round-trips and refuses anything that is not a positive row id", () => {
  assert.equal(cardSenderKey(42), "card:42");
  assert.equal(parseCardSenderKey("card:42"), 42);
  for (const bad of ["card:0", "card:-1", "card:1.5", "card:abc", "42", "card:", "card:99999999999999999999"]) {
    assert.equal(parseCardSenderKey(bad), null, bad);
  }
});

test("a moderator's read resolves a plain tip card's sender from its row", async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  const out = await resolveCardSenders(["card:42", "card:7", "not-a-card"], answering([{ id: "42", matrix_id: "@casey:site.test", canonical: "c0ffee" }], seen));
  assert.deepEqual(out, { "card:42": { canonicalId: "c0ffee", matrixId: "@casey:site.test" } });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.params, [[42, 7]]);
  // Tips only, and only rows with an account: an anonymous tip's row has none and stays unresolvable.
  assert.match(seen[0]!.sql, /FROM site\.chat_messages m\s+WHERE m\.id = ANY\(\$1::bigint\[\]\) AND m\.event_kind = 'donation' AND m\.matrix_id IS NOT NULL/);
});

test("no card keys asks nothing; a failing read resolves nothing and never throws", async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  assert.deepEqual(await resolveCardSenders(["pid-1"], answering([], seen)), {});
  assert.equal(seen.length, 0);
  const failing: CardSenderQuery = async () => { throw new Error("pool down"); };
  assert.deepEqual(await resolveCardSenders(["card:1"], failing), {});
});

test("a moderator's chat asks for a plain tip card by its row; a line with a public id or an account card does not", () => {
  assert.equal(modLookupKey({ system: "donation", matrixId: null, id: 42 }), "card:42");
  assert.equal(modLookupKey({ system: "donation", matrixId: "@casey:site.test", id: 42 }), null, "an account card already carries its sender");
  assert.equal(modLookupKey({ system: "donation", matrixId: null, id: "d123-1" }), null, "an unpersisted card has no row");
  assert.equal(modLookupKey({ publicId: "pid-1", id: 3 }), "pid-1");
  assert.equal(modLookupKey({ system: "sub", matrixId: null, id: 9 }), null);
});
