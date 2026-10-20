// The account's m.ignored_user_list gains every bridged bot once per client
// start. Synapse then drops those senders from /sync and from unread counts for
// every client on the account. The write must be idempotent, additive and
// skipped when nothing is new.
//
// Run: node --test app/lib/ignoredBots.test.ts

import "./testInstallValues.ts";
import "./legacyNamespace.setup.test.ts"; // next: this suite pins read-both (a legacy prefix is set)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { syncIgnoredBots, withIgnoreListLock, type IgnoreClient } from "./ignoredBots.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — a truncated read makes every negative assertion below vacuous`);
  return stripComments(src);
}

const FIXTWEET = "@discord_1164651057243238400:example.tv";
const HUMAN_GHOST = "@discord_100000000000000001:example.tv";

// Write-new: the site's record is written under the product name; the legacy one is only read.
const ADDED_TYPE = "app.blackbranch.ignored_bots";
const LEGACY_ADDED_TYPE = "net.prior.ignored_bots";
const HIDDEN_TYPE = "app.blackbranch.hidden_people";
const LEGACY_HIDDEN_TYPE = "net.prior.hidden_people";

type Member = { userId: string; rawDisplayName: string };
function fake(
  rooms: Array<{ membership: string; members: Member[] }>,
  ignored: string[],
  accountData: Record<string, Record<string, unknown>> = {},
) {
  const writes: string[][] = [];
  const loads: string[] = [];
  const sets: Array<[string, Record<string, unknown>]> = [];
  const client: IgnoreClient = {
    getRooms: () => rooms.map((r) => ({
      getMyMembership: () => r.membership,
      loadMembersIfNeeded: async () => { loads.push(r.membership); },
      getJoinedMembers: () => r.members,
    })),
    getIgnoredUsers: () => ignored,
    setIgnoredUsers: async (ids) => { writes.push(ids); return {}; },
    getAccountData: (type) => {
      const content = accountData[type];
      return content ? { getContent: () => content } : undefined;
    },
    setAccountData: async (type, content) => { sets.push([type, content]); accountData[type] = content; return {}; },
  };
  return { client, writes, loads, sets };
}

test("adds the bot ghost, keeps what the user already ignored", async () => {
  const { client, writes } = fake(
    [{ membership: "join", members: [{ userId: FIXTWEET, rawDisplayName: "FixTweet (bot) (Discord)" }, { userId: HUMAN_GHOST, rawDisplayName: "Casey (Discord)" }, { userId: "@k:example.tv", rawDisplayName: "k" }] }],
    ["@spammer:example.org"],
  );
  assert.deepEqual(await syncIgnoredBots(client), [FIXTWEET]);
  assert.deepEqual(writes, [["@spammer:example.org", FIXTWEET]]);
});

test("writes nothing when the bot is already ignored", async () => {
  const { client, writes } = fake([{ membership: "join", members: [{ userId: FIXTWEET, rawDisplayName: "FixTweet (bot) (Discord)" }] }], [FIXTWEET]);
  assert.deepEqual(await syncIgnoredBots(client), []);
  assert.deepEqual(writes, []);
});

test("writes nothing when there are no bots; never removes an entry", async () => {
  const { client, writes } = fake([{ membership: "join", members: [{ userId: HUMAN_GHOST, rawDisplayName: "Casey (Discord)" }] }], ["@spammer:example.org"]);
  assert.deepEqual(await syncIgnoredBots(client), []);
  assert.deepEqual(writes, []);
});

test("a room the user left does not count; the same bot in two rooms is written once", async () => {
  const bot = { userId: FIXTWEET, rawDisplayName: "FixTweet (bot) (Discord)" };
  const { client, writes } = fake(
    [{ membership: "leave", members: [{ userId: "@discord_5:example.tv", rawDisplayName: "Old (bot) (Discord)" }] }, { membership: "join", members: [bot] }, { membership: "join", members: [bot] }],
    [],
  );
  assert.deepEqual(await syncIgnoredBots(client), [FIXTWEET]);
  assert.deepEqual(writes, [[FIXTWEET]]);
});

