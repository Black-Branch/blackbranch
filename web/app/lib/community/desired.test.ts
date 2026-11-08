// The community's desired state, the pure half: order keys and the room validator.
// The database half (readDesired against real Postgres) is desired.db.test.ts.
// Run: env -u DATABASE_URL node --test app/lib/community/desired.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderKeyBetween, validateRoomInput } from "./desired.ts";

// m.space.child `order`: printable ASCII (0x20–0x7E), at most 50 characters, compared by code point.
const ORDER_RE = /^[\x20-\x7E]{1,50}$/;
const lt = (a: string, b: string) => a < b; // JS `<` on ASCII strings is code-point order

test("orderKeyBetween: the first key of an empty list is a0", () => {
  assert.equal(orderKeyBetween(null, null), "a0");
});

test("orderKeyBetween: a key after the last one sorts after it", () => {
  const k = orderKeyBetween("a0", null);
  assert.match(k, ORDER_RE);
  assert.ok(lt("a0", k), `${k} does not sort after a0`);
});

test("orderKeyBetween: a key before the first one sorts before it", () => {
  const k = orderKeyBetween(null, "a0");
  assert.match(k, ORDER_RE);
  assert.ok(lt(k, "a0"), `${k} does not sort before a0`);
});

test("orderKeyBetween: a key between two neighbours sorts strictly between them", () => {
  const k = orderKeyBetween("a0", "a5");
  assert.match(k, ORDER_RE);
  assert.ok(lt("a0", k) && lt(k, "a5"), `${k} is not strictly between a0 and a5`);
});

test("orderKeyBetween: two inserts into the same gap give two distinct keys, both in order", () => {
  const first = orderKeyBetween("a0", "a1");
  const second = orderKeyBetween("a0", first);
  const third = orderKeyBetween(first, "a1");
  assert.equal(new Set([first, second, third]).size, 3);
  assert.deepEqual([second, first, third].map((k) => ORDER_RE.test(k)), [true, true, true]);
  assert.ok(lt("a0", second) && lt(second, first) && lt(first, third) && lt(third, "a1"),
    `order broken: a0 ${second} ${first} ${third} a1`);
});

test("orderKeyBetween: a long run of appends and of same-gap inserts stays within 50 characters", () => {
  // Appends are the import's shape (hundreds of channels in a row); same-gap inserts are the worst
  // case, a drag that always lands in the same place.
  let last = orderKeyBetween(null, null);
  for (let i = 0; i < 1000; i++) {
    const next = orderKeyBetween(last, null);
    assert.ok(lt(last, next) && ORDER_RE.test(next), `append ${i}: ${next}`);
    last = next;
  }
  assert.ok(last.startsWith("b"), `1000 appends never carried into a two-digit integer: ${last}`);
  let first = orderKeyBetween(null, null);
  for (let i = 0; i < 1000; i++) {
    const prev = orderKeyBetween(null, first);
    assert.ok(lt(prev, first) && ORDER_RE.test(prev), `prepend ${i}: ${prev}`);
    first = prev;
  }
  assert.ok(first.startsWith("Y"), `1000 prepends never carried into a two-digit negative: ${first}`);
  let hi = "a1";
  for (let i = 0; i < 40; i++) {
    const next = orderKeyBetween("a0", hi);
    assert.ok(lt("a0", next) && lt(next, hi) && ORDER_RE.test(next), `insert ${i}: ${next}`);
    hi = next;
  }
});

test("orderKeyBetween: refuses neighbours out of order or not of its own scheme", () => {
  assert.throws(() => orderKeyBetween("a5", "a0"));
  assert.throws(() => orderKeyBetween("a0", "a0"));
  assert.throws(() => orderKeyBetween("not a key", null));
});

const valid = {
  id: 7,
  spaceId: 1,
  kind: "text",
  name: "general",
  topic: null,
  avatarMxc: null,
  orderKey: "a0",
  see: "everyone",
  post: "everyone",
  retentionDays: 30,
  encrypted: false,
  published: true,
  archived: false,
  matrixRoomId: null,
  discordChannelId: null,
};

test("validateRoomInput: accepts a valid row and returns it", () => {
  assert.deepEqual(validateRoomInput(valid), valid);
});

test("validateRoomInput: accepts a mods-only, encrypted, unpublished channel with no retention limit", () => {
  const row = { ...valid, see: "mods", post: "mods", encrypted: true, published: false, retentionDays: null };
  assert.deepEqual(validateRoomInput(row), row);
});

test("validateRoomInput: a channel everyone can see cannot be encrypted", () => {
  assert.deepEqual(validateRoomInput({ ...valid, encrypted: true }), {
    error: "A channel everyone can see cannot be encrypted.",
  });
});

test("validateRoomInput: only a channel everyone can see can be published", () => {
  for (const see of ["supporters", "mods", "staff", "invited"]) {
    const r = validateRoomInput({ ...valid, see, published: true });
    assert.ok("error" in r, `published with see=${see} was accepted`);
  }
});

test("validateRoomInput: a name is 1 to 100 characters with no control characters", () => {
  assert.ok("error" in validateRoomInput({ ...valid, name: "x".repeat(101) }), "a 101-character name was accepted");
  assert.ok(!("error" in validateRoomInput({ ...valid, name: "x".repeat(100) })), "a 100-character name was refused");
  assert.ok("error" in validateRoomInput({ ...valid, name: "" }));
  assert.ok("error" in validateRoomInput({ ...valid, name: "bad\nname" }));
  assert.ok("error" in validateRoomInput({ ...valid, name: "bad\u0007name" }));
});

test("validateRoomInput: retention is null or whole days from 1 to the cap", () => {
  assert.ok("error" in validateRoomInput({ ...valid, retentionDays: 0 }));
  assert.ok("error" in validateRoomInput({ ...valid, retentionDays: 1.5 }));
  assert.ok("error" in validateRoomInput({ ...valid, retentionDays: 366 }), "the default cap is one year");
  assert.ok(!("error" in validateRoomInput({ ...valid, retentionDays: 365 })));
  assert.ok(!("error" in validateRoomInput({ ...valid, retentionDays: 3650 }, { retentionCapDays: null })),
    "with the cap off, the database's ten-year ceiling is the limit");
  assert.ok("error" in validateRoomInput({ ...valid, retentionDays: 3651 }, { retentionCapDays: null }));
});

test("validateRoomInput: refuses unknown rules and kinds, and anything that is not a room", () => {
  assert.ok("error" in validateRoomInput({ ...valid, see: "nobody" }));
  assert.ok("error" in validateRoomInput({ ...valid, post: "invited" }), "invited is a see rule, not a post rule");
  assert.ok("error" in validateRoomInput({ ...valid, kind: "voice" }));
  assert.ok("error" in validateRoomInput({ ...valid, orderKey: "not a key" }));
  assert.ok("error" in validateRoomInput({ ...valid, avatarMxc: "https://example.test/a.png" }));
  assert.ok("error" in validateRoomInput(null));
  assert.ok("error" in validateRoomInput("general"));
  const noName: Record<string, unknown> = { ...valid };
  delete noName.name;
  assert.ok("error" in validateRoomInput(noName));
});
