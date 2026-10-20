// Behavior — the Matrix ignore list follows the hidden list.
// Only ids the SITE added are ever removed: someone the viewer ignored in Element
// themselves stays ignored when they are unhidden here.
// Run: node --test app/lib/hiddenIgnoreSync.test.ts
import "./legacyNamespace.setup.test.ts"; // first: this suite pins read-both (a legacy prefix is set)
import test from "node:test";
import assert from "node:assert/strict";
import { syncHiddenToIgnore } from "./hiddenIgnoreSync.ts";

function stub(ignored: string[], added: string[] = []) {
  const s = { ignored: [...ignored], data: { added: [...added] } as Record<string, unknown>, writes: 0 };
  return {
    s,
    client: {
      getIgnoredUsers: () => s.ignored,
      setIgnoredUsers: async (ids: string[]) => { s.ignored = ids; s.writes++; },
      getAccountData: () => ({ getContent: () => s.data }),
      setAccountData: async (_t: string, c: Record<string, unknown>) => { s.data = c; },
    },
  };
}

test("a hidden site account is ignored and recorded as the site's", async () => {
  const { s, client } = stub(["@bot:x"]);
  await syncHiddenToIgnore(client, ["@bob:x"]);
  assert.deepEqual(s.ignored.sort(), ["@bob:x", "@bot:x"]);
  assert.deepEqual(s.data.added, ["@bob:x"]);
});

test("unhiding removes only what the site added", async () => {
  const { s, client } = stub(["@bob:x", "@own:x"], ["@bob:x"]);
  await syncHiddenToIgnore(client, []);
  assert.deepEqual(s.ignored, ["@own:x"]);
  assert.deepEqual(s.data.added, []);
});

test("someone already ignored in Element is not claimed, so unhiding leaves them ignored", async () => {
  const { s, client } = stub(["@own:x"]);
  await syncHiddenToIgnore(client, ["@own:x"]);
  assert.deepEqual(s.data.added, []);
  await syncHiddenToIgnore(client, []);
  assert.deepEqual(s.ignored, ["@own:x"]);
});

test("nothing to change = no write", async () => {
  const { s, client } = stub(["@bob:x"], ["@bob:x"]);
  await syncHiddenToIgnore(client, ["@bob:x"]);
  assert.equal(s.writes, 0);
});

test("two syncs in a row both land (writes are queued, never interleaved)", async () => {
  const { s: st, client } = stub([]);
  // A slow write: without the queue, the second sync reads the list before the first writes it.
  const slow = { ...client, setIgnoredUsers: async (ids: string[]) => { await new Promise((r) => setTimeout(r, 20)); st.ignored = ids; } };
  await Promise.all([syncHiddenToIgnore(slow, ["@a:x"]), syncHiddenToIgnore(slow, ["@a:x", "@b:x"])]);
  assert.deepEqual([...st.ignored].sort(), ["@a:x", "@b:x"]);
});

// ── Read both names, write the product name: the product record is read first, writes go to it ──
function typed(ignored: string[], data: Record<string, Record<string, unknown>>) {
  const s = { ignored: [...ignored], data, sets: [] as string[] };
  return {
    s,
    client: {
      getIgnoredUsers: () => s.ignored,
      setIgnoredUsers: async (ids: string[]) => { s.ignored = ids; },
      getAccountData: (t: string) => (s.data[t] ? { getContent: () => s.data[t]! } : undefined),
      setAccountData: async (t: string, c: Record<string, unknown>) => { s.data[t] = c; s.sets.push(t); },
    },
  };
}

test("read-both: unhiding removes an id the site recorded under the PRODUCT name", async () => {
  const { s, client } = typed(["@bob:x", "@own:x"], { "app.blackbranch.hidden_people": { added: ["@bob:x"] } });
  await syncHiddenToIgnore(client, []);
  assert.deepEqual(s.ignored, ["@own:x"]);
  assert.deepEqual(s.sets, ["app.blackbranch.hidden_people"], "write-new: the write goes to the product name");
});

test("read-both: with no product record, the legacy record is the one read", async () => {
  const { s, client } = typed(["@bob:x", "@own:x"], { "net.prior.hidden_people": { added: ["@bob:x"] } });
  await syncHiddenToIgnore(client, []);
  assert.deepEqual(s.ignored, ["@own:x"]);
  assert.deepEqual(s.data["app.blackbranch.hidden_people"], { added: [] }, "write-new: the update lands on the product name");
  assert.deepEqual(s.data["net.prior.hidden_people"], { added: ["@bob:x"] }, "the legacy record is kept, never rewritten");
});