test("the client context syncs once, inside the first-PREPARED branch, and the timeline hides ignored senders", () => {
  const ctx = read("app/lib/MatrixClientContext.tsx", /<\/Ctx\.Provider>\s*\);\s*}\s*$/);
  assert.match(ctx, /if \(!prepared\) \{[^}]*syncIgnoredBots\(mxClient, \(\) => !stale\(\)\)\.catch\(/, "runs exactly where the boot timer is disarmed, so once per client start, guarded against a stale run");
  assert.equal((ctx.match(/syncIgnoredBots\(/g) ?? []).length, 1);
  const rows = read("app/lib/timelineRows.ts", /return true;\s*}\s*$/);
  assert.match(rows, /if \(isIgnoredSender\(room, e\)\) return false;/, "the store keeps events that arrived before the list was written");
  const tl = read("app/features/community/Timeline.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(tl, /all\.filter\(\(e\) => isTimelineRow\(room, e, \{ deleted: showDeleted \}\)\)/, "the timeline and the pinned panel's jump share one renderability rule");
  assert.doesNotMatch(tl, /isRedacted\(\)/, "the filter lives in one place — timelineRows.ts, not a Timeline copy");
  assert.doesNotMatch(tl, /rel_type === "m\.thread"/, "the filter lives in one place — timelineRows.ts, not a Timeline copy");
});

test("members are loaded for every joined room before the scan, never for a left room", async () => {
  const { client, loads } = fake(
    [{ membership: "leave", members: [] }, { membership: "join", members: [] }, { membership: "join", members: [] }],
    [],
  );
  await syncIgnoredBots(client);
  assert.deepEqual(loads, ["join", "join"]);
});

test("a bot the site already added once is not re-added after the user un-ignored it elsewhere", async () => {
  const { client, writes, sets } = fake(
    [{ membership: "join", members: [{ userId: FIXTWEET, rawDisplayName: "FixTweet (bot) (Discord)" }] }],
    [],
    { [ADDED_TYPE]: { added: [FIXTWEET] } },
  );
  assert.deepEqual(await syncIgnoredBots(client), []);
  assert.deepEqual(writes, []);
  assert.deepEqual(sets, []);
});

test("the first add records the id in account data", async () => {
  const { client, writes, sets } = fake(
    [{ membership: "join", members: [{ userId: FIXTWEET, rawDisplayName: "FixTweet (bot) (Discord)" }] }],
    [],
  );
  assert.deepEqual(await syncIgnoredBots(client), [FIXTWEET]);
  assert.deepEqual(writes, [[FIXTWEET]]);
  assert.deepEqual(sets, [[ADDED_TYPE, { added: [FIXTWEET] }]]);
});

test("no write when the client went stale during the member load", async () => {
  const { client, writes, sets } = fake(
    [{ membership: "join", members: [{ userId: FIXTWEET, rawDisplayName: "FixTweet (bot) (Discord)" }] }],
    [],
  );
  assert.deepEqual(await syncIgnoredBots(client, () => false), []);
  assert.deepEqual(writes, []);
  assert.deepEqual(sets, []);
});

// Vacuity anchor at the END: the sync discriminates on the marker, not on ghost-ness.
test("a human ghost and a bot ghost are told apart", async () => {
  const a = fake([{ membership: "join", members: [{ userId: FIXTWEET, rawDisplayName: "FixTweet (bot) (Discord)" }] }], []);
  const b = fake([{ membership: "join", members: [{ userId: HUMAN_GHOST, rawDisplayName: "Casey (Discord)" }] }], []);
  assert.notDeepEqual(await syncIgnoredBots(a.client), await syncIgnoredBots(b.client));
});

// ── Read both names: the site's record under the product name is read first ─────────────────────
test("read-both: an id recorded under the PRODUCT name is not re-added; the write goes to the product name", async () => {
  const OTHER = "@discord_1111111111111111111:example.tv";
  const { client, sets } = fake(
    [{ membership: "join", members: [
      { userId: FIXTWEET, rawDisplayName: "FixTweet (bot) (Discord)" },
      { userId: OTHER, rawDisplayName: "Other (bot) (Discord)" },
    ] }],
    [],
    { [ADDED_TYPE]: { added: [FIXTWEET] }, [LEGACY_ADDED_TYPE]: { added: [] } },
  );
  assert.deepEqual(await syncIgnoredBots(client), [OTHER]);
  assert.deepEqual(sets, [[ADDED_TYPE, { added: [FIXTWEET, OTHER] }]]);
});

test("read-both: a product record without an `added` list is no record — the legacy one is read (and copied forward)", async () => {
  const { client, writes, sets } = fake(
    [{ membership: "join", members: [{ userId: FIXTWEET, rawDisplayName: "FixTweet (bot) (Discord)" }] }],
    [],
    { [ADDED_TYPE]: {}, [LEGACY_ADDED_TYPE]: { added: [FIXTWEET] } },
  );
  assert.deepEqual(await syncIgnoredBots(client), [], "the legacy record still stops a re-add");
  assert.deepEqual(writes, []);
  assert.deepEqual(sets, [[ADDED_TYPE, { added: [FIXTWEET] }]], "the only write is the lazy copy");
});

// ── Write the product name: the account-data lazy copy — on client start, in the ignore-list queue ──
test("lazy copy: a legacy-only record is copied to the product name with the same content; the legacy record is kept", async () => {
  const data: Record<string, Record<string, unknown>> = {
    [LEGACY_ADDED_TYPE]: { added: [FIXTWEET] },
    [LEGACY_HIDDEN_TYPE]: { added: ["@bob:x"] },
  };
  const { client, writes, sets } = fake([], [], data);
  assert.deepEqual(await syncIgnoredBots(client), [], "no bots in any room: the copy runs anyway");
  assert.deepEqual(writes, [], "the ignore list itself is not touched");
  assert.deepEqual(sets.map(([t]) => t).sort(), [ADDED_TYPE, HIDDEN_TYPE].sort());
  assert.deepEqual(data[ADDED_TYPE], { added: [FIXTWEET] });
  assert.deepEqual(data[HIDDEN_TYPE], { added: ["@bob:x"] });
  assert.deepEqual(data[LEGACY_ADDED_TYPE], { added: [FIXTWEET] }, "legacy kept");
  assert.deepEqual(data[LEGACY_HIDDEN_TYPE], { added: ["@bob:x"] }, "legacy kept");
});

test("lazy copy: a product record that already exists is never overwritten — even an empty one", async () => {
  const { client, sets } = fake([], [], {
    [ADDED_TYPE]: { added: [] }, [LEGACY_ADDED_TYPE]: { added: [FIXTWEET] },
    [HIDDEN_TYPE]: { added: ["@a:x"] }, [LEGACY_HIDDEN_TYPE]: { added: ["@b:x"] },
  });
  await syncIgnoredBots(client);
  assert.deepEqual(sets, []);
});

test("lazy copy: nothing under either name = nothing written", async () => {
  const { client, sets } = fake([], []);
  await syncIgnoredBots(client);
  assert.deepEqual(sets, []);
});

test("lazy copy: a client gone stale writes nothing", async () => {
  const { client, sets } = fake([], [], { [LEGACY_ADDED_TYPE]: { added: [FIXTWEET] } });
  await syncIgnoredBots(client, () => false);
  assert.deepEqual(sets, []);
});

test("lazy copy: it waits its turn in the ignore-list queue (never interleaves with a hide sync)", async () => {
  const { client, sets } = fake([], [], { [LEGACY_HIDDEN_TYPE]: { added: ["@b:x"] } });
  let release!: () => void;
  const held = withIgnoreListLock(() => new Promise<void>((r) => { release = r; }));
  const run = syncIgnoredBots(client);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sets, [], "nothing written while another ignore-list writer holds the queue");
  release();
  await held;
  await run;
  assert.deepEqual(sets, [[HIDDEN_TYPE, { added: ["@b:x"] }]]);
});
